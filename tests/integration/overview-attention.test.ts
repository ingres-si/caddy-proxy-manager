/**
 * The overview's "needs attention" list (src/lib/attention) and the setup
 * checklist (src/lib/setup-checklist.ts): providers answer only for readers
 * with their permissions, a failing or slow provider never hides the others,
 * and the built-in providers turn the install's state into items.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { createSelfSignedServerCertificate } from '../helpers/certs';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb, role: 'admin', userId: 1 }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  return {
    ...actual,
    requireApiUser: vi.fn(async () => ({ userId: ctx.userId, role: ctx.role, authMethod: 'bearer' })),
    requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
    requireApiAdmin: vi.fn(async () => ({ userId: ctx.userId, role: ctx.role, authMethod: 'bearer' })),
  };
});

import { logAuditEvent } from '../../src/lib/audit';
import { builtInAccess, type Access } from '../../src/lib/permissions';
import { collectAttention, registerAttentionProvider, unregisterAttentionProvider, listAttentionProviders } from '../../src/lib/attention';
import type { AttentionProvider } from '../../src/lib/attention/types';
import { getManagedCertificates, setManagedCertificateProbeForTests } from '../../src/lib/managed-certificates';
import { recordCaddyApplyResult, resetCaddyApplyStatusForTests } from '../../src/lib/caddy-apply-status';
import { getSetupChecklist, updateSetupChecklist } from '../../src/lib/setup-checklist';
import * as attentionRoute from '../../app/api/v1/overview/attention/route';
import * as setupRoute from '../../app/api/v1/setup-checklist/route';
import { first } from '@/src/lib/db/ops';

const DAY = 86_400_000;
const stamp = () => new Date().toISOString();
let adminId: number;
let memberId: number;

async function user(email: string, role: string): Promise<number> {
  return (await first(ctx.db.insert(schema.users).values({ email, name: email.split('@')[0], role, status: 'active', createdAt: stamp(), updatedAt: stamp() }).returning()))!.id;
}

beforeEach(async () => {
  ctx.db = createTestDb();
  ctx.role = 'admin';
  vi.clearAllMocks();
  await resetCaddyApplyStatusForTests();
  setManagedCertificateProbeForTests(null);
  adminId = await user('admin@example.com', 'admin');
  memberId = await user('member@example.com', 'user');
  ctx.userId = adminId;
});

afterEach(() => setManagedCertificateProbeForTests(null));

const admin = (): Access => builtInAccess(adminId, 'admin');

describe('the registry', () => {
  const extra: AttentionProvider[] = [];
  const register = (provider: AttentionProvider) => {
    extra.push(provider);
    registerAttentionProvider(provider);
  };
  afterEach(() => {
    for (const provider of extra.splice(0)) unregisterAttentionProvider(provider.id);
  });

  it('runs a provider only for readers who hold one of its permissions', async () => {
    register({ id: 'test-traffic', label: 'Traffic', permissions: ['analytics:read'], async collect() {
      return [{ id: 'spike', severity: 'warning', title: 'Traffic spike', detail: 'More requests than usual.', actions: [{ label: 'Analytics', route: '/analytics' }], at: null }];
    } });
    const forAdmin = await collectAttention(admin());
    expect(forAdmin.items.find((item) => item.source === 'test-traffic')).toMatchObject({ id: 'spike', title: 'Traffic spike' });
    const viewer = await collectAttention(builtInAccess(memberId, 'viewer'));
    expect(viewer.sources.map((source) => source.id)).toEqual(['my_reviews']);
    const custom: Access = { ...builtInAccess(memberId, 'viewer'), customRole: { id: 1, name: 'Analyst' }, permissions: new Set(['analytics:read']) };
    // Traffic is no built-in source: server errors are alerts of the Error rate rule.
    expect((await collectAttention(custom)).sources.map((source) => source.id)).toEqual(['my_reviews', 'test-traffic']);
  });

  it('reports a failing or slow provider without hiding the others, and sorts by severity', async () => {
    register({ id: 'test-broken', label: 'Broken', permissions: [], async collect() { throw new Error('boom'); } });
    register({ id: 'test-slow', label: 'Slow', permissions: [], collect: () => new Promise(() => undefined) });
    register({ id: 'test-items', label: 'Items', permissions: [], async collect() {
      return [
        { id: 'b', severity: 'info', title: 'Info', detail: 'd', actions: [], at: '2026-10-03T00:00:00.000Z' },
        { id: 'a', severity: 'critical', title: 'Critical\u0000 title', detail: 'd', actions: [], at: '2026-10-01T00:00:00.000Z' },
        { id: 'c', severity: 'info', title: 'Newer info', detail: 'd', actions: [], at: '2026-10-04T00:00:00.000Z' },
      ];
    } });
    const view = await collectAttention(admin(), { timeoutMs: 50 });
    expect(view.sources.find((source) => source.id === 'test-broken')).toMatchObject({ status: 'error', items: 0 });
    expect(view.sources.find((source) => source.id === 'test-slow')).toMatchObject({ status: 'timeout' });
    expect(view.sources.find((source) => source.id === 'test-items')).toMatchObject({ status: 'ok', items: 3 });
    const mine = view.items.filter((item) => item.source === 'test-items');
    expect(mine.map((item) => item.id)).toEqual(['a', 'c', 'b']);
    expect(mine[0].title).toBe('Critical  title');
  });

  it('registers the built-in providers', () => {
    expect(listAttentionProviders().map((provider) => provider.id)).toEqual(
      expect.arrayContaining(['certificates', 'caddy', 'setup', 'identity', 'alerts', 'approvals', 'my_reviews', 'access_reviews', 'fleet', 'backups'])
    );
    expect(listAttentionProviders().map((provider) => provider.id)).not.toContain('traffic');
  });
});

describe('built-in providers', () => {
  it('turns certificates, alerts, approvals, reviews, the fleet, backups and the Caddy apply into items', async () => {
    const t = stamp();
    // An imported certificate expiring in 5 days.
    const soon = createSelfSignedServerCertificate('shop.example.com', ['shop.example.com'], 5).certificatePem;
    await ctx.db.insert(schema.certificates).values({ name: 'Shop', type: 'imported', domainNames: '["shop.example.com"]', certificatePem: soon, createdAt: t, updatedAt: t });
    // A host whose certificate Caddy has not got.
    await ctx.db.insert(schema.proxyHosts).values({ name: 'Auth', domains: '["auth.example.com"]', upstreams: '[]', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    setManagedCertificateProbeForTests(async () => ({ kind: 'missing' }));
    await getManagedCertificates();
    // A firing alert.
    const rule = (await first(ctx.db.insert(schema.alertRules).values({ name: 'Errors', type: 'error_rate', createdAt: t, updatedAt: t }).returning()))!;
    await ctx.db.insert(schema.alertRuleStates).values({ ruleId: rule.id, subjectKey: 'proxy_host:1', status: 'firing', title: '5xx', firedAt: t, lastEvaluatedAt: t });
    await ctx.db.insert(schema.alertEvents).values({ ruleId: rule.id, ruleName: 'Errors', ruleType: 'error_rate', subjectKey: 'proxy_host:1', status: 'firing', severity: 'critical', title: '5xx at 5.2% on "Mail"', message: 'Check the upstream.', createdAt: t });
    // A change request waiting for the admin's approval.
    await ctx.db.insert(schema.changeRequests).values({
      targetType: 'proxy_host', targetId: 1, targetName: 'Auth', operation: 'update', operations: '["update"]', input: '{"host":{"upstreams":["v2:80"]}}',
      baseState: '{"host":{"upstreams":["v1:80"]}}', requestedBy: memberId, expiresAt: new Date(Date.now() + DAY).toISOString(), createdAt: t, updatedAt: t,
    });
    // An overdue access review the admin reviews.
    const campaign = (await first(ctx.db.insert(schema.accessReviewCampaigns).values({ name: 'Q4', status: 'open', reviewerIds: JSON.stringify([adminId]), dueAt: new Date(Date.now() - DAY).toISOString(), startedAt: t, createdAt: t, updatedAt: t }).returning()))!;
    await ctx.db.insert(schema.accessReviewItems).values({ campaignId: campaign.id, subjectUserId: memberId, subjectEmail: 'member@example.com', kind: 'account', targetLabel: 'account', createdAt: t, updatedAt: t });
    // A master with a drifted, failing instance.
    await ctx.db.insert(schema.settings).values({ key: 'instance_mode', value: '"master"', updatedAt: t });
    const instance = (await first(ctx.db.insert(schema.instances).values({ name: 'edge-2', baseUrl: 'https://edge-2.example.com', apiToken: 'x', lastSyncError: 'Connection refused', createdAt: t, updatedAt: t }).returning()))!;
    await ctx.db.insert(schema.fleetInstances).values({ instanceId: instance.id, driftStatus: 'drifted', driftSince: t, driftDetail: 'Local changes', updatedAt: t });
    // A failing backup destination.
    await ctx.db.insert(schema.backupDestinations).values({
      name: 'Off-site', endpoint: 'https://s3.example.com', region: 'eu', bucket: 'b', accessKeyId: 'k', secretAccessKey: 'x', passphrase: 'x',
      schedule: '{"kind":"daily","time":"03:00"}', lastStatus: 'failed', consecutiveFailures: 3, createdAt: t, updatedAt: t,
    });
    await recordCaddyApplyResult({ ok: false, code: 'CADDY_REJECTED', message: 'Caddy rejected the configuration' });

    const view = await collectAttention(admin());
    const bySource = (source: string) => view.items.filter((item) => item.source === source);
    expect(bySource('certificates').map((item) => [item.severity, item.title])).toEqual([
      ['critical', 'No valid certificate for auth.example.com'],
      ['warning', 'Certificate "Shop" expires in 4 days'],
    ]);
    expect(bySource('alerts')).toEqual([
      expect.objectContaining({
        severity: 'critical',
        title: '5xx at 5.2% on "Mail"',
        actions: [{ label: 'Open host', route: '/proxy-hosts/1' }, { label: 'Show requests', route: expect.stringContaining('/analytics?') }],
        issue: { ruleId: rule.id, subjectKey: 'proxy_host:1' },
      }),
    ]);
    expect(bySource('approvals')).toEqual([expect.objectContaining({ severity: 'warning', title: 'Change request #1 waits for your approval' })]);
    expect(bySource('my_reviews')).toEqual([expect.objectContaining({ severity: 'critical', title: '1 access review item waits for your decision' })]);
    expect(bySource('access_reviews')).toEqual([expect.objectContaining({ severity: 'warning', title: 'Access review "Q4" is overdue', actions: [{ label: 'Open the review', route: `/access-reviews/${campaign.id}` }] })]);
    expect(bySource('fleet').map((item) => item.title).sort()).toEqual(['Sync to edge-2 failed', 'edge-2 drifted from the configuration the master pushed']);
    expect(bySource('backups')).toEqual([expect.objectContaining({ severity: 'critical', title: 'Backups to "Off-site" are failing' })]);
    expect(bySource('caddy')).toEqual([expect.objectContaining({ severity: 'critical', title: 'Applying the configuration to Caddy failed' })]);
    expect(bySource('setup')).toEqual([expect.objectContaining({ severity: 'info', title: expect.stringMatching(/^Finish setting up: \d of 5 steps done$/) })]);
    expect(view.items[0].severity).toBe('critical');
    expect(view.sources.every((source) => source.status === 'ok')).toBe(true);
  });

  it('limits certificates to the reader\'s tag scope', async () => {
    const t = stamp();
    const soon = createSelfSignedServerCertificate('shop.example.com', ['shop.example.com'], 5).certificatePem;
    const cert = (await first(ctx.db.insert(schema.certificates).values({ name: 'Shop', type: 'imported', domainNames: '[]', certificatePem: soon, createdAt: t, updatedAt: t }).returning()))!;
    await ctx.db.insert(schema.proxyHosts).values({ name: 'Shop', domains: '["shop.example.com"]', upstreams: '[]', certificateId: cert.id, tags: '["shop"]', createdAt: t, updatedAt: t });
    const scoped = (tag: string): Access => ({ ...builtInAccess(memberId, 'viewer'), customRole: { id: 1, name: 'r' }, permissions: new Set(['certificates:read']), scopeTags: [tag] });
    expect((await collectAttention(scoped('shop'))).items.map((item) => item.title)).toEqual(['Certificate "Shop" expires in 4 days']);
    expect((await collectAttention(scoped('blog'))).items).toEqual([]);
  });

  it('serves the reader\'s own items over the REST API to any signed-in user', async () => {
    const t = stamp();
    const campaign = (await first(ctx.db.insert(schema.accessReviewCampaigns).values({ name: 'Q4', status: 'open', reviewerIds: JSON.stringify([memberId]), dueAt: new Date(Date.now() + 30 * DAY).toISOString(), startedAt: t, createdAt: t, updatedAt: t }).returning()))!;
    await ctx.db.insert(schema.accessReviewItems).values({ campaignId: campaign.id, subjectUserId: adminId, subjectEmail: 'admin@example.com', kind: 'account', targetLabel: 'account', createdAt: t, updatedAt: t });
    await recordCaddyApplyResult({ ok: false, code: 'CADDY_REJECTED', message: 'Caddy rejected the configuration' });
    ctx.role = 'viewer';
    ctx.userId = memberId;
    const response = await attentionRoute.GET(new NextRequest('http://localhost/api/v1/overview/attention'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.map((item: { source: string; severity: string }) => [item.source, item.severity])).toEqual([['my_reviews', 'info']]);
    expect(body.sources).toEqual([{ id: 'my_reviews', label: 'Your access reviews', status: 'ok', items: 1 }]);
  });
});

describe('setup checklist', () => {
  it('reads each step from the data', async () => {
    let checklist = await getSetupChecklist();
    expect(checklist.steps.map((step) => [step.key, step.done])).toEqual([
      ['domain', false], ['first_proxy_host', false], ['analytics', false], ['second_user', true], ['single_sign_on', false],
    ]);
    expect(checklist).toMatchObject({ done: 1, total: 5, complete: false, dismissed: false });

    const t = stamp();
    await ctx.db.insert(schema.proxyHosts).values({ name: 'App', domains: '["app.example.com"]', upstreams: '[]', createdAt: t, updatedAt: t });
    await ctx.db.insert(schema.oauthProviders).values({ id: 'idp', name: 'IdP', clientId: 'c', clientSecret: 's', createdAt: t, updatedAt: t });
    const valid = createSelfSignedServerCertificate('app.example.com', ['app.example.com'], 90).certificatePem;
    setManagedCertificateProbeForTests(async () => ({ kind: 'certificate', pem: valid }));
    await getManagedCertificates();
    checklist = await getSetupChecklist();
    expect(checklist.steps.filter((step) => step.done).map((step) => [step.key, step.doneBy])).toEqual([
      ['domain', 'data'], ['first_proxy_host', 'data'], ['second_user', 'data'], ['single_sign_on', 'data'],
    ]);
    // Analytics is the only step left.
    expect(checklist.complete).toBe(false);
  });

  it('marks steps done by hand, hides the checklist, audits it and validates input', async () => {
    let checklist = await updateSetupChecklist({ steps: { analytics: true, single_sign_on: true, first_proxy_host: true, domain: true } }, adminId);
    expect(checklist.steps.find((step) => step.key === 'analytics')).toMatchObject({ done: true, doneBy: 'manual', markedAt: expect.any(String) });
    expect(checklist.complete).toBe(true);
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'setup_checklist_updated', userId: adminId }));

    checklist = await updateSetupChecklist({ steps: { analytics: false }, dismissed: true }, adminId);
    expect(checklist).toMatchObject({ complete: false, dismissed: true, dismissedAt: expect.any(String) });
    expect(checklist.steps.find((step) => step.key === 'analytics')!.done).toBe(false);

    vi.mocked(logAuditEvent).mockClear();
    await updateSetupChecklist({ dismissed: true }, adminId);
    expect(logAuditEvent).not.toHaveBeenCalled();

    await expect(updateSetupChecklist({ steps: { everything: true } }, adminId)).rejects.toThrow(/unknown step "everything"/);
    await expect(updateSetupChecklist({ steps: { domain: 'yes' } }, adminId)).rejects.toThrow(/steps.domain must be true or false/);
    await expect(updateSetupChecklist({ hidden: true }, adminId)).rejects.toThrow(/Unknown field "hidden"/);
    await expect(updateSetupChecklist([], adminId)).rejects.toThrow(/JSON object/);
  });

  it('is served over the REST API', async () => {
    const put = await setupRoute.PUT(new NextRequest('http://localhost/api/v1/setup-checklist', { method: 'PUT', body: JSON.stringify({ steps: { analytics: true } }), headers: { 'content-type': 'application/json' } }));
    expect(put.status).toBe(200);
    const body = await (await setupRoute.GET(new NextRequest('http://localhost/api/v1/setup-checklist'))).json();
    expect(body.steps.find((step: { key: string }) => step.key === 'analytics')).toMatchObject({ done: true, doneBy: 'manual' });
    expect((await setupRoute.PUT(new NextRequest('http://localhost/api/v1/setup-checklist', { method: 'PUT', body: 'not json' }))).status).toBe(400);
  });

  it('ignores the mark of a step earlier releases had (npm_import) and drops it at the next change', async () => {
    const at = stamp();
    await ctx.db.insert(schema.settings).values({
      key: 'setup_checklist',
      value: JSON.stringify({ marked: { npm_import: { at, userId: adminId }, analytics: { at, userId: adminId } }, dismissedAt: null }),
      updatedAt: at,
    });
    let checklist = await getSetupChecklist();
    expect(checklist.steps.map((step) => step.key)).toEqual(['domain', 'first_proxy_host', 'analytics', 'second_user', 'single_sign_on']);
    expect(checklist.steps.find((step) => step.key === 'analytics')).toMatchObject({ done: true, doneBy: 'manual', markedAt: at });
    expect(checklist).toMatchObject({ done: 2, total: 5, complete: false, dismissed: false });

    checklist = await updateSetupChecklist({ steps: { domain: true } }, adminId);
    expect(checklist.done).toBe(3);
    const stored = JSON.parse((await first(ctx.db.select().from(schema.settings).where(eq(schema.settings.key, 'setup_checklist'))))!.value);
    expect(Object.keys(stored.marked).sort()).toEqual(['analytics', 'domain']);

    await expect(updateSetupChecklist({ steps: { npm_import: true } }, adminId)).rejects.toThrow(/unknown step "npm_import"/);
  });
});
