/**
 * The proxy hosts list, a host's page, the list's bulk actions and
 * GET /api/v1/proxy-hosts/{id}/health, with a real database, the real
 * permission guards (mocked session or real API tokens) and Caddy's admin API
 * mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { apiRequest, idParams, insertRole, insertToken, insertUser, json, nowIso } from '../helpers/custom-roles';
import { insertPolicy } from '../helpers/approvals';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb, sessionUserId: 0 }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('@/src/lib/auth', async (importOriginal) => importOriginal());
vi.mock('@/src/lib/auth-server', () => ({
  getAuth: () => ({
    api: { getSession: async () => ({ user: { id: ctx.sessionUserId }, session: { id: 1, createdAt: new Date() } }) },
  }),
  reloadOAuthProviders: async () => {},
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); },
  notFound: () => { throw new Error('NOT_FOUND'); },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/src/lib/caddy-upstreams', () => ({ fetchCaddyUpstreams: vi.fn() }));

import ProxyHostsPage from '@/app/(dashboard)/proxy-hosts/page';
import ProxyHostPage from '@/app/(dashboard)/proxy-hosts/[id]/page';
import { bulkProxyHostsAction } from '@/app/(dashboard)/proxy-hosts/bulk-actions';
import * as healthRoute from '@/app/api/v1/proxy-hosts/[id]/health/route';
import { applyCaddyConfig } from '@/src/lib/caddy';
import { logAuditEvent } from '@/src/lib/audit';
import { fetchCaddyUpstreams } from '@/src/lib/caddy-upstreams';
import { deferCaddyApplyToBatch, inChangeBatch } from '@/src/lib/change-batch';
import type { HostListRow } from '@/src/lib/proxy-host-view';
import type { HostDetail } from '@/src/lib/proxy-host-detail';
import { first } from '@/src/lib/db/ops';

const ADMIN = 1;
const TEAM_A = 2; // read and write, scoped to team-a
const READER = 3; // read only
const NOBODY = 4; // no permissions

let hosts: { a: number; b: number; c: number };
let tokens: { admin: string; teamA: string; reader: string; nobody: string };
/** Applies that reached Caddy: like the real applyCaddyConfig, the mock defers inside a change batch. */
const caddyApplies = vi.fn();
/** Audit events recorded: like the real logAuditEvent, the mock records nothing inside a change batch. */
const audited: Array<Parameters<typeof logAuditEvent>[0]> = [];

async function host(name: string, domains: string[], tags: string[], extra: Partial<typeof schema.proxyHosts.$inferInsert> = {}) {
  const now = nowIso();
  return (await first(ctx.db.insert(schema.proxyHosts).values({
    name, domains: JSON.stringify(domains), upstreams: '["http://backend:8080"]', tags: JSON.stringify(tags), createdAt: now, updatedAt: now, ...extra,
  }).returning()))!.id;
}

async function hostRow(id: number) {
  return await first(ctx.db.select().from(schema.proxyHosts).where(eq(schema.proxyHosts.id, id)).limit(1));
}

type ListProps = {
  hosts: Array<{ id: number; name: string }>;
  rows: HostListRow[];
  totalHosts: number;
  statusCounts: Record<string, number>;
  analyticsStatus: string | null;
  availableTags: string[];
  editTarget: { id: number } | null;
  pagination: { total: number };
};

async function listPage(params: Record<string, string | string[]> = {}): Promise<ListProps> {
  const page = (await ProxyHostsPage({ searchParams: Promise.resolve(params) })) as { props: ListProps };
  return page.props;
}

async function detailPage(id: number | string): Promise<{ detail: HostDetail; can: Record<string, boolean> }> {
  const page = (await ProxyHostPage({ params: Promise.resolve({ id: String(id) }) })) as { props: { detail: HostDetail; can: Record<string, boolean> } };
  return page.props;
}

beforeEach(async () => {
  ctx.db = createTestDb();
  vi.clearAllMocks();
  vi.mocked(applyCaddyConfig).mockImplementation(async () => {
    if (deferCaddyApplyToBatch()) return;
    caddyApplies();
  });
  audited.length = 0;
  vi.mocked(logAuditEvent).mockImplementation(async (event) => {
    if (!inChangeBatch()) audited.push(event);
  });
  vi.mocked(fetchCaddyUpstreams).mockResolvedValue([{ address: 'backend:8080', numRequests: 1, fails: 0 }]);
  await insertRole(ctx.db, 1, ['proxy_hosts:read', 'proxy_hosts:write'], ['team-a'], 'Team A');
  await insertRole(ctx.db, 2, ['proxy_hosts:read'], [], 'Readers');
  await insertUser(ctx.db, ADMIN, 'admin');
  await insertUser(ctx.db, TEAM_A, 'viewer', 1);
  await insertUser(ctx.db, READER, 'viewer', 2);
  await insertUser(ctx.db, NOBODY, 'viewer');
  tokens = { admin: await insertToken(ctx.db, ADMIN), teamA: await insertToken(ctx.db, TEAM_A), reader: await insertToken(ctx.db, READER), nobody: await insertToken(ctx.db, NOBODY) };
  hosts = {
    a: await host('Alpha', ['a.example.com'], ['team-a', 'web']),
    b: await host('Bravo', ['b.example.com', 'www.b.example.com'], ['team-b']),
    c: await host('Charlie', ['c.example.com'], ['team-a'], { enabled: false, meta: JSON.stringify({ waf: { enabled: true, mode: 'On', waf_mode: 'merge' } }) }),
  };
  ctx.sessionUserId = ADMIN;
});


describe('proxy hosts list', () => {
  it('shows every host with its status, protections and counts', async () => {
    const props = await listPage();
    expect(props.totalHosts).toBe(3);
    expect(props.statusCounts).toEqual({ all: 3, attention: 0, disabled: 1 });
    expect(props.availableTags).toEqual(['team-a', 'team-b', 'web']);
    // Analytics is not configured in the tests: the columns know it.
    expect(props.analyticsStatus).toBe('disabled');
    const charlie = props.rows.find((row) => row.id === hosts.c)!;
    expect(charlie).toMatchObject({ state: 'disabled', wafMode: 'block' });
    expect(charlie.protections.map((p) => p.label)).toEqual(['WAF · Block']);
    // Without traffic, the busiest-first default falls back to the host name.
    expect(props.rows.map((row) => row.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(props.hosts.map((h) => h.id)).toEqual(props.rows.map((row) => row.id));
  });

  it('filters by search, status, protection and tag, and sorts', async () => {
    expect((await listPage({ search: 'www.b' })).rows.map((row) => row.name)).toEqual(['Bravo']);
    expect((await listPage({ search: 'backend:8080' })).rows).toHaveLength(3);
    const disabled = await listPage({ status: 'disabled' });
    expect(disabled.rows.map((row) => row.name)).toEqual(['Charlie']);
    expect(disabled.pagination.total).toBe(1);
    expect((await listPage({ protection: 'waf_block' })).rows.map((row) => row.name)).toEqual(['Charlie']);
    expect((await listPage({ protection: 'none' })).rows.map((row) => row.name)).toEqual(['Alpha', 'Bravo']);
    expect((await listPage({ tag: ['web', 'team-b'] })).rows.map((row) => row.name)).toEqual(['Alpha', 'Bravo']);
    expect((await listPage({ sortBy: 'host', sortDir: 'desc' })).rows.map((row) => row.name)).toEqual(['Charlie', 'Bravo', 'Alpha']);
    // Counts follow the search, not the status filter.
    expect((await listPage({ search: 'charlie', status: 'attention' })).statusCounts).toEqual({ all: 1, attention: 0, disabled: 1 });
  });

  it('uses the saved sort when the URL does not specify one, while explicit URL sorting wins', async () => {
    await ctx.db.insert(schema.userPreferences).values({
      userId: ADMIN,
      proxyHostsSort: 'host:desc',
      updatedAt: nowIso(),
    });

    expect((await listPage()).rows.map((row) => row.name)).toEqual(['Charlie', 'Bravo', 'Alpha']);
    expect((await listPage({ sortBy: 'host', sortDir: 'asc' })).rows.map((row) => row.name))
      .toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('limits a scoped role to its hosts and hides what it may not read', async () => {
    ctx.sessionUserId = TEAM_A;
    const props = await listPage();
    expect(props.rows.map((row) => row.name).sort()).toEqual(['Alpha', 'Charlie']);
    expect(props.availableTags).toEqual(['team-a', 'web']);
    // No analytics:read and no certificates:read.
    expect(props.analyticsStatus).toBeNull();
    expect(props.rows.every((row) => row.traffic === null && row.certificate.visible === false)).toBe(true);
  });

  it('opens the edit dialog only for a host the user may change', async () => {
    expect((await listPage({ edit: String(hosts.b) })).editTarget?.id).toBe(hosts.b);
    ctx.sessionUserId = TEAM_A;
    expect((await listPage({ edit: String(hosts.b) })).editTarget).toBeNull();
    expect((await listPage({ edit: String(hosts.a) })).editTarget?.id).toBe(hosts.a);
    ctx.sessionUserId = READER;
    expect((await listPage({ edit: String(hosts.a) })).editTarget).toBeNull();
  });

  it('marks hosts with a change waiting for approval', async () => {
    const now = nowIso();
    await ctx.db.insert(schema.changeRequests).values({
      targetType: 'proxy_host', targetId: hosts.a, targetName: 'Alpha', operation: 'update', input: '{}', status: 'pending',
      requestedBy: ADMIN, expiresAt: '2099-01-01T00:00:00.000Z', createdAt: now, updatedAt: now,
    });
    const alpha = (await listPage()).rows.find((row) => row.id === hosts.a)!;
    expect(alpha).toMatchObject({ state: 'pending', pendingChangeRequestId: expect.any(Number) });
  });

  it('refuses users without proxy_hosts:read', async () => {
    ctx.sessionUserId = NOBODY;
    await expect(listPage()).rejects.toThrow();
  });
});

describe('host page', () => {
  it('shows the host with its configuration, upstream health and changes', async () => {
    await ctx.db.insert(schema.auditEvents).values([
      { userId: ADMIN, action: 'create', entityType: 'proxy_host', entityId: hosts.a, summary: 'Created proxy host Alpha', createdAt: '2026-06-03T10:00:00.000Z' },
      { userId: ADMIN, action: 'update', entityType: 'proxy_host', entityId: hosts.a, summary: 'Updated proxy host Alpha', createdAt: '2026-09-29T10:00:00.000Z' },
      { userId: ADMIN, action: 'update', entityType: 'proxy_host', entityId: hosts.b, summary: 'Updated proxy host Bravo', createdAt: '2026-09-30T10:00:00.000Z' },
    ]);
    const { detail, can } = await detailPage(hosts.a);
    expect(detail.row).toMatchObject({ id: hosts.a, name: 'Alpha', state: 'healthy' });
    expect(detail.config.map((entry) => entry.section)).toEqual(['routing', 'security', 'access', 'certificate', 'headers']);
    expect(detail.health).toMatchObject({ caddyReachable: true, status: 'unchecked' });
    expect(detail.health.upstreams[0]).toMatchObject({ dial: 'backend:8080', reported: true, requestsInFlight: 1 });
    expect(detail.changes?.total).toBe(2);
    expect(detail.changes?.entries.map((entry) => entry.summary)).toEqual(['Updated proxy host Alpha', 'Created proxy host Alpha']);
    expect(detail.changes?.entries[0]).toMatchObject({ actor: 'User 1', fields: null, rollbackVersionId: null });
    expect(detail.traffic?.status).toBe('disabled');
    expect(can).toMatchObject({ write: true, analytics: true, auditLog: true });
  });

  it('answers 404 outside the scope and for unknown hosts', async () => {
    ctx.sessionUserId = TEAM_A;
    await expect(detailPage(hosts.b)).rejects.toThrow('NOT_FOUND');
    expect((await detailPage(hosts.a)).detail.row.id).toBe(hosts.a);
    await expect(detailPage(9999)).rejects.toThrow('NOT_FOUND');
    await expect(detailPage('1;drop')).rejects.toThrow('NOT_FOUND');
  });

  it('leaves out what the reader may not read', async () => {
    ctx.sessionUserId = READER;
    const { detail, can } = await detailPage(hosts.b);
    expect(detail.traffic).toBeNull();
    expect(detail.changes).toBeNull();
    expect(detail.errorRateAlert).toBeNull();
    expect(can).toMatchObject({ write: false, analytics: false, auditLog: false, alerts: false });
  });

  it('shows the upstreams as unknown when Caddy does not answer', async () => {
    vi.mocked(fetchCaddyUpstreams).mockRejectedValue(new Error('ECONNREFUSED'));
    const { detail } = await detailPage(hosts.a);
    expect(detail.health).toMatchObject({ caddyReachable: false, status: 'unknown' });
  });
});

describe('GET /api/v1/proxy-hosts/{id}/health', () => {
  it('needs proxy_hosts:read and answers 404 outside the scope', async () => {
    expect((await healthRoute.GET(apiRequest('GET', '/x', tokens.nobody), idParams(hosts.a))).status).toBe(403);
    expect((await healthRoute.GET(apiRequest('GET', '/x', tokens.teamA), idParams(hosts.b))).status).toBe(404);
    expect((await healthRoute.GET(apiRequest('GET', '/x', tokens.admin), idParams(9999))).status).toBe(404);
    expect((await healthRoute.GET(apiRequest('GET', '/x', tokens.admin), idParams('abc'))).status).toBe(404);
  });

  it('reports each upstream from Caddy', async () => {
    vi.mocked(fetchCaddyUpstreams).mockResolvedValue([{ address: 'backend:8080', numRequests: 0, fails: 2 }]);
    const response = await healthRoute.GET(apiRequest('GET', '/x', tokens.teamA), idParams(hosts.a));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await json(response);
    expect(body).toMatchObject({ proxyHostId: hosts.a, caddyReachable: true, status: 'degraded', healthChecks: { active: null, passive: null } });
    expect(body.upstreams).toEqual([
      { upstream: 'http://backend:8080', dial: 'backend:8080', tls: false, status: 'degraded', reported: true, fails: 2, requestsInFlight: 0 },
    ]);
  });
});

describe('bulk actions', () => {
  it('needs proxy_hosts:write', async () => {
    ctx.sessionUserId = READER;
    await expect(bulkProxyHostsAction([hosts.a], { type: 'disable' })).rejects.toThrow(/permission/i);
    expect((await hostRow(hosts.a))!.enabled).toBe(true);
  });

  it('validates its input', async () => {
    expect(await bulkProxyHostsAction('1,2', { type: 'disable' })).toMatchObject({ ok: false, message: 'Choose the hosts first.' });
    expect(await bulkProxyHostsAction([0], { type: 'disable' })).toMatchObject({ ok: false, message: 'Unknown proxy host.' });
    expect(await bulkProxyHostsAction([hosts.a], { type: 'format' })).toMatchObject({ ok: false, message: 'Unknown bulk action.' });
    expect(await bulkProxyHostsAction([hosts.a], { type: 'add_tag', tag: 'bad tag!' })).toMatchObject({ ok: false });
    expect(await bulkProxyHostsAction(Array.from({ length: 101 }, (_, i) => i + 1), { type: 'disable' })).toMatchObject({ ok: false });
    expect(caddyApplies).not.toHaveBeenCalled();
  });

  it('changes the hosts in one apply, with an audit event each', async () => {
    const result = await bulkProxyHostsAction([hosts.a, hosts.b, hosts.c], { type: 'disable' });
    expect(result).toMatchObject({ ok: true, changed: 2, unchanged: 1, submitted: 0 });
    expect([(await hostRow(hosts.a))!.enabled, (await hostRow(hosts.b))!.enabled]).toEqual([false, false]);
    expect(caddyApplies).toHaveBeenCalledTimes(1);
    const events = audited.filter((event) => event.entityType === 'proxy_host');
    expect(events.map((event) => [event.action, event.entityId])).toEqual([['update', hosts.a], ['update', hosts.b]]);
  });

  it('turns WAF blocking on and adds tags', async () => {
    expect(await bulkProxyHostsAction([hosts.a, hosts.c], { type: 'waf_block' })).toMatchObject({ changed: 1, unchanged: 1 });
    expect(JSON.parse((await hostRow(hosts.a))!.meta!).waf).toMatchObject({ enabled: true, mode: 'On' });
    expect(await bulkProxyHostsAction([hosts.a, hosts.b], { type: 'add_tag', tag: ' Prod ' })).toMatchObject({ ok: true, changed: 2 });
    expect(JSON.parse((await hostRow(hosts.b))!.tags)).toEqual(['prod', 'team-b']);
  });

  it('keeps a scoped role inside its scope', async () => {
    ctx.sessionUserId = TEAM_A;
    const result = await bulkProxyHostsAction([hosts.a, hosts.b], { type: 'disable' });
    expect(result).toMatchObject({ ok: false, changed: 1, failed: [{ id: hosts.b, name: null, message: 'Proxy host not found' }] });
    expect((await hostRow(hosts.b))!.enabled).toBe(true);
    const tagged = await bulkProxyHostsAction([hosts.a], { type: 'add_tag', tag: 'team-b' });
    expect(tagged.ok).toBe(false);
    expect(tagged.failed[0].message).toMatch(/your role's tags/);
    expect(JSON.parse((await hostRow(hosts.a))!.tags)).toEqual(['team-a', 'web']);
  });

  it('deletes hosts after the same checks', async () => {
    const result = await bulkProxyHostsAction([hosts.c], { type: 'delete' });
    expect(result).toMatchObject({ ok: true, changed: 1 });
    expect(await hostRow(hosts.c)).toBeUndefined();
    expect(audited).toContainEqual(
      expect.objectContaining({ action: 'delete', entityType: 'proxy_host', entityId: hosts.c })
    );
  });

  it('submits changes to protected hosts for approval instead', async () => {
    await insertPolicy(ctx.db, { name: 'Web', hostTags: '["web"]' });
    const result = await bulkProxyHostsAction([hosts.a, hosts.b], { type: 'disable' });
    expect(result).toMatchObject({ ok: true, changed: 1, submitted: 1 });
    expect((await hostRow(hosts.a))!.enabled).toBe(true);
    expect((await hostRow(hosts.b))!.enabled).toBe(false);
    expect(await ctx.db.select().from(schema.changeRequests)).toMatchObject([{ targetId: hosts.a, status: 'pending' }]);
  });
});
