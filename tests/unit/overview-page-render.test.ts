/**
 * Server-side render of the overview (app/(dashboard)/OverviewClient.tsx):
 * the set-up overview with every section, what a viewer without
 * permissions sees, analytics being off, and the first-run layout with the
 * setup checklist.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import OverviewClient from '@/app/(dashboard)/OverviewClient';
import type { OverviewData, OverviewPermissions, OverviewTraffic } from '@/src/lib/overview-shared';
import type { SetupChecklistView } from '@/src/lib/setup-checklist';

const GENERATED = '2026-10-03T11:36:00.000Z';
const START = Date.parse('2026-10-02T12:00:00.000Z') / 1000;

const ALL: OverviewPermissions = {
  createProxyHost: true, readProxyHosts: true, readAnalytics: true, readSecurity: true, readAlerts: true, writeAlerts: true,
  readAuditLog: true, readUsers: true, readSso: true, writeSettings: true,
};
const NONE: OverviewPermissions = Object.fromEntries(Object.keys(ALL).map((key) => [key, false])) as OverviewPermissions;

function traffic(overrides: Partial<OverviewTraffic> = {}): OverviewTraffic {
  const n = 48;
  const requests = Array.from({ length: n }, (_, i) => 1000 + i * 10);
  const mitigated = Array.from({ length: n }, (_, i) => (i === 40 ? 265 : 5));
  return {
    status: 'ok',
    range: { preset: '24h', start: START, end: START + n * 1800, step: 1800, buckets: n },
    served: requests.map((r, i) => r - mitigated[i]),
    mitigated,
    totals: { requests: 61_817, mitigated: 1_141, mitigatedShare: 0.0185, errors5xx: 144, errorRate5xx: 0.0023, bytes: 412_000_000 },
    previous: { requests: 92_000, errorRate5xx: 0.001, bytes: 500_000_000, mitigated: 559 },
    sparklines: { requests, mitigated, errors5xx: new Array(n).fill(3), bytes: requests },
    peakMitigated: { index: 40, ts: START + 40 * 1800, value: 265 },
    topErrorHost: { name: 'mail.example.com', count: 143 },
    ...overrides,
  };
}

function checklist(overrides: Partial<SetupChecklistView> = {}): SetupChecklistView {
  const step = (key: SetupChecklistView['steps'][number]['key'], title: string) => ({
    key, title, description: `${title}.`, done: false, doneBy: null, markedAt: null, action: null,
  });
  return {
    steps: [
      step('domain', 'Point a domain at this server'),
      step('first_proxy_host', 'Add your first proxy host'),
      step('analytics', 'Turn on analytics'),
      step('second_user', 'Invite a teammate'),
      step('single_sign_on', 'Set up single sign-on'),
    ],
    done: 0, total: 5, complete: false, dismissed: false, dismissedAt: null,
    ...overrides,
  };
}

function data(overrides: Partial<OverviewData> = {}): OverviewData {
  return {
    generatedAt: GENERATED,
    range: '24h',
    userName: 'admin',
    version: '2.0.3',
    permissions: ALL,
    firstRun: null,
    attention: {
      generatedAt: GENERATED,
      truncated: false,
      counts: { critical: 1, warning: 1, info: 0 },
      sources: [{ id: 'alerts', label: 'Alerts', status: 'ok', items: 1 }, { id: 'fleet', label: 'Fleet', status: 'timeout', items: 0 }, { id: 'certificates', label: 'Certificates', status: 'ok', items: 1 }],
      notifying: false,
      items: [
        {
          id: '3:proxy_host:7', source: 'alerts', severity: 'critical', title: 'mail.example.com is answering with server errors: 143 since 09:02 UTC',
          detail: 'Mostly 501 to POST /Microsoft-Server-ActiveSync.', at: GENERATED,
          actions: [{ label: 'Open host', route: '/proxy-hosts/7' }, { label: 'Show requests', route: '/analytics?range=24h&host=mail.example.com&status=5xx' }],
          issue: { ruleId: 3, subjectKey: 'proxy_host:7' },
        },
        { id: 'imported:1', source: 'certificates', severity: 'warning', title: 'Certificate "Shop" expires in 4 days', detail: 'Import a renewed certificate.', at: null, actions: [{ label: 'View certificates', route: '/certificates' }] },
      ],
    },
    traffic: traffic(),
    hosts: {
      status: 'ok',
      total: 4,
      certificates: true,
      rows: [
        { id: 7, label: 'mail.example.com', name: 'Mail', enabled: true, href: '/proxy-hosts/7', requests: 12_147, share: 1, errors5xx: 143, errorRate5xx: 0.052, mitigated: 0, certificateDaysLeft: 86, tone: 'warn', toneLabel: 'Had a burst of server errors', burst: { status: 501, start: Date.parse('2026-10-03T09:02:00.000Z') / 1000, ongoing: false } },
        { id: 8, label: 'shop.example.com', name: 'Shop', enabled: true, href: '/proxy-hosts/8', requests: 9_454, share: 0.778, errors5xx: 0, errorRate5xx: 0, mitigated: 836, certificateDaysLeft: 4, tone: 'bad', toneLabel: 'Certificate expires within a week', burst: null },
      ],
    },
    nodes: {
      mode: 'master',
      more: 0,
      link: { label: 'Fleet', href: '/fleet' },
      nodes: [
        { key: 'self', name: 'This server', detail: 'Master · 1 replica', at: null, version: 'v2.0.3', versionDiffers: false, tone: 'ok' },
        { key: 'instance:2', name: 'edge-2', detail: 'Replica · synced', at: '2026-10-03T11:35:50.000Z', version: 'v2.0.2', versionDiffers: true, tone: 'warn' },
      ],
    },
    changes: [
      { id: 3, who: 'Ada Admin', summary: 'Updated proxy host Wiki', at: '2026-10-03T10:58:00.000Z', rollbackHref: '/history?version=1' },
      { id: 2, who: null, summary: 'Rule "10.0.0.0/8" of access list Office expired', at: '2026-10-02T18:22:00.000Z', rollbackHref: null },
    ],
    ...overrides,
  };
}

const render = (value: OverviewData) => renderToStaticMarkup(createElement(OverviewClient, { data: value }));

describe('the overview', () => {
  it('shows the header, what needs attention and every section of an administrator', () => {
    const html = render(data());
    expect(html).toContain('Saturday 3 October · 11:36 UTC');
    expect(html).toMatch(/<h1[^>]*>Overview<\/h1>/);
    expect(html).toContain('aria-label="Time range"');
    expect(html).toContain('href="/proxy-hosts?create=1"');

    // Needs attention: severity for screen readers, the actions, the phone's row link and the sources that did not answer.
    expect(html).toContain('<span class="sr-only">Critical: </span>mail.example.com is answering with server errors');
    expect(html).toContain('href="/analytics?range=24h&amp;host=mail.example.com&amp;status=5xx"');
    expect(html).toContain('aria-label="Certificate &quot;Shop&quot; expires in 4 days: View certificates"');
    expect(html).toContain('href="/alerts">Alerts<');
    expect(html).toContain('Fleet did not answer in time');
    // Alerts can be dismissed until they resolve; other items cannot.
    expect(html).toContain('aria-label="Dismiss until it resolves: mail.example.com is answering with server errors: 143 since 09:02 UTC"');
    expect(html.match(/aria-label="Dismiss until it resolves/g)?.length).toBe(1);
    // Nobody is notified: the footer says so and offers a channel.
    expect(html).toContain('Alerts are not sent anywhere.');
    expect(html).toContain('href="/alerts?tab=channels"');

    for (const label of ['Requests', 'Mitigated', '5xx error rate', 'Bandwidth']) expect(html).toContain(label);
    expect(html).toContain('61,817');
    expect(html).toContain('▼ 33%');
    expect(html).toContain('143 from mail.example.com');
    expect(html).toContain('of requests · peak at 08:00');

    expect(html).toContain('Traffic, last 24 hours');
    expect(html).toContain('Peak 08:00 · 265 mitigated');
    // The peak leads to the security events of that half hour.
    expect(html).toContain('href="/security?range=custom&amp;from=1791014400&amp;to=1791016200#events"');

    expect(html).toContain('All 4 hosts');
    expect(html).toContain('501 burst at 09:02');
    expect(html).toContain('href="/proxy-hosts/7"');
    expect(html).toContain('4 days');

    expect(html).toContain('This server');
    expect(html).toContain('Replica · synced · just now');
    expect(html).toContain('v2.0.2');

    expect(html).toContain('<span class="font-semibold">Ada Admin</span> updated proxy host Wiki');
    expect(html).toContain('href="/history?version=1"');
    expect(html).toContain('Yesterday 18:22');
  });

  it('shows a viewer without permissions what needs their attention and their account', () => {
    const html = render(data({
      permissions: NONE,
      attention: { generatedAt: GENERATED, truncated: false, counts: { critical: 0, warning: 0, info: 0 }, sources: [{ id: 'my_reviews', label: 'Your access reviews', status: 'ok', items: 0 }], items: [], notifying: null },
      traffic: null, hosts: null, nodes: null, changes: null,
    }));
    expect(html).toContain('Nothing needs attention right now');
    expect(html).not.toContain('Checked:');
    expect(html).toContain('Nothing else to show for your role');
    expect(html).not.toContain('Time range');
    expect(html).not.toContain('New proxy host');
    expect(html).not.toContain('Busiest hosts');
  });

  it('explains that analytics are off instead of showing empty figures', () => {
    const html = render(data({ traffic: traffic({ status: 'disabled' }), hosts: { status: 'disabled', total: 1, certificates: false, rows: [] } }));
    expect(html).toContain('Analytics are off');
    expect(html).toContain('COMPOSE_PROFILES=clickhouse');
    expect(html).not.toContain('data-testid="overview-kpis"');
    expect(render(data({ traffic: traffic({ status: 'unavailable' }) }))).toContain('ClickHouse did not answer');
  });
});

describe('the first run', () => {
  const firstRun = (overrides: Partial<OverviewData> = {}) =>
    data({
      firstRun: { checklist: checklist() },
      traffic: traffic({ status: 'disabled' }),
      hosts: { status: 'disabled', total: 0, certificates: true, rows: [] },
      ...overrides,
    });

  it('shows the setup checklist and empty traffic', () => {
    const html = render(firstRun());
    expect(html).toContain('Saturday 3 October · 11:36 UTC · Ingressi <span class="num">v2.0.3</span>');
    expect(html).toMatch(/<h1[^>]*>Welcome, admin<\/h1>/);
    expect(html).toContain('Set up this install');
    expect(html).toContain('0 of 5 done');
    expect(html).toContain('Mark as done<span class="sr-only">: Point a domain at this server</span>');
    expect(html).toContain('id="step-analytics"');
    expect(html).toContain('Sign in through an OpenID Connect or SAML provider, or an LDAP directory.');
    expect(html).toContain('Hide the checklist');
    expect(html).toContain('Analytics are off.');
    expect(html).toContain('href="#step-analytics"');
    expect(html).toContain('No proxy hosts yet');
    // The setup item is the checklist itself; other items still show.
    expect(html).toContain('Certificate &quot;Shop&quot; expires in 4 days');
    expect(html).not.toContain('Time range');
  });

  it('leaves marking steps done to those who change settings, and counts what is done', () => {
    const done = checklist();
    done.steps[1] = { ...done.steps[1], done: true, doneBy: 'data' };
    done.steps[0] = { ...done.steps[0], done: true, doneBy: 'manual', markedAt: GENERATED };
    const html = render(firstRun({ permissions: { ...ALL, writeSettings: false }, firstRun: { checklist: { ...done, done: 2 } } }));
    expect(html).toContain('2 of 5 done');
    expect(html).not.toContain('Mark as done');
    expect(html).not.toContain('Hide the checklist');
    const writer = render(firstRun({ firstRun: { checklist: { ...done, done: 2 } } }));
    expect(writer).toContain('aria-pressed="true"');
    expect(writer).toContain('Done<span class="sr-only">: Point a domain at this server</span>');
  });
});
