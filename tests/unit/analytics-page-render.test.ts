/**
 * Server render of the analytics page (app/(dashboard)/analytics): the first
 * paint for a URL (before any data arrives), the "analytics off" and
 * "access logging off" states, the headline tiles with data, the chart's
 * previous period without hidden series, and the request log escaping what
 * clients send.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnalyticsQueryResult, RequestLogEntry } from '@/src/lib/analytics';

const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/analytics',
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import AnalyticsClient, { KpiRow, chartData, type AnalyticsClientProps } from '@/app/(dashboard)/analytics/AnalyticsClient';
import { RequestLog } from '@/app/(dashboard)/analytics/RequestLog';

const PROPS: AnalyticsClientProps = {
  analyticsEnabled: true,
  loggingEnabled: true,
  retentionDays: 30,
  canReadSecurity: true,
  canReadSettings: true,
  isAdmin: false,
  hostSuggestions: ['app.example.com'],
};

function render(search: string, props: Partial<AnalyticsClientProps> = {}): string {
  nav.search = search;
  return renderToStaticMarkup(createElement(AnalyticsClient, { ...PROPS, ...props }));
}

const pressed = (html: string, label: string) => new RegExp(`aria-pressed="true"[^>]*>${label}<`).test(html);

describe('first paint', () => {
  it('shows the header, filters, chart frame, top lists and request log', () => {
    const html = render('');
    expect(html).toContain('>Analytics</h1>');
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain('aria-label="Time range"');
    expect(pressed(html, '24h')).toBe(true);
    expect(html).toContain('Compare to previous period');
    expect(html).toContain('Export CSV');
    // A search box finds values to filter by; the dimension menu is "More filters".
    expect(html).toContain('placeholder="Filter by host, path, IP or user agent…"');
    expect(html).toContain('More filters');
    expect(html).toContain('Save view');
    expect(html).toContain('Requests by outcome');
    expect(html).toContain('aria-label="Group by"');
    expect(html).toContain('Top dimensions');
    for (const title of ['Hosts', 'Paths', 'Countries', 'Source networks', 'Status codes', 'Source IPs', 'User agents', 'Methods', 'HTTP versions']) {
      expect(html).toContain(`>${title}</h3>`);
    }
    expect(html).toContain('id="analytics-log-title"');
    expect(html).not.toContain('kept for 30 days');
    expect(html).not.toContain('Traffic analytics is off');
    expect(html).not.toContain('Access logging is off');
  });

  it('reads the range, metric and filters from the URL', () => {
    const html = render('range=7d&metric=errors&filter=host%3Aapp.example.com&filter=%21country%3ACN');
    expect(pressed(html, '7d')).toBe(true);
    expect(pressed(html, '24h')).toBe(false);
    expect(html).toContain('Error responses by status class');
    expect(html).toContain('aria-label="Remove filter: Host is app.example.com"');
    expect(html).toContain('aria-label="Remove filter: Country is not CN"');
  });

  it('greys out the grouping when the metric has only one', () => {
    const html = render('metric=visitors');
    expect(html).toContain('Unique addresses</h2>');
    expect(html).toMatch(/aria-pressed="true" disabled=""[^>]*>Total</);
  });
});

describe('degraded states', () => {
  it('explains how to turn analytics on when ClickHouse is not configured', () => {
    const html = render('', { analyticsEnabled: false });
    expect(html).toContain('Traffic analytics is off');
    expect(html).toContain('CLICKHOUSE_PASSWORD');
    expect(html).toContain('COMPOSE_PROFILES');
    expect(html).toContain('href="/analytics/settings"');
    expect(html).not.toContain('Export CSV');
    expect(html).not.toContain('Top dimensions');
    expect(render('', { analyticsEnabled: false, canReadSettings: false })).not.toContain('href="/analytics/settings"');
  });

  it('warns when access logging is off', () => {
    const html = render('', { loggingEnabled: false });
    expect(html).toContain('Access logging is off.');
    expect(html).toContain('Turn it on in Analytics settings');
    expect(html).toContain('href="/analytics/settings#logging"');
    expect(render('', { loggingEnabled: false, canReadSettings: false })).not.toContain('Turn it on in Analytics settings');
  });
});

function result(patch: Partial<AnalyticsQueryResult> = {}): AnalyticsQueryResult {
  const start = Date.UTC(2026, 9, 3, 10, 0) / 1000;
  return {
    status: 'ok',
    range: { preset: '1h', start, end: start + 180, step: 60, buckets: 3 },
    metric: 'requests',
    groupBy: 'outcome',
    filters: [],
    series: [
      { key: 'served', label: 'Served', values: [10, 20, 30], total: 60 },
      { key: 'waf', label: 'Blocked by WAF', values: [1, 2, 3], total: 6 },
    ],
    totals: [11, 22, 33],
    previous: {
      available: true,
      start: start - 180,
      end: start,
      series: [
        { key: 'served', label: 'Served', values: [5, 5, 5], total: 15 },
        { key: 'waf', label: 'Blocked by WAF', values: [1, 1, 1], total: 3 },
      ],
      totals: [6, 6, 6],
    },
    headline: {
      requests: { value: 66, previous: 33, delta: 1 },
      bytes: { value: 1_500_000, previous: 1_500_000, delta: 0 },
      visitors: { value: 7, previous: 0, delta: null },
      mitigated: { value: 6, previous: 3, delta: 1, share: 6 / 66 },
      errorRate5xx: { value: 0.0023, previous: 0.01, delta: -0.77, count: 1 },
    },
    headlineSeries: { requests: [11, 22, 33], bytes: [1, 2, 3], visitors: [1, 2, 4], mitigated: [1, 2, 3], errors5xx: [0, 0, 1] },
    peak: { index: 2, ts: start + 120, value: 33 },
    peakMitigated: { index: 2, ts: start + 120, value: 3 },
    retention: { days: 30, start: start - 30 * 86_400 },
    ...patch,
  };
}

describe('headline tiles', () => {
  it('show each number with its change and select the chart metric', () => {
    const html = renderToStaticMarkup(createElement(KpiRow, { result: result(), metric: 'mitigated', rangeLabel: 'hour', onSelect: () => {} }));
    for (const label of ['Requests', 'Bandwidth', 'Unique addresses', 'Mitigated', '5xx error rate']) expect(html).toContain(label);
    expect(html).toContain('>66<');
    expect(html).toContain('1.5 MB');
    expect(html).toContain('0.23%');
    expect(html).toContain('▲ 100%');
    expect(html).toContain('up from 0');
    expect(html).toContain('9.1% of requests');
    expect(html).toContain('vs previous hour');
    // Fewer 5xx is good; more mitigated requests is not.
    expect(html).toMatch(/text-ok[^>]*>▼ 77%/);
    expect(html).toMatch(/text-bad[^>]*>▲ 100%/);
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
  });

  it('say when there is no earlier period', () => {
    const r = result({ previous: { available: false, reason: 'retention', start: 0, end: 0 } });
    r.headline.requests.previous = null;
    const html = renderToStaticMarkup(createElement(KpiRow, { result: r, metric: 'requests', rangeLabel: '30 days', onSelect: () => {} }));
    expect(html).toContain('No earlier data');
    expect(html).not.toContain('analytics keep');
  });
});

describe('chart data', () => {
  it('compares with the previous period of the shown series only', () => {
    const data = chartData(result(), ['waf']);
    expect(data.buckets).toEqual([0, 1, 2].map((i) => (Date.UTC(2026, 9, 3, 10, 0) / 1000 + i * 60) * 1000));
    expect(data.series.map((s) => [s.key, s.color])).toEqual([
      ['served', 'var(--served)'],
      ['waf', 'var(--waf)'],
    ]);
    expect(data.previous).toEqual([5, 5, 5]);
    expect(data.previousAll).toEqual([6, 6, 6]);
    expect(chartData(result({ previous: { available: false, reason: 'retention', start: 0, end: 0 } }), []).previous).toBeNull();
  });
});

describe('request log', () => {
  const entry = (patch: Partial<RequestLogEntry>): RequestLogEntry => ({
    ts: Date.UTC(2026, 9, 3, 11, 36, 2) / 1000,
    outcome: 'served',
    method: 'GET',
    host: 'app.example.com',
    path: '/',
    status: 200,
    country: 'IT',
    asn: 0,
    asOrg: '',
    ip: '203.0.113.24',
    userAgent: 'Chrome · Windows',
    durationMs: 3,
    bytes: 100,
    wafRuleId: 0,
    ...patch,
  });

  it('escapes what clients sent and names each outcome', () => {
    const html = renderToStaticMarkup(
      createElement(RequestLog, {
        rows: [
          entry({ outcome: 'waf', wafRuleId: 942100, path: '/<script>alert(1)</script>', userAgent: '<img src=x onerror="alert(1)">' }),
          entry({ outcome: 'geo' }),
        ],
        loading: false,
        error: null,
        withDay: false,
        hasMore: true,
        loadingMore: false,
        onMore: () => {},
        mitigatedOnly: false,
        onMitigatedOnlyChange: () => {},
      })
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('Blocked by WAF');
    expect(html).toContain('942100');
    expect(html).toContain('Geo rule');
    expect(html).toContain('11:36:02');
    expect(html).toContain('Show more');
  });

  it('folds a run of identical requests into one row, and links a WAF block to its events', () => {
    const html = renderToStaticMarkup(
      createElement(RequestLog, {
        rows: [
          entry({ path: '/poll', userAgent: '(none)' }),
          entry({ path: '/poll', userAgent: '(none)', ts: entry({}).ts - 1 }),
          entry({ path: '/poll', userAgent: '(none)', ts: entry({}).ts - 2 }),
          entry({ outcome: 'waf', wafRuleId: 920420, status: 403, method: 'POST', path: '/api/traces' }),
        ],
        loading: false,
        error: null,
        withDay: false,
        hasMore: false,
        loadingMore: false,
        onMore: () => {},
        mitigatedOnly: false,
        onMitigatedOnlyChange: () => {},
      })
    );
    expect(html.match(/<tr /g)).toHaveLength(3);
    expect(html).toContain('×3');
    expect(html).toContain('No user agent');
    expect(html).not.toContain('(none)');
    expect(html).toMatch(/href="\/security\?range=custom[^"]*kind=waf[^"]*"[^>]*>920420</);
  });

  it('says when nothing matches', () => {
    const html = renderToStaticMarkup(
      createElement(RequestLog, {
        rows: [],
        loading: false,
        error: null,
        withDay: true,
        hasMore: false,
        loadingMore: false,
        onMore: () => {},
        mitigatedOnly: true,
        onMitigatedOnlyChange: () => {},
      })
    );
    expect(html).toContain('No mitigated requests match the filters in this period.');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Mitigated only</);
  });
});
