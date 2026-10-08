/**
 * Alerts as the issues of the install: the built-in rules every install gets
 * (ee/alerting/builtins.ts), that they cannot be deleted, the alerts listed
 * under Needs attention with their links and what dismissing needs
 * (ee/alerting/attention.ts), the older sources an enabled rule supersedes
 * (src/lib/attention/registry.ts), whether anyone is notified, and the test
 * of a channel before it is saved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});
vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  return {
    ...actual,
    requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
    requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
  };
});

import * as schema from '../../src/lib/db/schema';
import { BUILT_IN_RULES, ensureBuiltInAlertRules } from '../../ee/alerting/builtins';
import { DELETE as deleteRule } from '../../app/api/v1/alert-rules/[id]/route';
import { POST as testNewChannel } from '../../app/api/v1/alert-channels/test/route';
import { POST as testChannel } from '../../app/api/v1/alert-channels/[id]/test/route';
import { POST as createChannel } from '../../app/api/v1/alert-channels/route';
import { collectAttention, registerAttentionProvider, unregisterAttentionProvider } from '../../src/lib/attention';
import { alertsAttentionProvider } from '../../ee/alerting/attention';
import { issueLinks } from '../../ee/alerting/links';
import { builtInAccess, type Access, type Permission } from '../../src/lib/permissions';
import { getSetting } from '../../src/lib/settings';
import { first } from '@/src/lib/db/ops';

const stamp = () => new Date().toISOString();

function request(method: string, body?: unknown): any {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    method,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? String(text.length) : null) },
    nextUrl: { pathname: '/api/v1/test', searchParams: new URLSearchParams() },
    json: async () => {
      if (body === undefined) throw new SyntaxError('no body');
      return body;
    },
  };
}

const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

function custom(permissions: Permission[]): Access {
  return { ...builtInAccess(2, 'viewer'), customRole: { id: 1, name: 'Custom' }, permissions: new Set(permissions), scopeTags: [] };
}

async function rule(values: Partial<typeof schema.alertRules.$inferInsert> & Pick<typeof schema.alertRules.$inferInsert, 'type'>): Promise<number> {
  return (await first(ctx.db
    .insert(schema.alertRules)
    .values({ name: values.type, params: '{}', createdAt: stamp(), updatedAt: stamp(), ...values })
    .returning()))!.id;
}

async function firing(ruleId: number, subjectKey: string, facts: Record<string, unknown> = {}): Promise<void> {
  await ctx.db.insert(schema.alertRuleStates).values({ ruleId, subjectKey, status: 'firing', title: subjectKey, firedAt: stamp(), lastEvaluatedAt: stamp() });
  await ctx.db.insert(schema.alertEvents).values({
    ruleId, ruleName: 'Rule', ruleType: 'error_rate', subjectKey, status: 'firing', severity: 'critical',
    title: `Server errors on ${subjectKey}`, message: '12% of requests answered 5xx.', facts: JSON.stringify(facts), createdAt: stamp(),
  });
}

beforeEach(async () => {
  for (const table of [schema.alertSilences, schema.alertEvents, schema.alertRuleStates, schema.alertRules, schema.alertChannels, schema.settings]) {
    await ctx.db.delete(table);
  }
});

afterEach(() => vi.restoreAllMocks());

describe('built-in rules', () => {
  it('are added once, enabled except the WAF spike, notifying nobody, and remembered by version', async () => {
    expect(await ensureBuiltInAlertRules()).toBe(BUILT_IN_RULES.length);
    const rows = await ctx.db.select().from(schema.alertRules);
    expect(rows.map((row) => row.builtIn).sort()).toEqual(BUILT_IN_RULES.map((definition) => definition.key).sort());
    expect(rows.filter((row) => !row.enabled).map((row) => row.type)).toEqual(['waf_spike']);
    expect(rows.every((row) => row.channelIds === '[]')).toBe(true);
    expect(await getSetting('alerting_built_in_rules_version')).toBe(1);

    // Disabled by someone: a second check adds nothing and changes nothing.
    await ctx.db.update(schema.alertRules).set({ enabled: false });
    await ctx.db.delete(schema.alertRules).where((await import('drizzle-orm')).eq(schema.alertRules.builtIn, 'backups'));
    expect(await ensureBuiltInAlertRules()).toBe(0);
    expect((await ctx.db.select().from(schema.alertRules)).some((row) => row.enabled)).toBe(false);
  });

  it('leave out the types an install already watches with its own rule', async () => {
    await rule({ type: 'cert_expiring', name: 'My certificates' });
    await ensureBuiltInAlertRules();
    const certificateRules = (await ctx.db.select().from(schema.alertRules)).filter((row) => row.type === 'cert_expiring');
    expect(certificateRules).toHaveLength(1);
    expect(certificateRules[0].builtIn).toBeNull();
  });

  it('cannot be deleted, only disabled (409)', async () => {
    await ensureBuiltInAlertRules();
    const [certificates] = await ctx.db.select().from(schema.alertRules).where((await import('drizzle-orm')).eq(schema.alertRules.builtIn, 'certificates'));
    const response = await deleteRule(request('DELETE'), params(certificates.id));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('disable the rule instead');
    const own = await rule({ type: 'waf_spike' });
    expect((await deleteRule(request('DELETE'), params(own)))).toHaveProperty('status', 204);
  });
});

describe('alerts under Needs attention', () => {
  it('list open alerts with their links and the rule and subject to dismiss them', async () => {
    const id = await rule({ type: 'error_rate' });
    await firing(id, 'proxy_host:7', { domains: ['mail.example.com'] });
    const view = await collectAttention(builtInAccess(1, 'admin'));
    const item = view.items.find((entry) => entry.source === 'alerts');
    expect(item).toMatchObject({
      severity: 'critical',
      title: 'Server errors on proxy_host:7',
      issue: { ruleId: id, subjectKey: 'proxy_host:7' },
      actions: [
        { label: 'Open host', route: '/proxy-hosts/7' },
        { label: 'Show requests', route: expect.stringContaining('mail.example.com') },
      ],
    });
  });

  it('link only to the pages the reader may open, and leave out dismissed alerts', async () => {
    const id = await rule({ type: 'error_rate' });
    await firing(id, 'proxy_host:7', { domains: ['mail.example.com'] });
    const reader = await collectAttention(custom(['alerts:read', 'analytics:read']));
    expect(reader.items[0].actions.map((action) => action.label)).toEqual(['Show requests']);

    await ctx.db.insert(schema.alertSilences).values({ ruleId: id, subjectKey: 'proxy_host:7', until: null, createdAt: stamp() });
    expect((await collectAttention(builtInAccess(1, 'admin'))).items.filter((entry) => entry.source === 'alerts')).toEqual([]);
  });

  it('say whether anyone is notified', async () => {
    const id = await rule({ type: 'caddy_apply_failed' });
    expect((await collectAttention(builtInAccess(1, 'admin'))).notifying).toBe(false);
    const [channel] = await ctx.db.insert(schema.alertChannels).values({ name: 'Ops', type: 'ntfy', config: '{"serverUrl":"https://ntfy.sh","topic":"x"}', createdAt: stamp(), updatedAt: stamp() }).returning();
    await ctx.db.update(schema.alertRules).set({ channelIds: JSON.stringify([channel.id]) });
    expect((await collectAttention(builtInAccess(1, 'admin'))).notifying).toBe(true);
    expect((await collectAttention(custom(['certificates:read']))).notifying).toBeNull();
    expect(id).toBeGreaterThan(0);
  });

  it('supersede an older source while an enabled rule watches every host, for readers of the alerts only', async () => {
    const collect = vi.fn(async () => [{ id: 'expiring', severity: 'warning' as const, title: 'Old certificate item', detail: '', actions: [], at: null }]);
    registerAttentionProvider({ id: 'legacy-certificates', label: 'Certificates', permissions: ['certificates:read'], supersededBy: ['cert_expiring'], collect });
    try {
      const sources = async (access: Access) => (await collectAttention(access)).sources.map((source) => source.id);
      expect(await sources(builtInAccess(1, 'admin'))).toContain('legacy-certificates');

      const id = await rule({ type: 'cert_expiring' });
      expect(await sources(builtInAccess(1, 'admin'))).not.toContain('legacy-certificates');
      // Without alerts:read the reader sees no alert, so the older source stays.
      expect(await sources(custom(['certificates:read']))).toContain('legacy-certificates');
      // A rule limited to chosen hosts does not cover every certificate.
      await ctx.db.update(schema.alertRules).set({ scope: '{"type":"hosts","proxyHostIds":[1]}' });
      expect(await sources(builtInAccess(1, 'admin'))).toContain('legacy-certificates');
      await ctx.db.update(schema.alertRules).set({ scope: '{"type":"all"}', enabled: false });
      expect(await sources(builtInAccess(1, 'admin'))).toContain('legacy-certificates');
      expect(id).toBeGreaterThan(0);
    } finally {
      unregisterAttentionProvider('legacy-certificates');
    }
  });

  it('come from the registered alerts provider', () => {
    expect(alertsAttentionProvider.permissions).toEqual(['alerts:read']);
  });
});

describe('issue links', () => {
  it('lead to the page that deals with each kind of alert', () => {
    expect(issueLinks('cert_expiring', 'managed_certificate:a.example.com', {})).toEqual([{ label: 'View certificates', route: '/certificates', permission: 'certificates:read' }]);
    expect(issueLinks('upstream_down', 'upstream:10.0.0.5:8080', { upstream: '10.0.0.5:8080' })[0].route).toBe('/proxy-hosts?search=10.0.0.5%3A8080');
    expect(issueLinks('error_rate', 'hosts', {}).map((link) => link.label)).toEqual(['Show requests']);
    expect(issueLinks('approval_pending', 'change_request:7', {})[0].route).toBe('/approvals?request=7');
    expect(issueLinks('access_review_overdue', 'access_review:3', {})[0].route).toBe('/access-reviews/3');
    expect(issueLinks('caddy_apply_failed', 'caddy', {})[0]).toMatchObject({ route: '/history', permission: 'config_history:read' });
  });
});

describe('testing a channel before saving it', () => {
  it('sends a test to a new channel without saving it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const response = await testNewChannel(request('POST', { type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/services/T/B/draft-token' } }));
    expect(await response.json()).toEqual({ ok: true, error: null });
    expect(fetchSpy.mock.calls[0][0]).toBe('https://hooks.slack.com/services/T/B/draft-token');
    expect(await ctx.db.select().from(schema.alertChannels)).toEqual([]);
    // Invalid settings are reported like on save.
    expect((await testNewChannel(request('POST', { type: 'slack', config: {} }))).status).toBe(400);
  });

  it('tests the changes to a stored channel over its stored credentials, and saves nothing', async () => {
    const created = await (await createChannel(request('POST', { name: 'Ops', type: 'ntfy', config: { serverUrl: 'https://ntfy.sh', topic: 'old-topic', token: 'stored-token' } }))).json();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const result = await (await testChannel(request('POST', { config: { topic: 'new-topic' } }), params(created.id))).json();
    expect(result).toEqual({ ok: true, error: null });
    expect(String(fetchSpy.mock.calls[0][1]?.body)).toContain('new-topic');
    expect(JSON.stringify(fetchSpy.mock.calls[0][1]?.headers)).toContain('stored-token');
    const [row] = await ctx.db.select().from(schema.alertChannels);
    expect(row.config).toContain('old-topic');
    expect(row.lastDeliveryAt).toBeNull();
  });
});
