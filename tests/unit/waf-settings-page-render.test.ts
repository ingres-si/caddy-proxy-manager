/**
 * Server-side render of the WAF settings page (/waf): its sections, the
 * stored tuning, the per-host and exclusion tables with their search and
 * pager, and the read-only view for a role without waf:write.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/waf',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(dashboard)/waf/actions', () => ({
  saveWafSettingsAction: vi.fn(),
  setWafHostModeAction: vi.fn(),
  createWafExclusionAction: vi.fn(),
  deleteWafExclusionAction: vi.fn(),
  explainWafEventAction: vi.fn(),
}));

import WafSettingsClient from '@/app/(dashboard)/waf/WafSettingsClient';
import type { WafSettingsPageData } from '@/app/(dashboard)/waf/waf-settings-shared';
import { textContent } from '../helpers/text';

function data(overrides: Partial<WafSettingsPageData> = {}): WafSettingsPageData {
  return {
    settings: {
      enabled: false,
      mode: 'On',
      load_owasp_crs: true,
      custom_directives: 'SecRule REQUEST_HEADERS:User-Agent "@contains badbot" "id:9002,phase:1,deny,status:403,log"',
      paranoia_level: 2,
      detection_paranoia_level: 3,
      inbound_anomaly_threshold: 7,
    },
    savedAt: '2026-10-02T18:31:00.000Z',
    canWrite: true,
    analyticsEnabled: true,
    hosts: [
      {
        id: 1, name: 'Wiki', domains: ['wiki.example.com'], hostEnabled: true, mode: 'inherit', configured: true, rules: 'merge',
        effectiveMode: 'block', loadOwaspCrs: true, settings: 'merges', differences: ['1 rule exclusion'], exclusions: 1,
        events: { count: 73, blocked: 73 },
      },
      {
        id: 2, name: 'Grafana', domains: ['grafana.example.com'], hostEnabled: true, mode: 'detection_only', configured: true, rules: 'merge',
        effectiveMode: 'detection_only', loadOwaspCrs: true, settings: 'merges', differences: ['detection only'], exclusions: 0,
        events: { count: 1, blocked: 0 },
      },
      {
        id: 3, name: 'Mail', domains: ['mail.example.com'], hostEnabled: true, mode: 'inherit', configured: false, rules: 'merge',
        effectiveMode: 'off', loadOwaspCrs: false, settings: 'follows', differences: [], exclusions: 0,
        events: { count: 0, blocked: 0 },
      },
    ],
    exclusions: [
      {
        id: 4, ruleId: 942100, scope: 'host', proxyHostId: 1, host: { id: 1, name: 'Wiki', domains: ['wiki.example.com'] },
        pathMatch: null, path: null, variable: 'ARGS:content', reason: 'Runbook pages quote SQL queries', createdBy: { id: 1, name: 'admin' },
        createdAt: '2026-09-02T10:00:00.000Z', updatedAt: '2026-09-02T10:00:00.000Z', ruleMessage: 'SQL Injection Attack Detected via libinjection',
      },
    ],
    week: {
      from: 1790400000,
      to: 1791004800,
      summary: { total: 5206, blocked: 5205, uniqueClientIps: 107, rules: 28, hosts: 7 },
      daily: [{ day: '2026-10-01', count: 1187, blocked: 1187 }],
      topRules: [{ ruleId: 930130, count: 2183, message: 'Restricted File Access Attempt' }],
    },
    droppedDirectives: [],
    ...overrides,
  };
}

const render = (value: WafSettingsPageData) => renderToStaticMarkup(createElement(WafSettingsClient, { data: value }));

describe('WAF settings page', () => {
  it('renders every section with the stored tuning', () => {
    const html = render(data());
    for (const heading of ['WAF settings', 'Global mode', 'Rule set', 'Request bodies', 'What the rules stopped', 'Per-host settings', 'Rule exclusions', 'Custom rules']) {
      expect(html).toContain(`>${heading}</h`);
    }
    // The stored tuning: paranoia level 2, level 3 logged, thresholds 7 and 4 (the default).
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*><span class="font-mono font-semibold">2<\/span> Elevated/);
    expect(html).toMatch(/id="waf-th-in"[^>]*value="7"/);
    expect(html).toMatch(/id="waf-th-out"[^>]*value="4"/);
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>.*Blocking/);
    expect(html).toContain('Also log level <span class="font-mono">3</span> matches without blocking them');
    expect(html).toContain('1 rule, none dropped');
    expect(html).not.toContain('tx.blocking_paranoia_level');
  });

  it('lists hosts by mode and exclusions with scope, reason and author', () => {
    const html = render(data());
    expect(html).toContain('Blocking on 1 host, detection only on 1 host');
    expect(html).toContain('Core Rule Set 4.25');
    expect(html).toContain('Runbook pages quote SQL queries');
    expect(html).toContain('ARGS:content');
    expect(html).toContain('aria-label="Remove exclusion of rule 942100 on wiki.example.com"');
    expect(html).toContain('Restricted File Access Attempt');
    expect(html).toContain('aria-label="Search hosts"');
    expect(html).toContain('aria-label="Search exclusions"');
    // Everything fits on one page: no pager.
    expect(html).not.toContain('aria-label="Pages of hosts"');
  });

  it('pages the per-host table and the exclusions, hosts with settings of their own first', () => {
    const base = data();
    const plain = base.hosts[2];
    const hosts = [
      ...Array.from({ length: 59 }, (_, i) => ({ ...plain, id: 100 + i, name: `Host ${String(i).padStart(2, '0')}`, domains: [`h${i}.example.com`] })),
      base.hosts[0],
    ];
    const exclusions = Array.from({ length: 30 }, (_, i) => ({ ...base.exclusions[0], id: 200 + i, ruleId: 920000 + i }));
    const html = render(data({ hosts, exclusions }));
    expect(html).toContain('aria-label="Pages of hosts"');
    expect(textContent(html)).toContain('1–25 of 60 hosts');
    expect(html.match(/aria-label="WAF mode of /g)?.length).toBe(25);
    // Wiki has settings of its own, so it leads the first page although it is listed last.
    expect(html).toContain('aria-label="WAF mode of Wiki"');
    expect(html).not.toContain('aria-label="WAF mode of Host 30"');
    expect(html).toContain('aria-label="Pages of exclusions"');
    expect(textContent(html)).toContain('1–25 of 30 exclusions');
    expect(html.match(/aria-label="Remove exclusion of rule /g)?.length).toBe(25);
  });

  it('is read-only without waf:write', () => {
    const html = render(data({ canWrite: false }));
    expect(html).toContain('changing the WAF settings needs the waf:write permission');
    expect(html).not.toContain('Save and apply');
    expect(html).not.toContain('Add exclusion');
    expect(html).not.toContain('Remove exclusion');
  });

  it('renders before the WAF was ever set up and without analytics', () => {
    const html = render(data({ settings: null, savedAt: null, analyticsEnabled: false, hosts: [], exclusions: [] }));
    expect(html).toContain('No rule exclusions.');
    expect(html).toContain('No proxy hosts yet.');
    expect(html).toContain('Analytics are off.');
  });
});
