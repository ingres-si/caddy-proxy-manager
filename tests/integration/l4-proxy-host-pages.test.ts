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
import L4HostPage from '@/app/(dashboard)/l4-proxy-hosts/[id]/page';
import NewL4HostPage from '@/app/(dashboard)/l4-proxy-hosts/new/page';
import { createL4ProxyHostAction, updateL4ProxyHostAction } from '@/app/(dashboard)/l4-proxy-hosts/actions';
import { getL4ProxyHost } from '@/src/lib/models/l4-proxy-hosts';
import { l4FormData, l4HostToForm, newL4Form } from '@/src/components/l4-proxy-hosts/editor/model';
import { INITIAL_ACTION_STATE } from '@/src/lib/actions';
import { bulkL4ProxyHostsAction } from '@/app/(dashboard)/l4-proxy-hosts/bulk-actions';
import { applyCaddyConfig } from '@/src/lib/caddy';
import { logAuditEvent } from '@/src/lib/audit';
import { deferCaddyApplyToBatch, inChangeBatch } from '@/src/lib/change-batch';
import { first } from '@/src/lib/db/ops';
import { CaddyApplyError } from '@/src/lib/caddy-apply-error';

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

type HostPageProps = {
  host: { id: number; name: string };
  canWrite: boolean;
  changes: { total: number } | null;
  editor: { host: { id: number } | null; template: unknown; scopeTags: string[] } | null;
};

async function hostPage(id: string): Promise<HostPageProps> {
  const page = (await L4HostPage({ params: Promise.resolve({ id }) })) as { props: HostPageProps };
  return page.props;
}

describe('L4 host page', () => {
  it('opens a host with the editor for a role that may change it', async () => {
    const props = await hostPage(String(hosts.a));
    expect(props.host.name).toBe('Alpha SSH');
    expect(props.canWrite).toBe(true);
    expect(props.editor).toMatchObject({ host: { id: hosts.a }, template: null, scopeTags: [] });
  });

  it('shows a reader the host without the editor', async () => {
    ctx.sessionUserId = READER;
    const props = await hostPage(String(hosts.a));
    expect(props.canWrite).toBe(false);
    expect(props.editor).toBeNull();
    // Readers without audit_log:read get no history.
    expect(props.changes).toBeNull();
  });

  it('answers 404 for a missing host, a malformed id and a host outside the role\'s scope', async () => {
    await expect(hostPage('999')).rejects.toThrow('NOT_FOUND');
    await expect(hostPage('abc')).rejects.toThrow('NOT_FOUND');
    ctx.sessionUserId = TEAM_A;
    await expect(hostPage(String(hosts.b))).rejects.toThrow('NOT_FOUND');
    expect((await hostPage(String(hosts.a))).editor?.scopeTags).toEqual(['team-a']);
  });

  it('starts a new host from a copy only of a host the role may see', async () => {
    const copy = (await NewL4HostPage({ searchParams: Promise.resolve({ from: String(hosts.b) }) })) as { props: { data: { template: { id: number } | null } } };
    expect(copy.props.data.template?.id).toBe(hosts.b);
    ctx.sessionUserId = TEAM_A;
    const scoped = (await NewL4HostPage({ searchParams: Promise.resolve({ from: String(hosts.b) }) })) as { props: { data: { template: unknown; scopeTags: string[] } } };
    expect(scoped.props.data).toMatchObject({ template: null, scopeTags: ['team-a'] });
    ctx.sessionUserId = READER;
    await expect(NewL4HostPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(/permission|REDIRECT/i);
  });
});

describe('L4 host editor saves', () => {
  it('creates a host from the editor form and reports its id', async () => {
    const form = newL4Form();
    form.name = 'Postgres';
    form.listenAddress = ':5432';
    form.upstreams = ['192.0.2.20:5432', '192.0.2.21:5432'];
    form.tags = ['db'];
    form.lb = { ...form.lb, enabled: true, policy: 'least_conn', tryDuration: '5s', passive: { enabled: true, failDuration: '30s', maxFails: '2' } };
    const result = await createL4ProxyHostAction(INITIAL_ACTION_STATE, l4FormData(form));
    expect(result).toMatchObject({ status: 'success' });
    const created = (await getL4ProxyHost(result.id!))!;
    expect(l4HostToForm(created)).toEqual(form);
  });

  it('saves every setting of the form and clears the ones emptied, keeping the on/off state', async () => {
    const before = (await getL4ProxyHost(hosts.a))!;
    const form = l4HostToForm(before);
    form.name = 'Alpha SSH 2';
    form.matcherType = 'tls_sni';
    form.matcherValue = ['ssh.example.com'];
    form.tlsTermination = true;
    form.proxyProtocolVersion = 'v2';
    form.lb = { ...form.lb, enabled: true, policy: 'round_robin', tryDuration: '5s', active: { enabled: true, port: '22', interval: '10s', timeout: '2s' } };
    form.geo = { ...form.geo, enabled: true, mode: 'override', blockCountries: ['CN'], allowAsns: ['AS3320'], allowCidrs: ['203.0.113.0/26'] };
    form.dns = { enabled: true, resolvers: ['1.1.1.1'], fallbacks: [], timeout: '3s' };
    form.pinning = { mode: 'enabled', family: 'ipv4' };
    // The header disabled the host meanwhile: a save from the editor must not turn it back on.
    await ctx.db.update(schema.l4ProxyHosts).set({ enabled: false }).where(eq(schema.l4ProxyHosts.id, hosts.a));
    expect(await updateL4ProxyHostAction(hosts.a, INITIAL_ACTION_STATE, l4FormData(form, { enabled: false }))).toMatchObject({ status: 'success' });
    const saved = (await getL4ProxyHost(hosts.a))!;
    expect(saved.enabled).toBe(false);
    // Tags come back sorted; ASNs without the AS prefix.
    expect(l4HostToForm(saved)).toEqual({ ...form, enabled: false, tags: ['prod', 'team-a'], geo: { ...form.geo, allowAsns: ['3320'] } });

    const cleared = l4HostToForm(saved);
    cleared.lb = { ...cleared.lb, tryDuration: '', active: { ...cleared.lb.active, timeout: '' } };
    cleared.dns = { ...cleared.dns, enabled: false, resolvers: [], timeout: '' };
    await updateL4ProxyHostAction(hosts.a, INITIAL_ACTION_STATE, l4FormData(cleared, { enabled: false }));
    expect(l4HostToForm((await getL4ProxyHost(hosts.a))!)).toEqual(cleared);
  });

  it('reports a server-side problem as an error without saving', async () => {
    const form = l4HostToForm((await getL4ProxyHost(hosts.a))!);
    form.listenAddress = ':443';
    expect(await updateL4ProxyHostAction(hosts.a, INITIAL_ACTION_STATE, l4FormData(form, { enabled: false }))).toMatchObject({ status: 'error', message: expect.stringMatching(/443 is reserved/) });
    expect((await l4Row(hosts.a))!.listenAddress).toBe(':2222');
  });

  it('reports a host stored while Caddy is unreachable as saved but not live, with its id', async () => {
    vi.mocked(applyCaddyConfig).mockRejectedValue(new CaddyApplyError('Unable to reach Caddy API', 'CADDY_UNREACHABLE'));
    const form = newL4Form();
    form.name = 'Offline';
    form.listenAddress = ':6000';
    form.upstreams = ['192.0.2.30:6000'];
    const created = await createL4ProxyHostAction(INITIAL_ACTION_STATE, l4FormData(form));
    expect(created).toMatchObject({ status: 'success', message: expect.stringMatching(/^Saved, but not live yet: Unable to reach Caddy API/) });
    expect((await getL4ProxyHost(created.id!))!.name).toBe('Offline');

    const changed = { ...l4HostToForm((await getL4ProxyHost(created.id!))!), name: 'Offline 2' };
    expect(await updateL4ProxyHostAction(created.id!, INITIAL_ACTION_STATE, l4FormData(changed, { enabled: false }))).toMatchObject({
      status: 'success',
      message: expect.stringMatching(/^Saved, but not live yet/),
    });
    expect((await getL4ProxyHost(created.id!))!.name).toBe('Offline 2');
  });
});
