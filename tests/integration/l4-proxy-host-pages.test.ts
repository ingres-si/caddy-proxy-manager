/**
 * The L4 hosts list (search, filters, counts, sort and pages) and its bulk
 * actions, with a real database, the real permission guards (mocked session)
 * and Caddy's admin API mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { insertRole, insertUser, nowIso } from '../helpers/custom-roles';
import { insertPolicy } from '../helpers/approvals';

const ctx = vi.hoisted(() => {
  const { mkdirSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const dir = join(tmpdir(), `l4-pages-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  process.env.L4_PORTS_DIR = dir;
  return { db: null as unknown as TestDb, sessionUserId: 0 };
});

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

import L4ProxyHostsPage from '@/app/(dashboard)/l4-proxy-hosts/page';
import { bulkL4ProxyHostsAction } from '@/app/(dashboard)/l4-proxy-hosts/bulk-actions';
import { applyCaddyConfig } from '@/src/lib/caddy';
import { logAuditEvent } from '@/src/lib/audit';
import { deferCaddyApplyToBatch, inChangeBatch } from '@/src/lib/change-batch';
import { first } from '@/src/lib/db/ops';

const ADMIN = 1;
const TEAM_A = 2; // read and write, scoped to team-a
const READER = 3; // read only

let hosts: { a: number; b: number; c: number };
/** Applies that reached Caddy: like the real applyCaddyConfig, the mock defers inside a change batch. */
const caddyApplies = vi.fn();
/** Audit events recorded: like the real logAuditEvent, the mock records nothing inside a change batch. */
const audited: Array<Parameters<typeof logAuditEvent>[0]> = [];

async function l4Host(name: string, listenAddress: string, tags: string[], extra: Partial<typeof schema.l4ProxyHosts.$inferInsert> = {}) {
  const now = nowIso();
  return (await first(ctx.db.insert(schema.l4ProxyHosts).values({
    name, protocol: 'tcp', listenAddress, upstreams: '["192.0.2.10:5432"]', tags: JSON.stringify(tags), createdAt: now, updatedAt: now, ...extra,
  }).returning()))!.id;
}

async function l4Row(id: number) {
  return await first(ctx.db.select().from(schema.l4ProxyHosts).where(eq(schema.l4ProxyHosts.id, id)).limit(1));
}

type ListProps = {
  hosts: Array<{ id: number; name: string; protocol: string; enabled: boolean }>;
  totalHosts: number;
  pagination: { total: number; page: number; perPage: number };
  query: { page: number; sortBy: string; sortDir: string };
  protocolCounts: Record<string, number>;
  statusCounts: Record<string, number>;
  showTags: boolean;
  canWrite: boolean;
};

async function listPage(params: Record<string, string | string[]> = {}): Promise<ListProps> {
  const page = (await L4ProxyHostsPage({ searchParams: Promise.resolve(params) })) as { props: ListProps };
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
  await insertRole(ctx.db, 1, ['l4_proxy_hosts:read', 'l4_proxy_hosts:write'], ['team-a'], 'Team A');
  await insertRole(ctx.db, 2, ['l4_proxy_hosts:read'], [], 'Readers');
  await insertUser(ctx.db, ADMIN, 'admin');
  await insertUser(ctx.db, TEAM_A, 'viewer', 1);
  await insertUser(ctx.db, READER, 'viewer', 2);
  hosts = {
    a: await l4Host('Alpha SSH', ':2222', ['team-a', 'prod']),
    b: await l4Host('Bravo DNS', ':853', ['team-b'], { matcherType: 'tls_sni', matcherValue: '["dns.example.com"]' }),
    c: await l4Host('Charlie WireGuard', ':51820', ['team-a'], { protocol: 'udp', enabled: false }),
  };
  ctx.sessionUserId = ADMIN;
});


describe('L4 hosts list', () => {
  it('shows every host with the counts of each filter', async () => {
    const props = await listPage();
    expect(props.totalHosts).toBe(3);
    expect(props.protocolCounts).toEqual({ all: 3, tcp: 2, udp: 1 });
    expect(props.statusCounts).toEqual({ all: 3, enabled: 2, disabled: 1 });
    expect(props.showTags).toBe(true);
    expect(props.canWrite).toBe(true);
    expect(props.pagination).toEqual({ total: 3, page: 1, perPage: 25 });
  });

  it('searches names, ports, upstreams and server names, filters and sorts', async () => {
    expect((await listPage({ search: 'dns.example' })).hosts.map((h) => h.name)).toEqual(['Bravo DNS']);
    expect((await listPage({ search: '51820' })).hosts.map((h) => h.name)).toEqual(['Charlie WireGuard']);
    expect((await listPage({ search: '192.0.2.10' })).hosts).toHaveLength(3);
    expect((await listPage({ protocol: 'udp' })).hosts.map((h) => h.name)).toEqual(['Charlie WireGuard']);
    const enabled = await listPage({ status: 'enabled', sortBy: 'name' });
    expect(enabled.hosts.map((h) => h.name)).toEqual(['Alpha SSH', 'Bravo DNS']);
    expect(enabled.pagination.total).toBe(2);
    // The protocol counts follow the status filter, the status counts the protocol filter.
    expect(enabled.protocolCounts).toEqual({ all: 2, tcp: 2, udp: 0 });
    expect((await listPage({ protocol: 'tcp' })).statusCounts).toEqual({ all: 2, enabled: 2, disabled: 0 });
    expect((await listPage({ sortBy: 'listenAddress' })).hosts.map((h) => h.name)).toEqual(['Bravo DNS', 'Alpha SSH', 'Charlie WireGuard']);
  });

  it('uses the saved sort when the URL does not specify one, while explicit URL sorting wins', async () => {
    await ctx.db.insert(schema.userPreferences).values({
      userId: ADMIN,
      l4ProxyHostsSort: 'name:desc',
      updatedAt: nowIso(),
    });

    expect((await listPage()).hosts.map((host) => host.name)).toEqual(['Charlie WireGuard', 'Bravo DNS', 'Alpha SSH']);
    expect((await listPage({ sortBy: 'name', sortDir: 'asc' })).hosts.map((host) => host.name))
      .toEqual(['Alpha SSH', 'Bravo DNS', 'Charlie WireGuard']);
  });

  it('pages a long list and clamps a page past the end', async () => {
    for (let i = 0; i < 57; i++) await l4Host(`Bulk ${String(i).padStart(2, '0')}`, `:${42000 + i}`, []);
    const second = await listPage({ page: '2', sortBy: 'name' });
    expect(second.pagination).toEqual({ total: 60, page: 2, perPage: 25 });
    expect(second.hosts).toHaveLength(25);
    // Alpha SSH and Bravo DNS come first: the 26th host is Bulk 23.
    expect(second.hosts[0].name).toBe('Bulk 23');
    const last = await listPage({ page: '40' });
    expect(last.pagination.page).toBe(3);
    expect(last.query.page).toBe(3);
    expect(last.hosts).toHaveLength(10);
  });

  it('limits a scoped role to its hosts, counts included', async () => {
    ctx.sessionUserId = TEAM_A;
    const props = await listPage({ sortBy: 'name' });
    expect(props.hosts.map((h) => h.name)).toEqual(['Alpha SSH', 'Charlie WireGuard']);
    expect(props.totalHosts).toBe(2);
    expect(props.protocolCounts).toEqual({ all: 2, tcp: 1, udp: 1 });
  });

  it('lets a reader see the list but not change it', async () => {
    ctx.sessionUserId = READER;
    const props = await listPage();
    expect(props.hosts).toHaveLength(3);
    expect(props.canWrite).toBe(false);
  });
});

describe('L4 bulk actions', () => {
  it('needs l4_proxy_hosts:write', async () => {
    ctx.sessionUserId = READER;
    await expect(bulkL4ProxyHostsAction([hosts.a], { type: 'disable' })).rejects.toThrow(/permission/i);
    expect((await l4Row(hosts.a))!.enabled).toBe(true);
  });

  it('validates its input', async () => {
    expect(await bulkL4ProxyHostsAction('1,2', { type: 'disable' })).toMatchObject({ ok: false, message: 'Choose the hosts first.' });
    expect(await bulkL4ProxyHostsAction([], { type: 'disable' })).toMatchObject({ ok: false, message: 'Choose the hosts first.' });
    expect(await bulkL4ProxyHostsAction([0], { type: 'disable' })).toMatchObject({ ok: false, message: 'Unknown L4 proxy host.' });
    expect(await bulkL4ProxyHostsAction([hosts.a], { type: 'add_tag', tag: 'x' })).toMatchObject({ ok: false, message: 'Unknown bulk action.' });
    expect(await bulkL4ProxyHostsAction(Array.from({ length: 101 }, (_, i) => i + 1), { type: 'disable' })).toMatchObject({ ok: false });
    expect(caddyApplies).not.toHaveBeenCalled();
  });

  it('changes the hosts in one apply, with an audit event each', async () => {
    const result = await bulkL4ProxyHostsAction([hosts.a, hosts.b, hosts.c], { type: 'disable' });
    expect(result).toMatchObject({ ok: true, changed: 2, unchanged: 1, submitted: 0, message: 'Disabled 2 hosts. 1 host already was as asked.' });
    expect([(await l4Row(hosts.a))!.enabled, (await l4Row(hosts.b))!.enabled]).toEqual([false, false]);
    expect(caddyApplies).toHaveBeenCalledTimes(1);
    const events = audited.filter((event) => event.entityType === 'l4_proxy_host');
    expect(events.map((event) => [event.action, event.entityId])).toEqual([['update', hosts.a], ['update', hosts.b]]);

    expect(await bulkL4ProxyHostsAction([hosts.a, hosts.c], { type: 'enable' })).toMatchObject({ ok: true, changed: 2 });
    expect((await l4Row(hosts.c))!.enabled).toBe(true);
    expect(caddyApplies).toHaveBeenCalledTimes(2);
  });

  it('keeps a scoped role inside its scope', async () => {
    ctx.sessionUserId = TEAM_A;
    const result = await bulkL4ProxyHostsAction([hosts.a, hosts.b], { type: 'disable' });
    expect(result).toMatchObject({ ok: false, changed: 1, failed: [{ id: hosts.b, name: null, message: 'L4 proxy host not found' }] });
    expect((await l4Row(hosts.a))!.enabled).toBe(false);
    expect((await l4Row(hosts.b))!.enabled).toBe(true);
  });

  it('deletes hosts after the same checks', async () => {
    const result = await bulkL4ProxyHostsAction([hosts.b, hosts.c], { type: 'delete' });
    expect(result).toMatchObject({ ok: true, changed: 2, message: 'Deleted 2 hosts.' });
    expect(await l4Row(hosts.b)).toBeUndefined();
    expect(await l4Row(hosts.c)).toBeUndefined();
    expect(caddyApplies).toHaveBeenCalledTimes(1);
    expect(audited).toContainEqual(expect.objectContaining({ action: 'delete', entityType: 'l4_proxy_host', entityId: hosts.c }));
  });

  it('submits changes to protected hosts for approval instead', async () => {
    await insertPolicy(ctx.db, { name: 'Production' });
    const result = await bulkL4ProxyHostsAction([hosts.a, hosts.b], { type: 'delete' });
    expect(result).toMatchObject({ ok: true, changed: 1, submitted: 1 });
    expect(await l4Row(hosts.a)).toBeDefined();
    expect(await l4Row(hosts.b)).toBeUndefined();
    expect(await ctx.db.select().from(schema.changeRequests)).toMatchObject([{ targetType: 'l4_proxy_host', targetId: hosts.a, status: 'pending' }]);
  });
});
