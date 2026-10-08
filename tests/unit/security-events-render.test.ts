/**
 * Server-side render of the Security events page (/security): the rule set
 * strip, the mitigated summary and its tiles, the peak explanation, the top
 * rules and sources with their actions (disabled with the reason for roles
 * that may not use them), the event list with its filters, and the
 * analytics-off and ClickHouse-down states.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/security',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(dashboard)/waf/actions', () => ({ createWafExclusionAction: vi.fn(), explainWafEventAction: vi.fn() }));
vi.mock('@/ee/ai/ui/tuning-actions', () => ({
  generateTuningSuggestionsAction: vi.fn(),
  applyTuningSuggestionAction: vi.fn(),
  dismissTuningSuggestionAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/access-lists/actions', () => ({ blockSourceAction: vi.fn() }));
vi.mock('@/app/(dashboard)/security/actions', () => ({ wafAuditRecordAction: vi.fn() }));

import SecurityClient from '@/app/(dashboard)/security/SecurityClient';
import type { SecurityPageData } from '@/app/(dashboard)/security/security-types';

const START = 1_790_424_000;
const STEP = 10_800;

function data(overrides: Partial<SecurityPageData> = {}): SecurityPageData {
  const waf = Array.from({ length: 56 }, (_, i) => (i === 41 ? 557 : i % 5));
  const geo = Array.from({ length: 56 }, (_, i) => (i === 41 ? 320 : 1));
  return {
    now: START + 56 * STEP,
    query: { range: null, from: null, to: null, kind: null, filters: [], page: 1 },
    range: { preset: '7d', start: START, end: START + 56 * STEP, step: STEP, buckets: 56, label: 'last 7 days', previousLabel: 'the week before' },
    rangeError: null,
    status: 'ok',
    ruleSet: { crsLoaded: true, crsVersion: '4.25', paranoiaLevel: 1, inboundThreshold: 5, blocking: 7, detecting: 1, hosts: 9, exclusions: 3 },
    summary: { mitigated: 9506, requests: 520_000, share: 9506 / 520_000, previousMitigated: 15_100, bySource: { waf: 5206, geo: 4300, access: 0, auth: 0, rate_limit: 0 } },
    series: [
      { key: 'waf', values: waf },
      { key: 'geo', values: geo },
    ],
    peak: {
      index: 41,
      ts: START + 41 * STEP,
      value: 877,
      bySource: { waf: 557, geo: 320 },
      top: {
        addresses: 37,
        source: { ip: '198.51.100.77', country: 'DE', count: 462 },
        host: { name: 'app.example.com', count: 690 },
        rule: { ruleId: 930130, message: 'Restricted file access attempt', count: 410 },
      },
    },
    rules: {
      matched: 28,
      events: 5206,
      list: [
        {
          ruleId: 930130, message: 'Restricted file access attempt', severity: 'CRITICAL', events: 2183, blocked: 2183, sources: 40,
          hostCount: 4, pathCount: 5, hosts: [{ host: 'app.example.com', count: 1500 }],
          paths: [{ path: '/.git/config', count: 900 }, { path: '/.env', count: 800 }, { path: '/.env.local', count: 300 }],
          sparkline: [1, 2, 3, 9, 2], category: 'File access', exclusionHostId: null,
        },
        {
          ruleId: 920450, message: 'HTTP header is restricted by policy', severity: 'CRITICAL', events: 1086, blocked: 1000, sources: 12,
          hostCount: 1, pathCount: 1, hosts: [{ host: 'app.example.com', count: 1086 }], paths: [{ path: '/', count: 1086 }],
          sparkline: [0, 0, 5], category: 'Protocol', exclusionHostId: 4,
        },
      ],
    },
    sources: {
      total: 107,
      list: [
        { ip: '198.51.100.77', country: 'DE', asn: 64500, asOrg: 'Example Net', wafEvents: 450, wafBlocked: 450, otherMitigated: 12, rules: [911100, 920420, 930100], hosts: 2, lastSeen: START + 55 * STEP },
        { ip: '203.0.113.66', country: 'BG', asn: 0, asOrg: '', wafEvents: 362, wafBlocked: 362, otherMitigated: 0, rules: [930130], hosts: 1, lastSeen: START + 50 * STEP },
      ],
    },
    hosts: { total: 9506, list: [{ host: 'app.example.com', events: 7130, wafEvents: 3898, otherMitigated: 3232, proxyHostId: 4 }] },
    events: {
      list: [
        { ts: START + 55 * STEP, kind: 'waf', eventId: 'tx-1', blocked: true, host: 'app.example.com', method: 'GET', path: '/', ip: '198.51.100.19', country: 'NL', ruleId: 920450, message: 'HTTP header is restricted by policy', severity: 'CRITICAL', status: 0 },
        { ts: START + 54 * STEP, kind: 'geo', eventId: null, blocked: true, host: 'portal.example.com', method: 'GET', path: '/portal', ip: '198.51.100.23', country: 'HK', ruleId: null, message: null, severity: null, status: 403 },
        { ts: START + 53 * STEP, kind: 'waf', eventId: 'tx-2', blocked: false, host: 'app.example.com', method: 'POST', path: '/search', ip: '203.0.113.66', country: 'BG', ruleId: 942100, message: 'SQL injection', severity: 'CRITICAL', status: 0 },
      ],
      page: 1,
      perPage: 50,
      hasMore: true,
      filterError: null,
    },
    blockedIps: ['203.0.113.66'],
    cdnIps: {},
    exclusionHosts: [{ id: 4, name: 'App', domains: ['app.example.com'] }],
    eventHostIds: { 'app.example.com': 4 },
    rateLimitInUse: false,
    permissions: { canWriteWaf: true, blockDisabledReason: null, canReadAnalytics: true, canReadSettings: true },
    tuning: { suggestions: [], analyticsEnabled: true, aiConfigured: false },
    ...overrides,
  };
}

const render = (value: SecurityPageData) => renderToStaticMarkup(createElement(SecurityClient, { data: value }));
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

describe('Security events page', () => {
  it('shows the rule set, the summary by source and the tiles', () => {
    const html = render(data());
    expect(html).toContain('>Security events</h1>');
    const page = text(html);
    expect(page).toContain('OWASP Core Rule Set 4.25');
    expect(page).toContain('Paranoia level 1');
    expect(page).toContain('Anomaly threshold 5');
    expect(page).toContain('Blocking on 7 hosts, detection only on 1 host');
    expect(page).toContain('3 rule exclusions');
    expect(page).toContain('Mitigated requests, last 7 days');
    expect(page).toContain('9,506');
    expect(page).toContain('▼ 37% vs the week before');
    expect(page).toContain('No rules yet · Add one');
    expect(page).toContain('28 WAF rules matched · top address sent 462');
    expect(page).toContain('Most targeted host');
    expect(html).toContain('href="/rate-limiting"');
  });

  it('explains the peak and links to its events', () => {
    const page = text(render(data()));
    expect(page).toContain('557 by the WAF and 320 by geo rules in 3 hours.');
    expect(page).toContain('37 source addresses; the busiest, 198.51.100.77 (DE), sent 462.');
    expect(page).toContain('Most went to app.example.com (690).');
    expect(page).toContain('The WAF rule matched most was 930130, Restricted file access attempt (410).');
    const html = render(data());
    expect(html).toContain(`href="/security?range=custom&amp;from=${START + 41 * STEP}&amp;to=${START + 42 * STEP}#events"`);
  });

  it('lists the top rules and sources with their actions', () => {
    const html = render(data());
    const page = text(html);
    expect(page).toContain('/.git/config, /.env, /.env.local and 2 more · 4 hosts');
    expect(page).toContain('86 logged only');
    expect(html).toMatch(/<button[^>]*aria-label="Add exclusion for rule 930130"[^>]*>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*aria-label="Add exclusion for rule 930130"/);
    expect(html).toMatch(/<button[^>]*aria-label="Block 198.51.100.77"[^>]*>Block<\/button>/);
    // Already on the Blocked sources list.
    expect(html).not.toContain('aria-label="Block 203.0.113.66"');
    expect(page).toContain('AS64500 Example Net');
  });

  it('disables actions the role may not use, with the reason', () => {
    const reason = 'Blocking an address needs the access_lists:write permission.';
    const html = render(data({ permissions: { canWriteWaf: false, blockDisabledReason: reason, canReadAnalytics: false, canReadSettings: false } }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Add exclusion for rule 930130"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Block 198.51.100.77"/);
    expect(text(html)).toContain(reason);
    expect(text(html)).toContain('Adding an exclusion needs the waf:write permission.');
    expect(html).not.toContain('Open in analytics');
    expect(html).not.toContain('href="/rate-limiting"');
  });

  it('lists events with what stopped them, the filters and the pages', () => {
    const html = render(
      data({
        query: { range: '24h', from: null, to: null, kind: 'waf', filters: [{ dim: 'host', op: 'is', value: 'app.example.com' }], page: 1 },
      })
    );
    const page = text(html);
    expect(page).toContain('Blocked by WAF');
    expect(page).toContain('Logged by WAF');
    expect(page).toContain('Geo rule');
    expect(page).toContain('Country, continent or network rule (HK)');
    expect(page).toContain('920450HTTP header is restricted by policy');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Remove filter: Host is app.example.com"');
    expect(html).toContain('aria-pressed="true" aria-label="WAF"');
    expect(html).toContain('href="/security?range=24h&amp;kind=waf&amp;filters=%5B%7B%22dim%22%3A%22host%22%2C%22op%22%3A%22is%22%2C%22value%22%3A%22app.example.com%22%7D%5D&amp;page=2#events"');
    expect(html).toContain('href="/analytics?range=24h&amp;filters=');
    // The pager looks like the shared one: the first page has no previous page, the next one is a link.
    expect(html).toContain('aria-label="Pages of events"');
    expect(html).toContain('aria-disabled="true" aria-label="Previous page"');
    expect(html).toContain('aria-label="Next page"');
    expect(page).toMatch(/1–\d+ events/);
  });

  it('reports a filter or range it did not use', () => {
    const page = text(
      render(
        data({
          rangeError: 'A custom range can cover at most 92 days',
          events: { list: [], page: 1, perPage: 50, hasMore: false, filterError: 'Security events can be filtered by host, path, country, ip, method, waf_rule' },
          query: { range: null, from: null, to: null, kind: null, filters: [{ dim: 'asn', op: 'is', value: '1' }], page: 1 },
        })
      )
    );
    expect(page).toContain('The time range in the address is not valid. A custom range can cover at most 92 days. The last 7 days are shown instead.');
    expect(page).toContain('A filter in the address is not valid, so it is not applied.');
    expect(page).toContain('No events match these filters');
  });

  it('says when analytics is off or ClickHouse does not answer', () => {
    const off = text(render(data({ status: 'disabled' })));
    expect(off).toContain('Analytics is off.');
    expect(off).toContain('OWASP Core Rule Set 4.25');
    expect(off).not.toContain('Top rules');
    const down = render(data({ status: 'unavailable' }));
    expect(text(down)).toContain('ClickHouse did not answer.');
    expect(down).toContain('>Try again</button>');
  });

  it('shows empty states without data', () => {
    const page = text(
      render(
        data({
          summary: { mitigated: 0, requests: 0, share: 0, previousMitigated: null, bySource: { waf: 0, geo: 0, access: 0, auth: 0, rate_limit: 0 } },
          series: [],
          peak: null,
          rules: { matched: 0, events: 0, list: [] },
          sources: { total: 0, list: [] },
          hosts: { total: 0, list: [] },
          events: { list: [], page: 1, perPage: 50, hasMore: false, filterError: null },
          ruleSet: { crsLoaded: true, crsVersion: '4.25', paranoiaLevel: 1, inboundThreshold: 5, blocking: 0, detecting: 0, hosts: 2, exclusions: 0 },
        })
      )
    );
    expect(page).toContain('The WAF is off on all 2 hosts');
    expect(page).toContain('Turn on the WAF');
    expect(page).toContain('nothing earlier to compare with');
    expect(page).toContain('Nothing was stopped in this range.');
    expect(page).toContain('No WAF rule matched');
    expect(page).toContain('No source addresses');
    expect(page).toContain('Nothing was stopped in this range');
    expect(page).toContain('Show the last 30 days');
  });
});
