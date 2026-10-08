/**
 * Server-side render of a WAF event's detail on Security events: the verdict
 * once, every rule that matched with what it found where (control characters
 * as escapes), one action that excludes the rules that added to the score,
 * and the block button.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/security',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(dashboard)/waf/actions', () => ({
  explainWafEventAction: vi.fn(),
  createWafExclusionAction: vi.fn(),
  createWafExclusionsAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/security/actions', () => ({ wafAuditRecordAction: vi.fn() }));

import { WafEventView, type EventDetailContext, type LoadState } from '@/app/(dashboard)/security/EventDetail';
import type { SecurityEvent } from '@/src/lib/analytics/security';
import type { WafEventExplanation } from '@/src/lib/waf-event-explain';
import { DEFAULT_QUERY } from '@/app/(dashboard)/security/security-view';

const event: SecurityEvent = {
  ts: 1_791_000_000,
  kind: 'waf',
  eventId: 'tx1',
  blocked: true,
  host: 'langfuse.example.com',
  method: 'POST',
  path: '/api/public/otel/v1/traces',
  ip: '198.51.100.7',
  country: 'IT',
  ruleId: 921150,
  message: 'HTTP Header Injection Attack via payload (CR/LF detected)',
  severity: 'CRITICAL',
  status: 0,
};

const context: EventDetailContext = {
  query: DEFAULT_QUERY,
  rangeLabel: 'last 24 hours',
  canWriteWaf: true,
  canReadAnalytics: true,
  canReadSettings: true,
  blockDisabledReason: null,
  blockedIps: new Set(),
  ruleEvents: new Map([[921150, 40]]),
  eventHostIds: {},
  onBlock: () => {},
  onAddExclusion: () => {},
};

const rule = (ruleId: number, message: string, matchedData: string, matchedVariable: string) => ({
  ruleId, kind: 'attack' as const, message, severity: 'CRITICAL', paranoiaLevel: 1, anomalyPoints: 5, countedInScore: true,
  matchedVariable, matchedData, disruptive: false, phase: 2, tags: [],
});

const suggestion = (ruleId: number, variable: string | null) => ({
  ruleId, proxyHostId: 4, hostName: 'Langfuse', pathMatch: 'exact' as const, path: '/api/public/otel/v1/traces', variable,
  reason: 'Suggested from WAF event tx1', description: `Skip rule ${ruleId}`, existingExclusionId: null,
});

const explanation = {
  eventId: 'tx1',
  blocked: true,
  request: { method: 'POST', uri: '/api/public/otel/v1/traces', host: 'langfuse.example.com', clientIp: '198.51.100.7', httpVersion: 'HTTP/2.0', headers: {} },
  rules: [
    rule(921150, 'HTTP Header Injection Attack via payload (CR/LF detected)', 'Matched Data: \r\n found within ARGS_NAMES: $9556d782\r\n:x', 'ARGS_NAMES'),
    rule(930120, 'OS File Access Attempt', 'Matched Data: /tmp/ found within ARGS:1: python3 -I -c', 'ARGS:1'),
    { ...rule(949110, 'Inbound Anomaly Score Exceeded', '', ''), kind: 'inbound_evaluation' as const, anomalyPoints: null, countedInScore: false, matchedData: null, matchedVariable: null, disruptive: true },
  ],
  inboundScore: 10,
  inboundScoreSource: 'record',
  outboundScore: null,
  inboundThreshold: 5,
  outboundThreshold: 4,
  thresholdSource: 'settings',
  decidingRule: { ruleId: 949110, message: 'Inbound Anomaly Score Exceeded', kind: 'inbound_evaluation', blocked: true },
  summary: 'Blocked: the anomaly score reached 10, the limit is 5.',
  suggestions: [suggestion(921150, 'ARGS_NAMES'), suggestion(930120, 'ARGS:1')],
  event: {},
} as unknown as WafEventExplanation;

function render(state: LoadState, patch: Partial<EventDetailContext> = {}): string {
  return renderToStaticMarkup(createElement(WafEventView, { event, context: { ...context, ...patch }, state, onExcluded: () => {} }));
}

describe('WAF event detail', () => {
  it('says the verdict once and lists each rule with what it found where', () => {
    const html = render({ status: 'ready', explanation });
    expect(html).toContain('>10<');
    expect(html).toContain('blocked at');
    // The summary sentence repeats the score: it is not shown next to it.
    expect(html).not.toContain('Blocked: the anomaly score reached 10');
    expect(html).toContain('The 2 rules that matched');
    expect(html).toContain('OS File Access Attempt');
    // The CR/LF that matched is shown, not trimmed away or drawn as boxes.
    expect(html).toContain('>\\r\\n</code>');
    expect(html).toContain('ARGS_NAMES');
    expect(html).toContain('>/tmp/</code>');
    expect(html).toContain('The request never reached the upstream; rule 921150 matched 40 times in the last 24 hours.');
  });

  it('offers one action for every rule to exclude, and blocking the source', () => {
    const html = render({ status: 'ready', explanation });
    expect(html).toContain('Exclude 2 rules…');
    expect(html.match(/Review and add/g)).toBeNull();
    expect(html).toContain('only on Langfuse, for requests to /api/public/otel/v1/traces, in the variable matched');
    expect(html).toContain('Block 198.51.100.7');
    expect(html).toContain('Copy as curl');
    // No cards that look like buttons but only close the row.
    expect(html).not.toContain('Nothing: this is working as intended');
  });

  it('says why excluding is not offered', () => {
    expect(render({ status: 'ready', explanation }, { canWriteWaf: false })).toContain('Adding exclusions needs the waf:write permission.');
    const excluded = { ...explanation, suggestions: explanation.suggestions.map((s) => ({ ...s, existingExclusionId: 1 })) };
    const html = render({ status: 'ready', explanation: excluded });
    expect(html).toContain('The suggested exclusions exist already.');
    expect(html).not.toContain('Exclude 2 rules');
    expect(render({ status: 'ready', explanation }, { blockedIps: new Set(['198.51.100.7']) })).toContain('198.51.100.7 is blocked');
  });

  it('falls back to the rule of the event when the record cannot be read', () => {
    const html = render({ status: 'error', error: 'This event is no longer stored' });
    expect(html).toContain('This event is no longer stored. The event names rule');
    expect(html).toContain('Exclude rule 921150…');
  });

  it('warns before blocking a Cloudflare address, pointing at Trusted proxies', () => {
    const html = render({ status: 'ready', explanation }, { cdnIps: { '198.51.100.7': 'Cloudflare' } });
    expect(html).toContain('is a Cloudflare address.');
    expect(html).toContain('href="/proxy-hosts/defaults#trusted-proxies"');
    expect(render({ status: 'ready', explanation })).not.toContain('Cloudflare address');
  });
});
