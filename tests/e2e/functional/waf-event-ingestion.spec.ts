/**
 * Functional tests: WAF event ingestion (issue #233).
 *
 * waf-blocking.spec.ts proves Caddy/Coraza *blocks* attacks, but nothing
 * asserted that a block is ever *recorded*. That left the whole ingestion
 * pipeline — Coraza audit log → waf-log-parser → ClickHouse → /api/waf-events
 * → the Security events page — without any coverage, so it could break in production while
 * the entire suite stayed green. These tests close that gap.
 *
 * Scope note: the specific regression in #233 was that rule attribution came
 * from a join against waf-rules.log, which silently dropped an event whenever
 * the audit line and the rule line landed in different 30s parse ticks. Forcing
 * that race from the outside isn't practical, so it is pinned deterministically
 * in tests/unit/waf-log-parser.test.ts ("rule attribution from the audit entry
 * itself"). What these tests guarantee is the part unit tests cannot: that a
 * real Coraza audit log actually reaches the table with its rule populated.
 *
 * Domain: func-waf-ingest.test
 */
import { test, expect, type Page } from '@playwright/test';
import { createProxyHost } from '../../helpers/proxy-api';
import { httpGet, waitForRoute } from '../../helpers/http';

const DOMAIN = 'func-waf-ingest.test';

// waf-log-parser polls on a 30s interval, so a freshly generated event needs
// more than one cycle of slack before we call it missing.
const INGEST_TIMEOUT_MS = 100_000;
const POLL_INTERVAL_MS = 3_000;

interface WafEvent {
  ts: number;
  host: string;
  clientIp: string;
  method: string;
  uri: string;
  ruleId: number | null;
  ruleMessage: string | null;
  severity: string | null;
  blocked: boolean;
}

async function fetchWafEvents(page: Page): Promise<WafEvent[]> {
  const res = await page.request.get('/api/waf-events?per_page=200');
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { events: WafEvent[] };
  return body.events;
}

/** Poll /api/waf-events until an event matching `predicate` shows up. */
async function waitForWafEvent(
  page: Page,
  predicate: (e: WafEvent) => boolean,
  timeoutMs = INGEST_TIMEOUT_MS
): Promise<WafEvent> {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;

  while (Date.now() < deadline) {
    const events = await fetchWafEvents(page);
    seen = events.length;
    const match = events.find(predicate);
    if (match) return match;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(`No matching WAF event within ${timeoutMs}ms (${seen} events visible)`);
}

test.describe.serial('WAF event ingestion', () => {
  test('setup: create proxy host with WAF enabled', async ({ page }) => {
    test.setTimeout(120_000);

    await createProxyHost(page, {
      name: 'Functional WAF Ingestion',
      domain: DOMAIN,
      upstream: 'echo-server:8080',
      enableWaf: true,
    });
    await waitForRoute(DOMAIN);
  });

  test('a blocked attack is recorded as a WAF event with its rule', async ({ page }) => {
    test.setTimeout(INGEST_TIMEOUT_MS + 60_000);

    const res = await httpGet(DOMAIN, '/ingest-blocked?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    expect(res.status).toBe(403);

    const event = await waitForWafEvent(page, (e) => e.uri.includes('/ingest-blocked'));

    expect(event.blocked).toBe(true);
    expect(event.host).toContain(DOMAIN);
    expect(event.method).toBe('GET');
    // Rule attribution must be populated. A null rule id means the event landed
    // without knowing which rule fired — the failure mode behind #233, and the
    // reason attribution now comes from the audit entry's own `messages` array.
    expect(event.ruleId).not.toBeNull();
    expect(event.ruleMessage).toBeTruthy();
    expect(event.severity).toBeTruthy();
  });

  test('ingested events are visible on the Security events page', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/security?kind=waf');
    await expect(page.getByText('/ingest-blocked', { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  });

  test('an ingested event explains why it was blocked', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/security?kind=waf');
    // An event row (it opens), not the rule summary that also lists the path.
    const row = page.getByRole('row').filter({ hasText: '/ingest-blocked' }).filter({ has: page.getByRole('button', { expanded: false }) }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByRole('button', { expanded: false }).click();
    await expect(page.getByRole('region', { name: 'Why it was blocked' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/points, blocked at/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /^Exclude (rule \d+|\d+ rules)…$/ })).toBeVisible();
    await expect(page.getByTitle(/Blocked sources/)).toBeVisible();
  });

  test('ordinary traffic does not produce WAF events', async ({ page }) => {
    test.setTimeout(INGEST_TIMEOUT_MS);

    const res = await httpGet(DOMAIN, '/ingest-clean-path');
    expect(res.status).toBe(200);

    // Give the parser a couple of cycles, then confirm the clean request never
    // showed up. Coraza audit-logs some non-matching transactions (part of
    // SecAuditLogRelevantStatus covers 4xx/5xx), and those must stay out of the
    // WAF table — the parser drops entries with no rule and no interruption.
    await new Promise((r) => setTimeout(r, 70_000));

    const events = await fetchWafEvents(page);
    expect(events.some((e) => e.uri.includes('/ingest-clean-path'))).toBe(false);
  });
});
