/**
 * The /api/v1/waf REST endpoints: rule exclusions CRUD, per-host modes,
 * events, explain and suggested exclusions, plus the tuning fields of
 * /api/v1/settings/waf and the OpenAPI document. Permission guards of every
 * handler are covered by custom-roles-route-guards.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  events: new Map<string, unknown>(),
}));

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

vi.mock('../../src/lib/models/waf-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/models/waf-events')>();
  return {
    ...actual,
    getWafEventByEventId: vi.fn(async (id: string) => ctx.events.get(id) ?? null),
    listWafEvents: vi.fn(async () => [...ctx.events.values()]),
    countWafEvents: vi.fn(async () => ctx.events.size),
  };
});

import * as schema from '../../src/lib/db/schema';
import { applyCaddyConfig } from '../../src/lib/caddy';
import { setSetting, getSetting } from '../../src/lib/settings';
import { GET as listExclusions, POST as createExclusion } from '../../app/api/v1/waf/exclusions/route';
import { GET as getExclusion, PATCH as patchExclusion, DELETE as deleteExclusion } from '../../app/api/v1/waf/exclusions/[id]/route';
import { POST as createExclusions } from '../../app/api/v1/waf/exclusions/batch/route';
import { GET as listHosts } from '../../app/api/v1/waf/hosts/route';
import { GET as getHost, PUT as putHost } from '../../app/api/v1/waf/hosts/[id]/route';
import { GET as listEvents } from '../../app/api/v1/waf/events/route';
import { GET as explainEvent } from '../../app/api/v1/waf/events/[id]/explain/route';
import { GET as suggestExclusion } from '../../app/api/v1/waf/events/[id]/suggested-exclusion/route';
import { PUT as putSettings } from '../../app/api/v1/settings/[group]/route';
import { GET as openapi } from '../../app/api/v1/openapi.json/route';

const now = () => new Date().toISOString();

function request(options: { method?: string; body?: unknown; search?: string; path?: string } = {}): any {
  const url = new URL(`http://localhost${options.path ?? '/api/v1/waf'}${options.search ? `?${options.search}` : ''}`);
  return {
    method: options.method ?? 'GET',
    headers: new Headers(),
    url: url.toString(),
    nextUrl: url,
    json: async () => {
      if (typeof options.body === 'string') return JSON.parse(options.body);
      return options.body;
    },
    text: async () => JSON.stringify(options.body ?? ''),
  };
}
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

async function insertHost(name: string, domain: string, meta: Record<string, unknown> | null = null): Promise<number> {
  const [row] = await ctx.db.insert(schema.proxyHosts).values({
    name,
    domains: JSON.stringify([domain]),
    upstreams: JSON.stringify(['backend:8080']),
    sslForced: false, hstsEnabled: false, hstsSubdomains: false, allowWebsocket: false, preserveHostHeader: false,
    skipHttpsHostnameValidation: false, meta: meta ? JSON.stringify(meta) : null, enabled: true, createdAt: now(), updatedAt: now(),
  }).returning();
  return row.id;
}

const RAW = JSON.stringify({
  transaction: {
    id: 'txAbc123',
    client_ip: '203.0.113.66',
    is_interrupted: true,
    request: { method: 'GET', uri: '/search?q=x', http_version: '2.0', headers: { host: ['app.example.com'] } },
  },
  messages: [
    {
      error_message:
        '[client "203.0.113.66"] Coraza: Warning. SQL Injection Attack Detected via libinjection [file "@owasp_crs/REQUEST-942-APPLICATION-ATTACK-SQLI.conf"] ' +
        '[line "1"] [id "942100"] [rev ""] [msg "SQL Injection Attack Detected via libinjection"] [data "Matched Data: 1&1 found within ARGS:q: 1 or 1=1"] ' +
        '[severity "critical"] [ver "OWASP_CRS/4.25.0"] [maturity "0"] [accuracy "0"] [tag "paranoia-level/1"] [tag "OWASP_CRS"] [hostname "10.0.0.2"] [uri "/search"] [unique_id "txAbc123"]',
    },
    {
      error_message:
        '[client "203.0.113.66"] Coraza: Access denied (phase 2). Inbound Anomaly Score Exceeded (Total Score: 5) [file "@owasp_crs/REQUEST-949-BLOCKING-EVALUATION.conf"] ' +
        '[line "2"] [id "949110"] [rev ""] [msg "Inbound Anomaly Score Exceeded (Total Score: 5)"] [data ""] [severity "unknown"] [ver "OWASP_CRS/4.25.0"] ' +
        '[maturity "0"] [accuracy "0"] [tag "anomaly-evaluation"] [tag "OWASP_CRS"] [hostname "10.0.0.2"] [uri "/search"] [unique_id "txAbc123"]',
    },
  ],
});

function event(eventId: string, rawData: string | null) {
  return {
    id: 1, eventId, ts: 1790938961, host: 'app.example.com:443', clientIp: '203.0.113.66', countryCode: null,
    method: 'GET', uri: '/search?q=x', ruleId: 942100, ruleMessage: 'SQL Injection Attack Detected via libinjection',
    severity: 'critical', rawData, blocked: true,
  };
}

let appId: number;

beforeEach(async () => {
  await ctx.db.delete(schema.wafRuleExclusions);
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.settings);
  ctx.events.clear();
  appId = await insertHost('App', 'app.example.com', { waf: { enabled: true, waf_mode: 'merge' } });
  vi.mocked(applyCaddyConfig).mockClear();
});

afterEach(() => {
  vi.mocked(applyCaddyConfig).mockReset();
  vi.mocked(applyCaddyConfig).mockResolvedValue({ ok: true } as never);
});

describe('exclusions', () => {
  it('creates, lists, changes and removes an exclusion, applying each change', async () => {
    const created = await createExclusion(request({
      method: 'POST',
      body: { ruleId: 942100, proxyHostId: appId, path: '/search', variable: 'ARGS:q', reason: 'Search accepts SQL-like text' },
    }));
    expect(created.status).toBe(201);
    const exclusion = await created.json();
    expect(exclusion).toMatchObject({ ruleId: 942100, scope: 'host', proxyHostId: appId, path: '/search', pathMatch: 'exact', variable: 'ARGS:q' });
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);

    const listed = await (await listExclusions(request({ search: `proxyHostId=${appId}` }))).json();
    expect(listed.exclusions.map((row: { id: number }) => row.id)).toEqual([exclusion.id]);
    expect((await (await listExclusions(request({ search: 'scope=global' }))).json()).exclusions).toEqual([]);

    const changed = await patchExclusion(request({ method: 'PATCH', body: { path: null, reason: 'Every search page' } }), params({ id: String(exclusion.id) }));
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ path: null, pathMatch: null, variable: 'ARGS:q', reason: 'Every search page' });

    expect((await getExclusion(request(), params({ id: String(exclusion.id) }))).status).toBe(200);
    expect((await deleteExclusion(request({ method: 'DELETE' }), params({ id: String(exclusion.id) }))).status).toBe(200);
    expect((await getExclusion(request(), params({ id: String(exclusion.id) }))).status).toBe(404);
  });

  it.each([
    [{ ruleId: 942100, proxyHostId: 1, rule: 1 }, /Unknown field: rule/],
    [{ ruleId: 'x' }, /ruleId must be an integer/],
    [{ ruleId: 949110 }, /decides whether a request is blocked/],
    [{ ruleId: 942100, path: '/a" "id:1,ctl:ruleEngine=Off' }, /path must/],
    [{ ruleId: 942100, path: '/a/../b' }, /\/\.\.\//],
    [{ ruleId: 942100, variable: 'ARGS:/.*/' }, /the name after ARGS/],
    [{ ruleId: 942100, pathMatch: 'exact' }, /pathMatch needs a path/],
    [{ ruleId: 942100, reason: 7 }, /reason must be a string/],
  ])('refuses %j', async (body, message) => {
    const response = await createExclusion(request({ method: 'POST', body }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(message);
    expect(await ctx.db.select().from(schema.wafRuleExclusions)).toEqual([]);
  });

  it('refuses a body that is not an object, a duplicate, an unknown host and bad ids', async () => {
    expect((await createExclusion(request({ method: 'POST', body: '[1]' }))).status).toBe(400);
    expect((await createExclusion(request({ method: 'POST', body: { ruleId: 913100 } }))).status).toBe(201);
    expect((await createExclusion(request({ method: 'POST', body: { ruleId: 913100 } }))).status).toBe(409);
    expect((await createExclusion(request({ method: 'POST', body: { ruleId: 913100, proxyHostId: 4242 } }))).status).toBe(404);
    expect((await getExclusion(request(), params({ id: 'abc' }))).status).toBe(400);
    expect((await listExclusions(request({ search: 'scope=everything' }))).status).toBe(400);
    expect((await patchExclusion(request({ method: 'PATCH', body: { proxyHostId: null } }), params({ id: '1' }))).status).toBe(400);
  });

  it('answers 502 and keeps nothing when Caddy refuses the configuration', async () => {
    vi.mocked(applyCaddyConfig).mockRejectedValueOnce(new Error('Caddy rejected configuration'));
    const response = await createExclusion(request({ method: 'POST', body: { ruleId: 942100, proxyHostId: appId } }));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatch(/change was undone/);
    expect(await ctx.db.select().from(schema.wafRuleExclusions)).toEqual([]);
  });
});

describe('several exclusions at once', () => {
  it('adds them with one apply, all or none', async () => {
    vi.mocked(applyCaddyConfig).mockClear();
    const body = { exclusions: [{ ruleId: 921150, proxyHostId: appId, path: '/api/traces', variable: 'ARGS_NAMES', reason: 'OTel' }, { ruleId: 932235, proxyHostId: appId, path: '/api/traces' }] };
    const response = await createExclusions(request({ method: 'POST', body }));
    expect(response.status).toBe(201);
    expect((await response.json()).exclusions.map((exclusion: { ruleId: number }) => exclusion.ruleId)).toEqual([921150, 932235]);
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);

    // One of them exists now: none of the batch is added.
    expect((await createExclusions(request({ method: 'POST', body: { exclusions: [{ ruleId: 942100 }, body.exclusions[1]] } }))).status).toBe(409);
    expect(await ctx.db.select().from(schema.wafRuleExclusions)).toHaveLength(2);
    for (const bad of [{}, { exclusions: 'x' }, { exclusions: [] }, { exclusions: [1] }, { exclusions: [{ ruleId: 942100, extra: 1 }] }, { exclusions: [], more: 1 }]) {
      expect((await createExclusions(request({ method: 'POST', body: bad }))).status, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe('per-host modes', () => {
  it('lists hosts with their mode and sets one, keeping the rest of their WAF settings', async () => {
    await setSetting('waf', { enabled: false, mode: 'On', load_owasp_crs: true, custom_directives: '' });
    const other = await insertHost('Other', 'other.example.com');
    const { hosts } = await (await listHosts(request())).json();
    expect(hosts.map((host: { name: string; mode: string; effectiveMode: string; configured: boolean }) => [host.name, host.mode, host.effectiveMode, host.configured])).toEqual([
      ['App', 'inherit', 'block', true],
      ['Other', 'inherit', 'off', false],
    ]);

    const response = await putHost(request({ method: 'PUT', body: { mode: 'detection_only' } }), params({ id: String(appId) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: appId, mode: 'detection_only', effectiveMode: 'detection_only', settings: 'merges' });
    const meta = JSON.parse((await ctx.db.select().from(schema.proxyHosts)).find((row) => row.id === appId)!.meta!);
    expect(meta.waf).toEqual({ enabled: true, waf_mode: 'merge', mode: 'DetectionOnly' });

    expect(await (await putHost(request({ method: 'PUT', body: { mode: 'off' } }), params({ id: String(appId) }))).json()).toMatchObject({ mode: 'off', effectiveMode: 'off', settings: 'off' });
    expect(await (await putHost(request({ method: 'PUT', body: { mode: 'inherit' } }), params({ id: String(other) }))).json()).toMatchObject({ mode: 'inherit', effectiveMode: 'block', configured: true });
    expect((await getHost(request(), params({ id: String(other) }))).status).toBe(200);
  });

  it('reads stored mode values of older releases', async () => {
    const legacyOff = await insertHost('Legacy off', 'legacy-off.example.com', { waf: { enabled: true, mode: 'Off' } });
    const legacyOn = await insertHost('Legacy on', 'legacy-on.example.com', { waf: { enabled: true, mode: 'On' } });
    expect(await (await getHost(request(), params({ id: String(legacyOff) }))).json()).toMatchObject({ mode: 'off', effectiveMode: 'off' });
    expect(await (await getHost(request(), params({ id: String(legacyOn) }))).json()).toMatchObject({ mode: 'block', effectiveMode: 'block' });
  });

  it('refuses unknown modes, fields and hosts', async () => {
    expect((await putHost(request({ method: 'PUT', body: { mode: 'On' } }), params({ id: String(appId) }))).status).toBe(400);
    expect((await putHost(request({ method: 'PUT', body: { mode: 'block', enabled: true } }), params({ id: String(appId) }))).status).toBe(400);
    expect((await putHost(request({ method: 'PUT', body: { mode: 'block' } }), params({ id: '4242' }))).status).toBe(404);
    expect((await getHost(request(), params({ id: '4242' }))).status).toBe(404);
  });
});

describe('events, explain and suggested exclusions', () => {
  it('lists events by Coraza transaction id without the raw record', async () => {
    ctx.events.set('txAbc123', event('txAbc123', RAW));
    const body = await (await listEvents(request())).json();
    expect(body.events).toEqual([expect.objectContaining({ id: 'txAbc123', ruleId: 942100, blocked: true })]);
    expect(body.events[0]).not.toHaveProperty('rawData');
    expect((await listEvents(request({ search: 'from=10' }))).status).toBe(400);
    expect((await listEvents(request({ search: 'from=20&to=10' }))).status).toBe(400);
    expect((await listEvents(request({ search: 'from=abc&to=10' }))).status).toBe(400);
  });

  it('explains an event with the host context and suggests the narrowest exclusion', async () => {
    ctx.events.set('txAbc123', event('txAbc123', RAW));
    await setSetting('waf', { enabled: true, mode: 'On', load_owasp_crs: true, custom_directives: '', inbound_anomaly_threshold: 5 });
    const response = await explainEvent(request(), params({ id: 'txAbc123' }));
    expect(response.status).toBe(200);
    const explanation = await response.json();
    expect(explanation).toMatchObject({
      eventId: 'txAbc123',
      blocked: true,
      inboundScore: 5,
      inboundThreshold: 5,
      decidingRule: { ruleId: 949110, blocked: true },
      event: { eventId: 'txAbc123', host: 'app.example.com:443' },
    });
    expect(explanation.event).not.toHaveProperty('rawData');
    expect(explanation.suggestions).toEqual([
      expect.objectContaining({ ruleId: 942100, proxyHostId: appId, hostName: 'App', path: '/search', variable: 'ARGS:q', existingExclusionId: null }),
    ]);

    const suggestion = explanation.suggestions[0];
    const created = await createExclusion(request({
      method: 'POST',
      body: { ruleId: suggestion.ruleId, proxyHostId: suggestion.proxyHostId, path: suggestion.path, pathMatch: suggestion.pathMatch, variable: suggestion.variable, reason: suggestion.reason },
    }));
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const again = await (await suggestExclusion(request(), params({ id: 'txAbc123' }))).json();
    expect(again).toEqual({ eventId: 'txAbc123', suggestions: [expect.objectContaining({ existingExclusionId: id })] });
  });

  it('answers 404 for an unknown event and 422 for an unreadable record', async () => {
    ctx.events.set('txBroken', event('txBroken', '{not json'));
    expect((await explainEvent(request(), params({ id: 'txMissing' }))).status).toBe(404);
    expect((await explainEvent(request(), params({ id: '../../etc' }))).status).toBe(404);
    const broken = await explainEvent(request(), params({ id: 'txBroken' }));
    expect(broken.status).toBe(422);
    expect((await suggestExclusion(request(), params({ id: 'txBroken' }))).status).toBe(422);
  });
});

describe('tuning through /api/v1/settings/waf', () => {
  const base = { enabled: true, mode: 'On', load_owasp_crs: true, custom_directives: '' };

  it('stores tuning values that differ from the defaults', async () => {
    const response = await putSettings(
      request({ method: 'PUT', body: { ...base, paranoia_level: 2, detection_paranoia_level: 3, inbound_anomaly_threshold: 5, outbound_anomaly_threshold: 8, anomaly_action: 'log' } }),
      params({ group: 'waf' })
    );
    expect(response.status).toBe(200);
    expect(await getSetting('waf')).toEqual({ ...base, paranoia_level: 2, detection_paranoia_level: 3, outbound_anomaly_threshold: 8, anomaly_action: 'log' });
  });

  it.each([
    [{ paranoia_level: 5 }, /paranoia_level/],
    [{ paranoia_level: 3, detection_paranoia_level: 2 }, /must not be lower/],
    [{ inbound_anomaly_threshold: 0 }, /inbound_anomaly_threshold/],
    [{ anomaly_action: 'drop' }, /anomaly_action/],
    [{ mode: 'Block' }, /waf.mode/],
  ])('refuses %j', async (fields, message) => {
    const response = await putSettings(request({ method: 'PUT', body: { ...base, ...fields } }), params({ group: 'waf' }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(message);
  });

  it('keeps exclusions when the list is left out and replaces whole-scope ones when it is sent', async () => {
    await createExclusion(request({ method: 'POST', body: { ruleId: 913100, reason: 'x' } }));
    await createExclusion(request({ method: 'POST', body: { ruleId: 942100, path: '/api/', reason: 'y' } }));
    expect((await putSettings(request({ method: 'PUT', body: base }), params({ group: 'waf' }))).status).toBe(200);
    expect((await ctx.db.select().from(schema.wafRuleExclusions)).map((row) => row.ruleId)).toEqual([913100, 942100]);
    expect(((await getSetting('waf')) as { excluded_rule_ids: number[] }).excluded_rule_ids).toEqual([913100]);

    expect((await putSettings(request({ method: 'PUT', body: { ...base, excluded_rule_ids: [920350] } }), params({ group: 'waf' }))).status).toBe(200);
    expect((await ctx.db.select().from(schema.wafRuleExclusions)).map((row) => row.ruleId).sort()).toEqual([920350, 942100]);
  });

  it('puts the exclusions back with the settings when Caddy refuses the change', async () => {
    await createExclusion(request({ method: 'POST', body: { ruleId: 913100, reason: 'x' } }));
    vi.mocked(applyCaddyConfig).mockRejectedValueOnce(new Error('refused'));
    const response = await putSettings(request({ method: 'PUT', body: { ...base, excluded_rule_ids: [] } }), params({ group: 'waf' }));
    expect(response.status).toBe(502);
    expect((await ctx.db.select().from(schema.wafRuleExclusions)).map((row) => row.ruleId)).toEqual([913100]);
  });
});

describe('OpenAPI', () => {
  it('documents every WAF endpoint with resolvable references', async () => {
    const spec = await (await openapi(request({ path: '/api/v1/openapi.json' }))).json();
    const operations: Record<string, string[]> = {
      '/api/v1/waf/exclusions': ['get', 'post'],
      '/api/v1/waf/exclusions/batch': ['post'],
      '/api/v1/waf/exclusions/{id}': ['get', 'patch', 'delete'],
      '/api/v1/waf/hosts': ['get'],
      '/api/v1/waf/hosts/{id}': ['get', 'put'],
      '/api/v1/waf/events': ['get'],
      '/api/v1/waf/events/{id}/explain': ['get'],
      '/api/v1/waf/events/{id}/suggested-exclusion': ['get'],
    };
    const tags = spec.tags.map((tag: { name: string }) => tag.name);
    for (const [path, methods] of Object.entries(operations)) {
      for (const method of methods) {
        const operation = spec.paths[path]?.[method];
        expect(operation, `${method} ${path}`).toBeDefined();
        expect(operation.operationId).toEqual(expect.any(String));
        for (const tag of operation.tags) expect(tags).toContain(tag);
      }
    }
    const documented = JSON.stringify([...Object.keys(operations).map((path) => spec.paths[path]), spec.components.schemas.WafSettings]);
    for (const [, kind, name] of documented.matchAll(/"\$ref":"#\/components\/([^/]+)\/([^"]+)"/g)) {
      expect(spec.components[kind]?.[name], `${kind}/${name}`).toBeDefined();
    }
    expect(Object.keys(spec.components.schemas.WafSettings.properties)).toEqual(expect.arrayContaining([
      'paranoia_level', 'detection_paranoia_level', 'inbound_anomaly_threshold', 'outbound_anomaly_threshold', 'anomaly_action',
    ]));
    expect(spec.components.schemas.WafConfig.properties.mode.enum).toEqual(['Off', 'On', 'DetectionOnly']);
  });
});
