/**
 * Alerting and AI analyst REST API: channels, rules, history and the AI
 * provider, validation and secret redaction.
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
import { GET as listChannels, POST as createChannel } from '../../app/api/v1/alert-channels/route';
import { GET as getChannel, PUT as updateChannel, DELETE as deleteChannel } from '../../app/api/v1/alert-channels/[id]/route';
import { POST as testChannel } from '../../app/api/v1/alert-channels/[id]/test/route';
import { GET as listRules, POST as createRule } from '../../app/api/v1/alert-rules/route';
import { GET as getRule, PUT as updateRule, DELETE as deleteRule } from '../../app/api/v1/alert-rules/[id]/route';
import { GET as listEvents } from '../../app/api/v1/alert-events/route';
import { GET as getAiSettings, PUT as putAiSettings, DELETE as deleteAiSettings } from '../../app/api/v1/ai/settings/route';
import { POST as testAi } from '../../app/api/v1/ai/test/route';
import { requireApiAdmin } from '../../src/lib/api-auth';
import { logAuditEvent } from '../../src/lib/audit';
import { setSetting, getSetting } from '../../src/lib/settings';
import { decryptSecret, isEncryptedSecret } from '../../src/lib/secret';
import { AI_SETTINGS_KEY } from '../../ee/ai/settings';
import { config } from '@/src/lib/config';

const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/slack-token-sentinel';
const SMTP_PASSWORD = 'smtp-password-sentinel';
const ROUTING_KEY = 'pagerdutyroutingkeysentinel0001';

function request(method: string, body?: unknown, search = ''): any {
  return {
    method,
    headers: { get: () => null },
    nextUrl: { pathname: '/api/v1/test', searchParams: new URLSearchParams(search) },
    json: async () => {
      if (body === undefined) throw new SyntaxError('no body');
      return body;
    },
  };
}

const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

const emailChannel = {
  name: 'Ops mail',
  type: 'email',
  config: { host: 'smtp.example.com', port: 587, user: 'alerts', password: SMTP_PASSWORD, from: 'alerts@example.com', to: ['ops@example.com'] },
};
const slackChannel = { name: 'Ops Slack', type: 'slack', config: { webhookUrl: SLACK_URL } };

async function create(route: typeof createChannel, body: unknown): Promise<{ status: number; data: any }> {
  const response = await route(request('POST', body));
  return { status: response.status, data: await response.json() };
}

beforeEach(async () => {
  for (const table of [schema.alertEvents, schema.alertRuleStates, schema.alertRules, schema.alertChannels, schema.settings]) {
    await ctx.db.delete(table);
  }
  vi.mocked(logAuditEvent).mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe('alert channels', () => {
  it('creates an e-mail channel and never returns the password', async () => {
    const { status, data } = await create(createChannel, emailChannel);
    expect(status).toBe(201);
    expect(data).toMatchObject({ name: 'Ops mail', type: 'email', enabled: true, config: { host: 'smtp.example.com', user: 'alerts', hasPassword: true, to: ['ops@example.com'] } });
    expect(JSON.stringify(data)).not.toContain(SMTP_PASSWORD);

    const [row] = await ctx.db.select().from(schema.alertChannels);
    expect(isEncryptedSecret(row.secrets!)).toBe(true);
    expect(row.secrets).not.toContain(SMTP_PASSWORD);
    expect(row.config).not.toContain(SMTP_PASSWORD);
    expect(JSON.parse(decryptSecret(row.secrets!))).toEqual({ password: SMTP_PASSWORD });
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'alert_channel_created', entityType: 'alert_channel' }));
    expect(JSON.stringify(vi.mocked(logAuditEvent).mock.calls)).not.toContain(SMTP_PASSWORD);
  });

  it.each([
    ['slack', { webhookUrl: SLACK_URL }],
    ['teams', { webhookUrl: 'https://prod.example.com/workflows/x/invoke?sig=teams-token' }],
    ['webhook', { url: 'https://hooks.example.com/alerts' }],
    ['pagerduty', { routingKey: ROUTING_KEY }],
    ['ntfy', { topic: 'ops-alerts' }],
  ])('creates a %s channel', async (type, config) => {
    const body = { name: `${type} channel`, type, config };
    const created = await create(createChannel, body);
    expect(created.status).toBe(201);
    expect(created.data.type).toBe(type);
  });

  it('redacts webhook URLs to scheme and host', async () => {
    const { data } = await create(createChannel, slackChannel);
    expect(data.config).toEqual({ hasWebhookUrl: true, webhookUrlHint: 'https://hooks.slack.com' });
    const listed = await (await listChannels(request('GET'))).json();
    const single = await (await getChannel(request('GET'), params(data.id))).json();
    for (const value of [data, listed, single]) {
      expect(JSON.stringify(value)).not.toContain('slack-token-sentinel');
    }
  });

  it('renames, disables, enables and deletes a channel', async () => {
    const { data } = await create(createChannel, slackChannel);
    const renamed = await updateChannel(request('PUT', { name: 'Renamed' }), params(data.id));
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).name).toBe('Renamed');

    const disabled = await updateChannel(request('PUT', { enabled: false }), params(data.id));
    expect(disabled.status).toBe(200);
    expect((await disabled.json()).enabled).toBe(false);
    const enabled = await updateChannel(request('PUT', { enabled: true }), params(data.id));
    expect(enabled.status).toBe(200);
    expect((await enabled.json()).enabled).toBe(true);

    expect((await deleteChannel(request('DELETE'), params(data.id))).status).toBe(204);
    expect(await ctx.db.select().from(schema.alertChannels)).toHaveLength(0);
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'alert_channel_deleted' }));
  });

  it('updates an e-mail channel, keeping or replacing the password', async () => {
    const { data } = await create(createChannel, emailChannel);
    const renamed = await updateChannel(request('PUT', { name: 'Renamed', config: { to: ['a@example.com', 'b@example.com'] } }), params(data.id));
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ name: 'Renamed', config: { hasPassword: true, to: ['a@example.com', 'b@example.com'] } });
    let [row] = await ctx.db.select().from(schema.alertChannels);
    expect(JSON.parse(decryptSecret(row.secrets!)).password).toBe(SMTP_PASSWORD);

    // A stored password is never sent to a different server without being entered again.
    const moved = await updateChannel(request('PUT', { config: { host: 'smtp.attacker.example' } }), params(data.id));
    expect(moved.status).toBe(400);
    expect((await moved.json()).error).toMatch(/Enter password again/);

    const cleared = await updateChannel(request('PUT', { config: { host: 'smtp2.example.com', password: null } }), params(data.id));
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).config.hasPassword).toBe(false);
    [row] = await ctx.db.select().from(schema.alertChannels);
    expect(row.secrets).toBeNull();
  });

  it('refuses to change the type of a channel', async () => {
    const { data } = await create(createChannel, emailChannel);
    const response = await updateChannel(request('PUT', { type: 'slack' }), params(data.id));
    expect(response.status).toBe(400);
  });

  it.each([
    ['an unknown type', { name: 'x', type: 'sms', config: {} }],
    ['a missing name', { type: 'email', config: emailChannel.config }],
    ['a missing recipient', { name: 'x', type: 'email', config: { ...emailChannel.config, to: [] } }],
    ['a bad sender', { name: 'x', type: 'email', config: { ...emailChannel.config, from: 'not-an-address' } }],
    ['a sender with an empty domain label', { name: 'x', type: 'email', config: { ...emailChannel.config, from: 'alerts@example..com' } }],
    ['an unknown config field', { name: 'x', type: 'email', config: { ...emailChannel.config, bcc: 'x@example.com' } }],
    ['a bad port', { name: 'x', type: 'email', config: { ...emailChannel.config, port: 70000 } }],
    ['an array body', []],
  ])('rejects %s with 400', async (_label, body) => {
    expect((await create(createChannel, body)).status).toBe(400);
  });

  it.each([
    ['a plain-http Slack URL', 'slack', { webhookUrl: 'http://hooks.slack.com/services/x' }],
    ['a URL with credentials', 'webhook', { url: 'https://user:pass@hooks.example.com/' }],
    ['a link-local webhook URL', 'webhook', { url: 'http://169.254.169.254/latest/meta-data/' }],
    ["a webhook URL at Caddy's admin API", 'webhook', { url: `${new URL(config.caddyApiUrl).origin}/stop` }],
    ['an ntfy server on a link-local address', 'ntfy', { serverUrl: 'http://[fe80::1]', topic: 'ops' }],
    ['a missing webhook URL', 'webhook', {}],
    ['a malformed routing key', 'pagerduty', { routingKey: 'bad key!' }],
    ['a bad ntfy topic', 'ntfy', { topic: 'no spaces allowed' }],
  ])('validates %s (400)', async (_label, type, config) => {
    const { status, data } = await create(createChannel, { name: 'x', type, config });
    expect(status).toBe(400);
    expect(JSON.stringify(data)).not.toContain('user:pass');
  });

  it('rejects a body that is not JSON', async () => {
    expect((await createChannel(request('POST'))).status).toBe(400);
  });

  it('returns 404 for unknown channels', async () => {
    expect((await getChannel(request('GET'), params(999))).status).toBe(404);
    expect((await updateChannel(request('PUT', { name: 'x' }), params(999))).status).toBe(404);
    expect((await deleteChannel(request('DELETE'), params(999))).status).toBe(404);
  });

  it('refuses to delete a channel a rule still notifies (409)', async () => {
    const { data: channel } = await create(createChannel, emailChannel);
    await create(createRule, { name: 'Certs', type: 'cert_expiring', channelIds: [channel.id] });
    const response = await deleteChannel(request('DELETE'), params(channel.id));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('"Certs"');
  });

  it('sends a test notification and reports failures without the URL', async () => {
    const { data } = await create(createChannel, slackChannel);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const ok = await (await testChannel(request('POST'), params(data.id))).json();
    expect(ok).toEqual({ ok: true, error: null });
    expect(fetchSpy.mock.calls[0][0]).toBe(SLACK_URL);
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)).text).toContain('Test notification');

    fetchSpy.mockResolvedValueOnce(new Response('invalid_token for ' + SLACK_URL, { status: 403 }));
    const failed = await (await testChannel(request('POST'), params(data.id))).json();
    expect(failed).toEqual({ ok: false, error: 'The endpoint answered with HTTP 403' });

    fetchSpy.mockRejectedValueOnce(new TypeError(`fetch failed ${SLACK_URL}`, { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) }));
    const unreachable = await (await testChannel(request('POST'), params(data.id))).json();
    expect(unreachable).toEqual({ ok: false, error: 'Could not reach the endpoint (ECONNREFUSED)' });

    const channels = await (await listChannels(request('GET'))).json();
    expect(channels[0].lastDeliveryError).toBe('Could not reach the endpoint (ECONNREFUSED)');
    expect(JSON.stringify(channels)).not.toContain('slack-token-sentinel');
  });

  it('requires an administrator', async () => {
    const { ApiAuthError } = await import('../../src/lib/api-auth');
    vi.mocked(requireApiAdmin).mockRejectedValueOnce(new ApiAuthError('Administrator privileges required', 403));
    expect((await listChannels(request('GET'))).status).toBe(403);
  });
});

describe('alert rules', () => {
  async function emailChannelId(): Promise<number> {
    return (await create(createChannel, emailChannel)).data.id;
  }

  it('creates a certificate-expiry rule that notifies e-mail', async () => {
    const channelId = await emailChannelId();
    const { status, data } = await create(createRule, { name: 'Certs', type: 'cert_expiring', params: { days: 21 }, channelIds: [channelId] });
    expect(status).toBe(201);
    expect(data).toMatchObject({
      type: 'cert_expiring',
      params: { days: 21, includeClientCertificates: true },
      channelIds: [channelId],
      cooldownMinutes: 60,
      notifyOnResolve: true,
      explain: false,
      firing: [],
    });
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'alert_rule_created' }));
  });

  it.each(['upstream_down', 'waf_spike', 'instance_sync_failed', 'caddy_apply_failed', 'backup_failed'])('creates a %s rule', async (type) => {
    const created = await create(createRule, { name: type, type });
    expect(created.status).toBe(201);
    expect(created.data.type).toBe(type);
  });

  it('turns explanations on, on create and when changed', async () => {
    const channelId = await emailChannelId();
    const { status, data: explainedAtOnce } = await create(createRule, { name: 'Certs now', type: 'cert_expiring', channelIds: [channelId], explain: true });
    expect(status).toBe(201);
    expect(explainedAtOnce.explain).toBe(true);
    const { data: rule } = await create(createRule, { name: 'Certs', type: 'cert_expiring', channelIds: [channelId] });
    const renamed = await updateRule(request('PUT', { name: 'Certificates', params: { days: 7 } }), params(rule.id));
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ name: 'Certificates', params: { days: 7, includeClientCertificates: true } });

    const explained = await updateRule(request('PUT', { explain: true }), params(rule.id));
    expect(explained.status).toBe(200);
    expect((await explained.json()).explain).toBe(true);
  });

  it('changes, disables, enables and deletes a rule', async () => {
    const { data: rule } = await create(createRule, { name: 'WAF', type: 'waf_spike', params: { threshold: 10, windowMinutes: 5 }, explain: true });
    expect((await listRules(request('GET'))).status).toBe(200);
    expect((await getRule(request('GET'), params(rule.id))).status).toBe(200);
    const changed = await updateRule(request('PUT', { params: { threshold: 20 } }), params(rule.id));
    expect(changed.status).toBe(200);
    expect((await changed.json()).params).toEqual({ threshold: 20, windowMinutes: 5 });

    const quiet = await updateRule(request('PUT', { explain: false }), params(rule.id));
    expect(quiet.status).toBe(200);
    expect((await quiet.json()).explain).toBe(false);
    const disabled = await updateRule(request('PUT', { enabled: false }), params(rule.id));
    expect(disabled.status).toBe(200);
    expect((await disabled.json()).enabled).toBe(false);
    const enabled = await updateRule(request('PUT', { enabled: true }), params(rule.id));
    expect(enabled.status).toBe(200);
    expect((await enabled.json()).enabled).toBe(true);
    expect((await deleteRule(request('DELETE'), params(rule.id))).status).toBe(204);
    expect(await ctx.db.select().from(schema.alertRules)).toHaveLength(0);
  });

  it('frees a channel once no rule notifies it', async () => {
    const { data: slack } = await create(createChannel, slackChannel);
    const { data: rule } = await create(createRule, { name: 'Certs', type: 'cert_expiring', channelIds: [slack.id] });
    expect((await deleteChannel(request('DELETE'), params(slack.id))).status).toBe(409);
    expect((await updateRule(request('PUT', { channelIds: [] }), params(rule.id))).status).toBe(200);
    expect((await deleteChannel(request('DELETE'), params(slack.id))).status).toBe(204);
  });

  it('ignores stored rules of a type that no longer exists, but lets them be deleted', async () => {
    const now = new Date().toISOString();
    const [row] = await ctx.db
      .insert(schema.alertRules)
      .values({ name: 'Old rule', type: 'license_expiring', enabled: true, params: '{"days":30}', channelIds: '[]', createdAt: now, updatedAt: now })
      .returning();
    expect(await (await listRules(request('GET'))).json()).toEqual([]);
    expect((await getRule(request('GET'), params(row.id))).status).toBe(404);
    expect((await updateRule(request('PUT', { name: 'x' }), params(row.id))).status).toBe(404);
    expect((await deleteRule(request('DELETE'), params(row.id))).status).toBe(204);
    expect(await ctx.db.select().from(schema.alertRules)).toHaveLength(0);
  });

  it('deletes a rule with its state but not its history', async () => {
    const channelId = await emailChannelId();
    const { data: rule } = await create(createRule, { name: 'Certs', type: 'cert_expiring', channelIds: [channelId] });
    const now = new Date().toISOString();
    await ctx.db.insert(schema.alertRuleStates).values({ ruleId: rule.id, subjectKey: 'certificate:1', status: 'firing', lastEvaluatedAt: now });
    await ctx.db.insert(schema.alertEvents).values({
      ruleId: rule.id, ruleName: 'Certs', ruleType: 'cert_expiring', subjectKey: 'certificate:1', status: 'firing',
      severity: 'warning', title: 't', message: 'm', createdAt: now,
    });
    expect((await deleteRule(request('DELETE'), params(rule.id))).status).toBe(204);
    expect(await ctx.db.select().from(schema.alertRules)).toHaveLength(0);
    expect(await ctx.db.select().from(schema.alertRuleStates)).toHaveLength(0);
    expect(await ctx.db.select().from(schema.alertEvents)).toHaveLength(1);
  });

  it.each([
    ['days out of range', { name: 'x', type: 'cert_expiring', params: { days: 0 } }],
    ['an unknown parameter', { name: 'x', type: 'cert_expiring', params: { hours: 3 } }],
    ['a channel that does not exist', { name: 'x', type: 'cert_expiring', channelIds: [12345] }],
    ['non-numeric channel ids', { name: 'x', type: 'cert_expiring', channelIds: ['1'] }],
    ['a negative cooldown', { name: 'x', type: 'cert_expiring', cooldownMinutes: -1 }],
    ['an unknown type', { name: 'x', type: 'disk_full' }],
    ['an unknown field', { name: 'x', type: 'cert_expiring', severity: 'high' }],
  ])('rejects %s with 400', async (_label, body) => {
    expect((await create(createRule, body)).status).toBe(400);
  });

  it('validates rule parameters', async () => {
    expect((await create(createRule, { name: 'x', type: 'waf_spike', params: { threshold: 10, windowMinutes: 2000 } })).status).toBe(400);
    const { data: rule } = await create(createRule, { name: 'x', type: 'waf_spike' });
    expect(rule.params).toEqual({ threshold: 100, windowMinutes: 15 });
    expect((await updateRule(request('PUT', { type: 'upstream_down' }), params(rule.id))).status).toBe(400);
  });
});

describe('alert history', () => {
  it('pages events newest first and filters by rule', async () => {
    for (let i = 0; i < 5; i += 1) {
      await ctx.db.insert(schema.alertEvents).values({
        ruleId: i % 2 === 0 ? 1 : 2, ruleName: `rule ${i}`, ruleType: 'cert_expiring', subjectKey: `s${i}`, status: 'firing',
        severity: 'warning', title: `event ${i}`, message: 'm', createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
        deliveries: JSON.stringify([{ channelId: 3, channelName: 'Ops', ok: false, error: 'The endpoint answered with HTTP 500' }]),
        notified: true,
      });
    }
    const page = await (await listEvents(request('GET', undefined, 'page=1&per_page=2'))).json();
    expect(page).toMatchObject({ total: 5, page: 1, perPage: 2 });
    expect(page.events.map((event: { title: string }) => event.title)).toEqual(['event 4', 'event 3']);
    expect(page.events[0].deliveries).toEqual([{ channelId: 3, channelName: 'Ops', ok: false, error: 'The endpoint answered with HTTP 500' }]);
    const filtered = await (await listEvents(request('GET', undefined, 'rule_id=2'))).json();
    expect(filtered.total).toBe(2);
    expect((await listEvents(request('GET', undefined, 'rule_id=abc'))).status).toBe(400);
  });
});

describe('AI settings', () => {
  const API_KEY = 'sk-ant-api-key-sentinel';

  it('is readable and redacted', async () => {
    const response = await getAiSettings(request('GET'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: false, provider: null, hasApiKey: false, timeoutSeconds: 60, configured: false, defaultModel: 'claude-opus-5' });
  });

  it('can be switched off and removed', async () => {
    // Switching off a provider that was never set up changes nothing.
    expect(await (await putAiSettings(request('PUT', { enabled: false }))).json()).toMatchObject({ provider: null, configured: false });
    expect(await getSetting(AI_SETTINGS_KEY)).toBeNull();

    await putAiSettings(request('PUT', { provider: 'anthropic', apiKey: API_KEY }));
    const off = await putAiSettings(request('PUT', { enabled: false, apiKey: null }));
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ enabled: false, hasApiKey: false, configured: false });
    expect((await getSetting<{ apiKey?: string }>(AI_SETTINGS_KEY))?.apiKey).toBeUndefined();

    expect((await putAiSettings(request('PUT', { provider: null, model: 'x' }))).status).toBe(400);
    const removed = await putAiSettings(request('PUT', { provider: null }));
    expect(removed.status).toBe(200);
    expect((await removed.json()).provider).toBeNull();
    expect(await getSetting(AI_SETTINGS_KEY)).toBeNull();
  });

  it('is removed by DELETE', async () => {
    await putAiSettings(request('PUT', { provider: 'anthropic', apiKey: API_KEY }));
    expect((await deleteAiSettings(request('DELETE'))).status).toBe(204);
    expect(await getSetting(AI_SETTINGS_KEY)).toBeNull();
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'ai_settings_removed' }));
    expect((await getAiSettings(request('GET'))).status).toBe(200);
  });

  it('stores the key encrypted, never returns it and defaults the Anthropic model', async () => {
    const response = await putAiSettings(request('PUT', { provider: 'anthropic', apiKey: API_KEY }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ enabled: true, provider: 'anthropic', model: 'claude-opus-5', baseUrl: null, hasApiKey: true, timeoutSeconds: 60, configured: true, defaultModel: 'claude-opus-5' });
    expect(JSON.stringify(data)).not.toContain(API_KEY);
    const stored = await getSetting<{ apiKey: string }>(AI_SETTINGS_KEY);
    expect(isEncryptedSecret(stored!.apiKey)).toBe(true);
    expect(decryptSecret(stored!.apiKey)).toBe(API_KEY);
    expect(JSON.stringify(vi.mocked(logAuditEvent).mock.calls)).not.toContain(API_KEY);
  });

  it('never moves a stored key to another provider or base URL', async () => {
    await putAiSettings(request('PUT', { provider: 'anthropic', apiKey: API_KEY }));
    const moved = await putAiSettings(request('PUT', { provider: 'openai_compatible', model: 'llama3.1', baseUrl: 'http://ollama:11434/v1' }));
    expect(moved.status).toBe(400);
    expect((await moved.json()).error).toMatch(/Enter the API key again/);

    const keyless = await putAiSettings(request('PUT', { provider: 'openai_compatible', model: 'llama3.1', baseUrl: 'http://ollama:11434/v1/', apiKey: null }));
    expect(keyless.status).toBe(200);
    expect(await keyless.json()).toMatchObject({ provider: 'openai_compatible', baseUrl: 'http://ollama:11434/v1', hasApiKey: false, configured: true });

    await putAiSettings(request('PUT', { apiKey: 'local-key' }));
    const rebased = await putAiSettings(request('PUT', { baseUrl: 'http://elsewhere.example:8000/v1' }));
    expect(rebased.status).toBe(400);
  });

  it.each([
    ['an unknown provider', { provider: 'gemini', apiKey: 'x' }],
    ['anthropic without a key', { provider: 'anthropic' }],
    ['openai_compatible without a base URL', { provider: 'openai_compatible', model: 'llama3.1' }],
    ['openai_compatible without a model', { provider: 'openai_compatible', baseUrl: 'http://ollama:11434/v1' }],
    ['a base URL for anthropic', { provider: 'anthropic', apiKey: 'x', baseUrl: 'https://proxy.example.com' }],
    ['a model with spaces', { provider: 'anthropic', apiKey: 'x', model: 'claude opus' }],
    ['an unknown field', { provider: 'anthropic', apiKey: 'x', temperature: 1 }],
    ['a timeout under 5 seconds', { provider: 'anthropic', apiKey: 'x', timeoutSeconds: 4 }],
    ['a timeout over 300 seconds', { provider: 'anthropic', apiKey: 'x', timeoutSeconds: 301 }],
    ['a fractional timeout', { provider: 'anthropic', apiKey: 'x', timeoutSeconds: 30.5 }],
    ['a timeout as text', { provider: 'anthropic', apiKey: 'x', timeoutSeconds: '60' }],
  ])('rejects %s', async (_label, body) => {
    expect((await putAiSettings(request('PUT', body))).status).toBe(400);
  });

  it('stores the timeout, keeps it when omitted and reads 60 for settings saved without one', async () => {
    const saved = await putAiSettings(request('PUT', { provider: 'openai_compatible', model: 'qwen3', baseUrl: 'http://llm.example.com/v1', timeoutSeconds: 240 }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ timeoutSeconds: 240 });
    expect(await getSetting(AI_SETTINGS_KEY)).toMatchObject({ timeoutSeconds: 240 });
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'ai_settings_updated', data: expect.objectContaining({ timeoutSeconds: 240 }) }));

    expect(await (await putAiSettings(request('PUT', { model: 'qwen3:32b' }))).json()).toMatchObject({ model: 'qwen3:32b', timeoutSeconds: 240 });
    const tooShort = await putAiSettings(request('PUT', { timeoutSeconds: 4 }));
    expect(tooShort.status).toBe(400);
    expect((await tooShort.json()).error).toBe('timeoutSeconds must be a whole number from 5 to 300');

    await setSetting(AI_SETTINGS_KEY, { enabled: true, provider: 'openai_compatible', model: 'qwen3', baseUrl: 'http://llm.example.com/v1' });
    expect(await (await getAiSettings(request('GET'))).json()).toMatchObject({ timeoutSeconds: 60, configured: true });
    expect(await (await putAiSettings(request('PUT', { model: 'qwen3:14b' }))).json()).toMatchObject({ timeoutSeconds: 60 });
  });

  it('reports a test that runs out of time with the timeout and where to raise it', async () => {
    await putAiSettings(request('PUT', { provider: 'openai_compatible', model: 'qwen3', baseUrl: 'http://llm.example.com/v1', timeoutSeconds: 90 }));
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'));
    expect(await (await testAi(request('POST'))).json()).toEqual({
      ok: false,
      explanation: null,
      error: 'The model did not answer within 90 seconds. A slower model needs a longer timeout (AI settings).',
    });
  });

  it('tests the configured provider with a sample alert', async () => {
    expect((await testAi(request('POST'))).status).toBe(400);
    await putAiSettings(request('PUT', { provider: 'openai_compatible', model: 'llama3.1', baseUrl: 'http://ollama:11434/v1' }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'The certificate expires soon. Renew it.' } }] }), { status: 200 })
    );
    const result = await (await testAi(request('POST'))).json();
    expect(result).toEqual({ ok: true, explanation: 'The certificate expires soon. Renew it.', error: null });
    expect(fetchSpy.mock.calls[0][0]).toBe('http://ollama:11434/v1/chat/completions');

    fetchSpy.mockResolvedValueOnce(new Response('{"error":"model not found"}', { status: 404 }));
    expect(await (await testAi(request('POST'))).json()).toEqual({ ok: false, explanation: null, error: 'The provider answered with HTTP 404' });
  });
});
