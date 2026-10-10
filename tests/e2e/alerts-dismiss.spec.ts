/**
 * Dismissing an open alert on the E2E stack: a certificate-expiry rule that
 * notifies an e-mail channel fires for an imported certificate that expires
 * in two days (the built-in certificate rule is disabled meanwhile, so only
 * this rule reports it). Dismissed from the Open tab (at once, until it resolves), the alert stays listed,
 * marked, and leaves the overview's Needs attention and the sidebar count;
 * Undo brings it back. Dismissed from Needs attention, the same, with Undo
 * right there.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createSelfSignedServerCertificate } from '../helpers/certs';

const BASE_URL = 'http://localhost:3000';
const API = `${BASE_URL}/api/v1`;
const headers = { 'Content-Type': 'application/json', Origin: BASE_URL };

type Silence = { id: number; note: string | null; until: string | null; createdByName: string | null };
type FiringAlert = { ruleId: number; subjectKey: string; title: string; dismissal: Silence | null; mute: Silence | null };

async function firingAlerts(request: APIRequestContext): Promise<FiringAlert[]> {
  const response = await request.get(`${API}/alert-events/firing`);
  expect(response.status()).toBe(200);
  return (await response.json()).alerts;
}

/** The count next to Alerts in the sidebar (0 when it shows none). */
async function sidebarCount(page: Page): Promise<number> {
  const link = page.getByRole('navigation', { name: 'Main navigation' }).locator('a[href="/alerts"]');
  await expect(link).toBeVisible();
  // The badge's label for screen readers, e.g. "2 alerts firing".
  const label = link.locator('.sr-only');
  if ((await label.count()) === 0) return 0;
  const match = /^(\d+) alerts? firing$/.exec(((await label.first().textContent()) ?? '').trim());
  return match ? Number(match[1]) : 0;
}

/** The overview's Needs attention items titled `title`. */
function attentionItems(page: Page, title: string) {
  return page
    .getByRole('region', { name: 'Needs attention' })
    .getByTestId('attention-list')
    .getByRole('listitem')
    .filter({ hasText: title });
}

test.describe('Dismissing an alert', () => {
  test('dismissed from the Open tab or from Needs attention, it leaves Needs attention and the badge until undone', async ({ page }) => {
    // The evaluator runs a minute apart (half a minute after start-up).
    test.setTimeout(300_000);
    const stamp = Date.now();
    const domain = `dismiss-${stamp}.example.com`;
    const ruleName = `Dismiss test ${stamp}`;
    const { certificatePem, privateKeyPem } = createSelfSignedServerCertificate(domain, [domain], 2);
    const created: string[] = [];
    // The Alerts page adds the built-in rules on a fresh stack; added after ours, the certificate one would be left out.
    await page.goto('/alerts');
    const rules = (await (await page.request.get(`${API}/alert-rules`)).json()) as { id: number; builtIn: string | null; enabled: boolean }[];
    const builtIn = rules.find((entry) => entry.builtIn === 'certificates');

    try {
      if (builtIn?.enabled) {
        expect((await page.request.put(`${API}/alert-rules/${builtIn.id}`, { data: { enabled: false }, headers })).status()).toBe(200);
      }
      const cert = await page.request.post(`${API}/certificates`, {
        data: { name: `Dismiss ${domain}`, type: 'imported', domainNames: [domain], autoRenew: false, certificatePem, privateKeyPem },
        headers,
      });
      expect(cert.status()).toBe(201);
      const certId = (await cert.json()).id as number;
      created.push(`${API}/certificates/${certId}`);

      // A channel that fails fast: nothing listens there.
      const channel = await page.request.post(`${API}/alert-channels`, {
        data: { name: `Dismiss mail ${stamp}`, type: 'email', config: { host: '127.0.0.1', port: 2525, from: 'alerts@example.com', to: ['ops@example.com'] } },
        headers,
      });
      expect(channel.status()).toBe(201);
      const channelId = (await channel.json()).id as number;

      const rule = await page.request.post(`${API}/alert-rules`, {
        data: {
          name: ruleName,
          type: 'cert_expiring',
          params: { days: 3, includeClientCertificates: false, includeManagedCertificates: false },
          channelIds: [channelId],
          cooldownMinutes: 0,
        },
        headers,
      });
      expect(rule.status()).toBe(201);
      const ruleId = (await rule.json()).id as number;
      created.unshift(`${API}/alert-rules/${ruleId}`);
      created.push(`${API}/alert-channels/${channelId}`);

      const subjectKey = `certificate:${certId}`;
      const ours = async () => (await firingAlerts(page.request)).find((alert) => alert.ruleId === ruleId && alert.subjectKey === subjectKey);
      await expect.poll(async () => Boolean(await ours()), { timeout: 180_000, intervals: [5_000] }).toBe(true);
      const alert = (await ours())!;
      expect(alert.dismissal).toBeNull();

      await page.goto('/');
      await expect(attentionItems(page, alert.title)).toHaveCount(1);
      const before = await sidebarCount(page);
      expect(before).toBeGreaterThanOrEqual(1);

      // Dismiss dismisses: until it resolves, at once, no dialog.
      await page.goto('/alerts');
      const card = page.getByRole('article').filter({ hasText: ruleName });
      await card.getByRole('button', { name: `Dismiss ${alert.title}`, exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      const marker = card.getByTestId('silence-marker');
      await expect(marker).toContainText('Dismissed');
      const dismissed = (await ours())!;
      expect(dismissed.dismissal).toMatchObject({ until: null });
      if (dismissed.dismissal!.createdByName) await expect(marker).toContainText(`Dismissed · ${dismissed.dismissal!.createdByName}`);

      await page.goto('/');
      // On a fresh install the section is left out once nothing in it needs attention.
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(attentionItems(page, alert.title)).toHaveCount(0);
      expect(await sidebarCount(page)).toBe(before - 1);

      // Undo: it needs attention again.
      await page.goto('/alerts');
      await card.getByRole('button', { name: `Undo the dismissal of ${alert.title}` }).click();
      await expect(card.getByTestId('silence-marker')).toHaveCount(0);
      expect((await ours())!.dismissal).toBeNull();

      // A dismissal for a while, or muting the rule, is in the menu next to Dismiss.
      await card.getByRole('button', { name: `More ways to dismiss ${alert.title}` }).click();
      await page.getByRole('menuitem', { name: 'Dismiss for a while…' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Dismiss alert' })).toBeVisible();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      expect((await ours())!.dismissal).toBeNull();

      await page.goto('/');
      await expect(attentionItems(page, alert.title)).toHaveCount(1);
      expect(await sidebarCount(page)).toBe(before);

      // Dismissed from Needs attention: for everyone, until it resolves; Undo right there.
      await page.getByRole('button', { name: `Dismiss until it resolves: ${alert.title}` }).click();
      const status = page.getByRole('region', { name: 'Needs attention' }).getByRole('status');
      await expect(status).toContainText('Dismissed for everyone until it resolves');
      await expect(attentionItems(page, alert.title)).toHaveCount(0);
      await expect
        .poll(async () => {
          const current = await ours();
          return current?.dismissal ? current.dismissal.until : 'not dismissed';
        })
        .toBeNull();
      await status.getByRole('button', { name: 'Undo' }).click();
      await expect(attentionItems(page, alert.title)).toHaveCount(1);
      expect((await ours())!.dismissal).toBeNull();
    } finally {
      for (const url of created) await page.request.delete(url, { headers });
      if (builtIn?.enabled) await page.request.put(`${API}/alert-rules/${builtIn.id}`, { data: { enabled: true }, headers });
    }
  });
});
