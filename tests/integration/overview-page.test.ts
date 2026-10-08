/**
 * The overview page's data loader (src/lib/overview.ts): each section only
 * for viewers who may read it, the first-run checklist while the install is
 * fresh, the range, the busiest hosts with their status and certificate,
 * the nodes, and roll-back links where the configuration history allows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { createSelfSignedServerCertificate } from '../helpers/certs';
import type { HostSummary } from '../../src/lib/analytics/hosts';
import type { TrafficSignals } from '../../src/lib/analytics/signals';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  summaries: null as null | Omit<HostSummary, 'sparkline'>[],
  signals: null as null | TrafficSignals,
}));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('../../src/lib/analytics/hosts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/analytics/hosts')>();
  return {
    ...actual,
    queryHostSummaries: vi.fn(async (input: Parameters<typeof actual.queryHostSummaries>[0]) => {
      if (!ctx.summaries) return actual.queryHostSummaries(input);
      const wanted = new Set(input.hosts.map((host) => host.id));
      return {
        status: 'ok' as const,
        range: { preset: input.range.preset, start: input.range.start, end: input.range.end },
        sparklineStep: 3600,
        hosts: ctx.summaries.filter((summary) => wanted.has(summary.proxyHostId)).map((summary) => ({ ...summary, sparkline: [] })),
      };
    }),
  };
});
vi.mock('../../src/lib/analytics/signals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/analytics/signals')>();
  return {
    ...actual,
    getTrafficSignals: vi.fn(async (...args: Parameters<typeof actual.getTrafficSignals>) => ctx.signals ?? actual.getTrafficSignals(...args)),
  };
});

import { builtInAccess, type Access, type Permission } from '../../src/lib/permissions';
import { hostTone, loadOverview, parseOverviewRange, replicaNode, BUSIEST_HOSTS } from '../../src/lib/overview';
import { updateSetupChecklist } from '../../src/lib/setup-checklist';
import { clearTrafficSignalsCache } from '../../src/lib/analytics/signals-cache';
import { recordCaddyApplyResult, resetCaddyApplyStatusForTests } from '../../src/lib/caddy-apply-status';
import type { FleetInstanceView } from '../../ee/fleet/types';
import { first as dbFirst } from '@/src/lib/db/ops';

const stamp = () => new Date().toISOString();
let adminId: number;
let memberId: number;

async function user(email: string, role: string, name: string | null = email.split('@')[0]): Promise<number> {
  return (await dbFirst(ctx.db.insert(schema.users).values({ email, name, role, status: 'active', createdAt: stamp(), updatedAt: stamp() }).returning()))!.id;
}

async function host(name: string, domains: string[], extra: Partial<typeof schema.proxyHosts.$inferInsert> = {}): Promise<number> {
  return (await dbFirst(ctx.db
    .insert(schema.proxyHosts)
    .values({ name, domains: JSON.stringify(domains), upstreams: '[]', tags: '[]', createdAt: stamp(), updatedAt: stamp(), ...extra })
    .returning()))!.id;
}

function custom(permissions: Permission[]): Access {
  return { ...builtInAccess(memberId, 'viewer'), customRole: { id: 1, name: 'Custom' }, permissions: new Set(permissions) };
}

const admin = () => builtInAccess(adminId, 'admin');
const load = (access: Access, range?: unknown) => loadOverview(access, { userName: 'admin', range });

beforeEach(async () => {
  ctx.db = createTestDb();
  ctx.summaries = null;
  ctx.signals = null;
  vi.clearAllMocks();
  clearTrafficSignalsCache();
  await resetCaddyApplyStatusForTests();
  delete process.env.INSTANCE_MODE;
  adminId = await user('admin@example.com', 'admin', 'Ada Admin');
  memberId = await user('member@example.com', 'viewer');
});

describe('what each viewer gets', () => {
  it('gives the built-in viewer role what needs their attention and nothing else', async () => {
    const data = await load(builtInAccess(memberId, 'viewer'));
    expect(data).toMatchObject({ traffic: null, hosts: null, nodes: null, changes: null, firstRun: null });
    expect(Object.values(data.permissions).every((allowed) => allowed === false)).toBe(true);
    expect(data.attention.sources.map((source) => source.id)).toEqual(['my_reviews']);
  });

  it('gives administrators every section', async () => {
    const data = await load(admin());
    expect(data.traffic).not.toBeNull();
    expect(data.hosts).not.toBeNull();
    expect(data.nodes).not.toBeNull();
    expect(data.changes).not.toBeNull();
    expect(data.permissions).toMatchObject({ createProxyHost: true, readAnalytics: true, readSecurity: true, writeSettings: true });
  });

  it('gives a custom role the sections of its permissions only', async () => {
    const analyst = await load(custom(['analytics:read']));
    expect(analyst.traffic).not.toBeNull();
    expect(analyst.hosts).not.toBeNull();
    expect(analyst).toMatchObject({ nodes: null, changes: null, firstRun: null });
    expect(analyst.permissions).toMatchObject({ readAnalytics: true, createProxyHost: false, readProxyHosts: false });

    const auditor = await load(custom(['audit_log:read', 'instances:read']));
    expect(auditor).toMatchObject({ traffic: null, hosts: null });
    expect(auditor.changes).toEqual([]);
    expect(auditor.nodes).toMatchObject({ mode: 'standalone', link: null });
  });

  it('reads the range, falling back to 24 hours', async () => {
    expect(parseOverviewRange('7d')).toBe('7d');
    expect(parseOverviewRange(['1h', '7d'])).toBe('1h');
    expect(parseOverviewRange('30d')).toBe('24h');
    expect(parseOverviewRange(undefined)).toBe('24h');
    const data = await load(admin(), '7d');
    expect(data.range).toBe('7d');
    expect(data.traffic?.range).toMatchObject({ step: 10_800, buckets: 56 });
    expect(data.traffic?.served).toHaveLength(56);
    // ClickHouse is not configured in the tests: the traffic says so instead of failing.
    expect(data.traffic?.status).toBe('disabled');
    expect(data.hosts?.status).toBe('disabled');
  });
});

describe('first run', () => {
  it('shows the setup checklist while the install is fresh, until it is hidden', async () => {
    const data = await load(admin());
    expect(data.firstRun?.checklist.steps.map((step) => step.key)).toEqual(['domain', 'first_proxy_host', 'analytics', 'second_user', 'single_sign_on']);

    await updateSetupChecklist({ dismissed: true }, adminId);
    expect((await load(admin())).firstRun).toBeNull();
  });

  it('is gone once every step is done', async () => {
    await host('Wiki', ['wiki.example.com']);
    await updateSetupChecklist({ steps: { domain: true, analytics: true, single_sign_on: true } }, adminId);
    // Two users exist already (the admin and the member).
    expect((await load(admin())).firstRun).toBeNull();
  });

  it('is only for readers of the settings', async () => {
    expect((await load(custom(['settings:read']))).firstRun).not.toBeNull();
    expect((await load(custom(['proxy_hosts:read']))).firstRun).toBeNull();
  });
});

describe('busiest hosts', () => {
  it('ranks hosts by requests, with their status, burst and certificate', async () => {
    const busy = await host('Busy', ['busy.example.com']);
    const shop = await host('Shop', ['shop.example.com']);
    const quiet = await host('Quiet', ['quiet.example.com'], { enabled: false });
    const mail = await host('Mail', ['mail.example.com']);
    const pem = createSelfSignedServerCertificate('shop.example.com', ['shop.example.com'], 5).certificatePem;
    const cert = (await dbFirst(ctx.db.insert(schema.certificates).values({ name: 'Shop', type: 'imported', domainNames: '["shop.example.com"]', certificatePem: pem, createdAt: stamp(), updatedAt: stamp() }).returning()))!;
    await ctx.db.update(schema.proxyHosts).set({ certificateId: cert.id }).where(eq(schema.proxyHosts.id, shop));
    ctx.summaries = [
      { proxyHostId: busy, requests: 1000, errors5xx: 60, errorRate5xx: 0.06, mitigated: 20, bytes: 1 },
      { proxyHostId: shop, requests: 500, errors5xx: 0, errorRate5xx: 0, mitigated: 0, bytes: 1 },
      { proxyHostId: quiet, requests: 0, errors5xx: 0, errorRate5xx: 0, mitigated: 0, bytes: 0 },
      { proxyHostId: mail, requests: 250, errors5xx: 2, errorRate5xx: 0.008, mitigated: 5, bytes: 1 },
    ];
    const now = Math.floor(Date.now() / 1000);
    ctx.signals = {
      status: 'ok', generatedAt: now, mitigationSpikes: [], blockedConcentrations: [],
      errorBursts: [{ host: 'mail.example.com', proxyHostId: mail, count: 20, requests: 40, start: now - 3600, end: now - 3500, ongoing: false, status: 501, method: 'GET', path: '/' }],
    };

    const { hosts, traffic } = await load(admin());
    expect(hosts?.status).toBe('ok');
    expect(hosts?.total).toBe(4);
    expect(hosts?.certificates).toBe(true);
    expect(hosts?.rows.map((row) => [row.label, row.share, row.tone])).toEqual([
      ['busy.example.com', 1, 'bad'],
      ['shop.example.com', 0.5, 'bad'],
      ['mail.example.com', 0.25, 'warn'],
      ['quiet.example.com', 0, 'off'],
    ]);
    const [busyRow, shopRow, mailRow] = hosts!.rows;
    expect(busyRow).toMatchObject({ href: `/proxy-hosts/${busy}`, toneLabel: 'Many server errors', burst: null });
    expect(shopRow.certificateDaysLeft).toBeGreaterThanOrEqual(3);
    expect(shopRow.certificateDaysLeft).toBeLessThanOrEqual(5);
    expect(shopRow.toneLabel).toBe('Certificate expires within a week');
    expect(mailRow).toMatchObject({ toneLabel: 'Had a burst of server errors', burst: { status: 501, start: now - 3600, ongoing: false } });
    expect(traffic?.topErrorHost).toEqual({ name: 'busy.example.com', count: 60 });

    // Without proxy_hosts:read and certificates:read: no links, no certificate column.
    const analyst = await load(custom(['analytics:read']));
    expect(analyst.hosts?.certificates).toBe(false);
    expect(analyst.hosts?.rows.every((row) => row.href === null && row.certificateDaysLeft === null)).toBe(true);
  });

  it(`lists at most ${BUSIEST_HOSTS} hosts`, async () => {
    const ids: number[] = [];
    for (let i = 0; i < BUSIEST_HOSTS + 3; i++) ids.push(await host(`H${i}`, [`h${i}.example.com`]));
    ctx.summaries = ids.map((id, i) => ({ proxyHostId: id, requests: i * 10, errors5xx: 0, errorRate5xx: 0, mitigated: 0, bytes: 0 }));
    const { hosts } = await load(admin());
    expect(hosts?.total).toBe(BUSIEST_HOSTS + 3);
    expect(hosts?.rows).toHaveLength(BUSIEST_HOSTS);
    expect(hosts?.rows[0].label).toBe(`h${BUSIEST_HOSTS + 2}.example.com`);
  });

  it('colours a host by the worst of its state', () => {
    const healthy = { enabled: true, errors5xx: 0, errorRate5xx: 0, certificateDaysLeft: 60, burst: null };
    expect(hostTone(healthy)).toEqual({ tone: 'ok', label: 'No issues' });
    expect(hostTone({ ...healthy, enabled: false, certificateDaysLeft: -1 }).tone).toBe('off');
    expect(hostTone({ ...healthy, certificateDaysLeft: -1 }).label).toBe('Certificate expired');
    expect(hostTone({ ...healthy, burst: { ongoing: true } }).tone).toBe('bad');
    expect(hostTone({ ...healthy, errors5xx: 9, errorRate5xx: 0.5 }).tone).toBe('ok');
    expect(hostTone({ ...healthy, errors5xx: 10, errorRate5xx: 0.02 }).tone).toBe('warn');
    expect(hostTone({ ...healthy, certificateDaysLeft: 10 }).label).toBe('Certificate expires within two weeks');
  });
});

describe('nodes', () => {
  it('shows this server, and links to the fleet or instance sync by permission', async () => {
    const data = await load(admin());
    expect(data.nodes).toMatchObject({ mode: 'standalone', more: 0, link: { label: 'Fleet', href: '/fleet' } });
    expect(data.nodes?.nodes).toEqual([expect.objectContaining({ key: 'self', name: 'This server', detail: 'Standalone', tone: 'ok' })]);
    expect((await load(custom(['instances:read', 'settings:read']))).nodes?.link).toEqual({ label: 'Instance sync', href: '/instances' });
    await recordCaddyApplyResult({ ok: false, code: 'CADDY_UNREACHABLE', message: 'Caddy did not answer' });
    expect((await load(admin())).nodes?.nodes[0]).toMatchObject({ detail: 'Standalone · Caddy apply failed', tone: 'bad' });
  });

  it("lists a master's enabled replicas, the ones needing attention first", async () => {
    await ctx.db.insert(schema.settings).values({ key: 'instance_mode', value: '"master"', updatedAt: stamp() });
    const add = async (name: string, enabled = true, error: string | null = null) =>
      (await dbFirst(ctx.db.insert(schema.instances).values({ name, baseUrl: `https://${name}.example.com`, apiToken: 'x', enabled, lastSyncAt: stamp(), lastSyncError: error, createdAt: stamp(), updatedAt: stamp() }).returning()))!.id;
    await add('edge-1');
    await add('edge-2', true, 'Connection refused');
    await add('edge-3', false);
    const { nodes } = await load(admin());
    expect(nodes?.mode).toBe('master');
    expect(nodes?.nodes.map((node) => [node.name, node.detail, node.tone])).toEqual([
      ['This server', 'Master · 2 replicas', 'ok'],
      ['edge-2', 'Replica · last sync failed', 'warn'],
      ['edge-1', 'Replica · synced', 'ok'],
    ]);
  });

  it('describes a replica from what the master knows', () => {
    const base: FleetInstanceView = {
      id: 1, name: 'edge-1', baseUrl: 'https://edge-1.example.com', syncMode: 'push', pull: null, enabled: true, environmentId: null,
      revisionId: null, pushedAt: null, lastSyncAt: null, lastSyncError: null,
      drift: { status: null, checkedAt: null, since: null, detail: null, reportedVersion: null, localChanges: null },
    };
    expect(replicaNode(base)).toMatchObject({ detail: 'Replica · not synced yet', tone: 'off' });
    expect(replicaNode({ ...base, drift: { ...base.drift, status: 'in_sync', reportedVersion: '2.0.2' } }, '2.0.3')).toMatchObject({
      detail: 'Replica · in sync', tone: 'warn', version: 'v2.0.2', versionDiffers: true,
    });
    expect(replicaNode({ ...base, drift: { ...base.drift, status: 'unreachable', checkedAt: stamp() } })).toMatchObject({ tone: 'bad', detail: 'Replica · unreachable' });
    expect(replicaNode({ ...base, syncMode: 'pull', pull: { lastSeenAt: stamp(), pollIntervalSeconds: 60, checkIn: 'missed', hasCredential: true } })).toMatchObject({
      tone: 'bad', detail: 'Pull replica · stopped checking in',
    });
  });
});

describe('recent changes', () => {
  async function snapshot(): Promise<number> {
    return (await dbFirst(ctx.db.insert(schema.configSnapshots).values({ createdAt: stamp(), reason: 'auto', summary: 's', fingerprint: 'f', content: '{}', sizeBytes: 2 }).returning()))!.id;
  }
  async function event(summary: string, links: { configBeforeId?: number | null; configAfterId?: number | null } = {}, userId: number | null = adminId): Promise<number> {
    return (await dbFirst(ctx.db.insert(schema.auditEvents).values({ userId, action: 'proxy_host_updated', entityType: 'proxy_host', entityId: 1, summary, createdAt: stamp(), ...links }).returning()))!.id;
  }

  beforeEach(async () => {
    const first = await snapshot();
    const second = await snapshot();
    await event('Updated proxy host Wiki', { configBeforeId: first, configAfterId: second });
    await event('Saved settings without a change', { configBeforeId: second, configAfterId: second });
    await event('Rule expired', {}, null);
    await event('Updated proxy host Old', { configBeforeId: 9999, configAfterId: second });
  });

  it('offers a roll back where the version from before is kept and the viewer may restore it', async () => {
    const changes = (await load(admin())).changes!;
    const byText = new Map(changes.map((change) => [change.summary, change]));
    expect(byText.get('Updated proxy host Wiki')).toMatchObject({ who: 'Ada Admin', rollbackHref: '/history?version=1' });
    expect(byText.get('Saved settings without a change')?.rollbackHref).toBeNull();
    expect(byText.get('Rule expired')).toMatchObject({ who: null, rollbackHref: null });
    expect(byText.get('Updated proxy host Old')?.rollbackHref).toBeNull();
  });

  it('offers no roll back without the permission, or on a replica', async () => {
    expect((await load(custom(['audit_log:read']))).changes!.every((change) => change.rollbackHref === null)).toBe(true);
    process.env.INSTANCE_MODE = 'slave';
    try {
      expect((await load(admin())).changes!.every((change) => change.rollbackHref === null)).toBe(true);
    } finally {
      delete process.env.INSTANCE_MODE;
    }
  });
});
