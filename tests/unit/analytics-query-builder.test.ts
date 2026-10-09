/**
 * The analytics query builder: dimensions, metrics and groupings come from
 * fixed allow-lists, filter values are validated per dimension and only ever
 * reach ClickHouse as bound parameters, and nothing a caller sends ends up
 * in the SQL text.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ch = vi.hoisted(() => ({
  enabled: true,
  calls: [] as { query: string; query_params: Record<string, unknown> }[],
  rows: (() => []) as (query: string) => unknown[],
  fail: null as Error | null,
}));

vi.mock('@/src/lib/clickhouse/client', () => ({
  isAnalyticsEnabled: () => ch.enabled,
  getRetentionDays: () => 30,
  getClient: () => ({
    query: async (args: { query: string; query_params: Record<string, unknown> }) => {
      ch.calls.push(args);
      if (ch.fail) throw ch.fail;
      return { json: async () => ch.rows(args.query) };
    },
  }),
}));
vi.mock('@/src/lib/models/waf-events', () => ({ getWafRuleMessages: vi.fn().mockResolvedValue({ 920450: 'Restricted header' }) }));

import { buildFilterSql, MAX_FILTERS, parseFilters } from '@/src/lib/analytics/filters';
import { DIMENSIONS, METRIC_SQL, parseGrouping, parseMetric } from '@/src/lib/analytics/dimensions';
import { parseAnalyticsQuery, queryAnalytics } from '@/src/lib/analytics/query';
import { queryTopDimensions } from '@/src/lib/analytics/top';
import { queryRequestLog } from '@/src/lib/analytics/requests';
import { parseValueLimit, parseValueQuery, searchDimensionValues } from '@/src/lib/analytics/values';
import { queryHostWafRules } from '@/src/lib/analytics/security';
import { resolveRange } from '@/src/lib/analytics/range';
import { ApiValidationError } from '@/src/lib/api-errors';

const NOW = 1_791_000_000;

beforeEach(() => {
  ch.enabled = true;
  ch.calls = [];
  ch.rows = () => [];
  ch.fail = null;
});

describe('parseFilters', () => {
  it('accepts every dimension with a valid value', () => {
    const filters = parseFilters([
      { dim: 'host', op: 'is', value: 'app.example.com' },
      { dim: 'path', op: 'is_not', value: '/health' },
      { dim: 'country', value: 'it' },
      { dim: 'country', value: 'LAN' },
      { dim: 'asn', value: 'AS13335' },
      { dim: 'status', value: '5xx' },
      { dim: 'status', value: 404 },
      { dim: 'method', value: 'post' },
      { dim: 'protocol', value: 'HTTP/2.0' },
      { dim: 'ip', value: '2001:db8::1' },
      { dim: 'user_agent', value: 'Chrome · Windows' },
      { dim: 'outcome', op: 'is not', value: 'served' },
      { dim: 'waf_rule', value: '920450' },
    ]);
    expect(filters).toHaveLength(13);
    expect(filters[2]).toEqual({ dim: 'country', op: 'is', value: 'it' });
    expect(filters[11].op).toBe('is_not');
  });

  it('reads the JSON text of a query string parameter', () => {
    expect(parseFilters('[{"dim":"host","value":"example.com"}]')).toEqual([{ dim: 'host', op: 'is', value: 'example.com' }]);
    expect(parseFilters('')).toEqual([]);
    expect(parseFilters(undefined)).toEqual([]);
  });

  it.each([
    ['not JSON', '{nope'],
    ['not an array', '{"dim":"host"}'],
    ['an unknown dimension', [{ dim: 'uri; DROP TABLE traffic_events', value: 'x' }]],
    ['a column name that is not a dimension', [{ dim: 'client_ip', value: '192.0.2.1' }]],
    ['an unknown op', [{ dim: 'host', op: 'like', value: 'x' }]],
    ['an empty value', [{ dim: 'host', value: '' }]],
    ['an object value', [{ dim: 'host', value: { $ne: 1 } }]],
    ['a bad country', [{ dim: 'country', value: "IT' OR '1'='1" }]],
    ['a bad ASN', [{ dim: 'asn', value: '1 OR 1=1' }]],
    ['a bad status', [{ dim: 'status', value: '2xx OR 1' }]],
    ['a bad method', [{ dim: 'method', value: 'GET /' }]],
    ['a bad IP', [{ dim: 'ip', value: "1.2.3.4' --" }]],
    ['a bad outcome', [{ dim: 'outcome', value: 'blocked' }]],
    ['a bad rule id', [{ dim: 'waf_rule', value: '9e9' }]],
    ['a too long path', [{ dim: 'path', value: '/'.repeat(600) }]],
    ['too many filters', Array.from({ length: MAX_FILTERS + 1 }, (_, i) => ({ dim: 'path', value: `/${i}` }))],
  ])('refuses %s', (_label, input) => {
    expect(() => parseFilters(input)).toThrow(ApiValidationError);
  });

  it('drops exact duplicates', () => {
    expect(parseFilters([{ dim: 'host', value: 'a.example.com' }, { dim: 'host', value: 'a.example.com' }])).toHaveLength(1);
  });
});

describe('buildFilterSql', () => {
  it('binds every value and keeps them out of the SQL', () => {
    const hostile = "x' OR 1=1; DROP TABLE traffic_events --";
    const { sql, params } = buildFilterSql(parseFilters([
      { dim: 'host', value: hostile },
      { dim: 'path', op: 'is_not', value: hostile },
      { dim: 'user_agent', value: hostile },
    ]));
    expect(sql).not.toContain(hostile);
    expect(sql).not.toContain('DROP');
    expect(Object.values(params)).toEqual([hostile, hostile, hostile]);
    expect(sql).toMatch(/\{f0:String\}/);
  });

  it('matches any value of one dimension and excludes each is_not value', () => {
    const { sql, params } = buildFilterSql(parseFilters([
      { dim: 'host', value: 'a.example.com' },
      { dim: 'host', value: 'b.example.com' },
      { dim: 'status', value: '5xx' },
      { dim: 'status', value: '404' },
      { dim: 'country', op: 'is_not', value: 'XX' },
    ]));
    expect(sql.startsWith(
      '((host) = {f0:String} OR (host) = {f1:String}) AND ((intDiv(status, 100)) = {f2:UInt16} OR (status) = {f3:UInt16}) AND NOT ((multiIf('
    )).toBe(true);
    expect(sql.endsWith(') = {f4:String})')).toBe(true);
    expect(params).toEqual({ f0: 'a.example.com', f1: 'b.example.com', f2: 5, f3: 404, f4: 'XX' });
  });

  it('matches part of the text of host, path, user agent and address, any case', () => {
    const { sql, params } = buildFilterSql(parseFilters([
      { dim: 'path', op: 'contains', value: 'suggest' },
      { dim: 'path', op: 'is', value: '/' },
      { dim: 'host', op: 'not_contains', value: 'staging' },
    ]));
    expect(sql).toBe(
      "(positionCaseInsensitiveUTF8(splitByChar('?', uri)[1], {f0:String}) > 0 OR (splitByChar('?', uri)[1]) = {f1:String}) AND NOT (positionCaseInsensitiveUTF8(host, {f2:String}) > 0)"
    );
    expect(params).toEqual({ f0: 'suggest', f1: '/', f2: 'staging' });
    // The text is bound, never written into the SQL.
    expect(buildFilterSql(parseFilters([{ dim: 'path', op: 'contains', value: "x') OR 1=1 --" }])).sql).not.toContain('OR 1=1');
  });

  it('refuses "contains" on dimensions without text, and texts that are too long', () => {
    expect(() => parseFilters([{ dim: 'status', op: 'contains', value: '50' }])).toThrow(/cannot be matched by part of its text/);
    expect(() => parseFilters([{ dim: 'path', op: 'contains', value: 'x'.repeat(257) }])).toThrow(/at most 256/);
    expect(() => parseFilters([{ dim: 'path', op: 'starts_with', value: '/a' }])).toThrow(/op must be/);
    // A partial address is fine for "contains" (an exact address is required for "is").
    expect(parseFilters([{ dim: 'ip', op: 'contains', value: '192.0.2.' }])).toEqual([{ dim: 'ip', op: 'contains', value: '192.0.2.' }]);
  });

  it('normalises values for their column type', () => {
    const { params } = buildFilterSql(parseFilters([
      { dim: 'asn', value: 'as13335' },
      { dim: 'method', value: 'post' },
      { dim: 'country', value: 'de' },
      { dim: 'waf_rule', value: '941100' },
    ]));
    expect(params).toEqual({ f0: 13335, f1: 'POST', f2: 'DE', f3: 941100 });
  });

  it('is "1" without filters', () => {
    expect(buildFilterSql([])).toEqual({ sql: '1', params: {} });
  });
});

describe('metrics and groupings', () => {
  it('only accepts listed metrics and groupings', () => {
    expect(parseMetric(undefined)).toBe('requests');
    expect(parseMetric('bandwidth')).toBe('bytes');
    expect(() => parseMetric('sum(bytes_sent)')).toThrow(ApiValidationError);
    expect(parseGrouping(undefined, 'errors')).toBe('status');
    expect(parseGrouping('host', 'requests')).toBe('host');
    expect(() => parseGrouping('host; SELECT 1', 'requests')).toThrow(ApiValidationError);
    expect(Object.keys(METRIC_SQL).sort()).toEqual(['bytes', 'errors', 'mitigated', 'requests', 'visitors']);
  });

  it('validates the whole query before running it', () => {
    expect(() => parseAnalyticsQuery({ range: '2d' }, NOW)).toThrow(ApiValidationError);
    expect(() => parseAnalyticsQuery({ topHosts: 50 }, NOW)).toThrow(ApiValidationError);
    expect(() => parseAnalyticsQuery({ filters: '[{"dim":"nope","value":"x"}]' }, NOW)).toThrow(ApiValidationError);
  });
});

describe('queries sent to ClickHouse', () => {
  const hostile = "evil' OR 1=1 --";

  it('send filter values, the range and the host scope only as parameters', async () => {
    const query = parseAnalyticsQuery({ range: '24h', groupBy: 'host', filters: [{ dim: 'path', value: hostile }] }, NOW);
    ch.rows = (sql) => (sql.includes('LIMIT {p_top:UInt32}') ? [{ g: 'top.example.com' }] : []);
    const result = await queryAnalytics(query, NOW, ["scoped.example.com' OR 1=1"]);
    expect(result.status).toBe('ok');
    expect(ch.calls.length).toBeGreaterThanOrEqual(4);
    for (const call of ch.calls) {
      expect(call.query).not.toContain(hostile);
      expect(call.query).not.toContain('scoped.example.com');
      expect(call.query).not.toContain('top.example.com');
      expect(call.query).toContain('host IN {p_scope:Array(String)}');
      expect(call.query_params.p_scope).toEqual(["scoped.example.com' OR 1=1"]);
    }
    const grouped = ch.calls.find((call) => call.query.includes('p_top_hosts'))!;
    expect(grouped.query_params.p_top_hosts).toEqual(['top.example.com']);
  });

  it('match nothing for an empty scope and everything for no scope', async () => {
    await queryAnalytics(parseAnalyticsQuery({}, NOW), NOW, []);
    expect(ch.calls.every((call) => call.query.includes('AND 0 AND'))).toBe(true);
    ch.calls = [];
    await queryAnalytics(parseAnalyticsQuery({}, NOW), NOW);
    expect(ch.calls.some((call) => call.query.includes('p_scope'))).toBe(false);
  });

  it('keep values out of the top-list and request-log SQL too', async () => {
    const range = resolveRange({ range: '7d' }, NOW);
    const filters = parseFilters([{ dim: 'user_agent', value: hostile }, { dim: 'host', op: 'is_not', value: hostile }]);
    await queryTopDimensions({ range, filters, dimensions: [...DIMENSIONS], limit: 5 }, null);
    await queryRequestLog({ range, filters, limit: 10, offset: 0 });
    expect(ch.calls.length).toBeGreaterThan(DIMENSIONS.length);
    for (const call of ch.calls) {
      expect(call.query).not.toContain(hostile);
      expect(call.query_params.f0).toBe(hostile);
    }
  });

  it('degrade to empty data with an explicit status', async () => {
    ch.enabled = false;
    const disabled = await queryAnalytics(parseAnalyticsQuery({}, NOW), NOW);
    expect(disabled.status).toBe('disabled');
    expect(disabled.series).toEqual([]);
    expect(ch.calls).toHaveLength(0);

    ch.enabled = true;
    ch.fail = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const unavailable = await queryAnalytics(parseAnalyticsQuery({}, NOW), NOW);
    expect(unavailable.status).toBe('unavailable');
    expect(unavailable.totals).toHaveLength(48);
    const top = await queryTopDimensions({ range: resolveRange({}, NOW), filters: [], dimensions: ['host'], limit: 5 }, null);
    expect(top.status).toBe('unavailable');
  });
});

describe('searchDimensionValues', () => {
  it('finds the values of host, path, address and user agent containing the text, within the range and filters', async () => {
    ch.rows = (query) => (query.includes('splitByChar') ? [{ value: '/api/suggest', c: '42' }, { value: '/suggest', c: 7 }] : []);
    const result = await searchDimensionValues({
      range: resolveRange({ range: '24h' }, NOW),
      filters: parseFilters([{ dim: 'status', value: '5xx' }]),
      query: 'SUGGEST',
      limit: 5,
    });
    expect(result.status).toBe('ok');
    expect(result.dimensions.map((group) => group.dimension)).toEqual(['host', 'path', 'ip', 'user_agent']);
    expect(result.dimensions[1].values).toEqual([{ value: '/api/suggest', count: 42 }, { value: '/suggest', count: 7 }]);
    expect(ch.calls).toHaveLength(4);
    for (const call of ch.calls) {
      expect(call.query).toContain('positionCaseInsensitiveUTF8(');
      expect(call.query).not.toContain('SUGGEST');
      expect(call.query_params).toMatchObject({ p_q: 'SUGGEST', p_limit: 5, f0: 5 });
    }
  });

  it('validates the text and the limit', () => {
    expect(() => parseValueQuery('  ')).toThrow(/q is required/);
    expect(() => parseValueQuery('x'.repeat(257))).toThrow(/at most 256/);
    expect(parseValueQuery(' suggest ')).toBe('suggest');
    expect(parseValueLimit(undefined)).toBe(5);
    expect(() => parseValueLimit('9')).toThrow();
  });
});

describe('queryHostWafRules', () => {
  it("lists the rules that matched one host's names, most frequent first", async () => {
    ch.rows = () => [{ rule_id: 942100, events: '12', blocked_events: 3, message: 'SQL Injection', top_path: ['/search'] }];
    const result = await queryHostWafRules({ range: resolveRange({ range: '7d' }, NOW), domains: ['App.Example.com', '*.example.com'], limit: 5 });
    expect(result).toEqual({ status: 'ok', rules: [{ ruleId: 942100, message: 'SQL Injection', events: 12, blocked: 3, topPath: '/search' }] });
    // Wildcards are left out; the names are compared as stored (lowercase).
    expect(ch.calls[0].query_params).toMatchObject({ p_hosts: ['app.example.com'], p_limit: 5 });
    expect((await queryHostWafRules({ range: resolveRange({ range: '7d' }, NOW), domains: ['*.example.com'], limit: 5 })).rules).toEqual([]);
  });
});
