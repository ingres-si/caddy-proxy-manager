/**
 * Filters on the analytics page: Only and Exclude on a top list row add a
 * filter and offer to undo it, the filter bar adds one by hand and clears
 * them, every filter lives in the URL (the back button undoes it) and the
 * lists follow them.
 *
 * Seeds traffic for two hosts straight into ClickHouse, all on one path
 * unique to the run, and opens the page filtered to that path so the hosts
 * list holds just the two.
 */
import { test, expect, type Page } from '@playwright/test';
import { createClient, type ClickHouseClient } from '@clickhouse/client';

// ClickHouse HTTP port is exposed to the host by tests/docker-compose.test.yml.
function makeClient(): ClickHouseClient {
  return createClient({
    url: 'http://localhost:8123',
    username: 'ingressi',
    password: 'test-clickhouse-password-2026',
    database: 'analytics',
  });
}

function chDateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

const hostsPanel = (page: Page) => page.getByRole('region', { name: 'Hosts' });

test.describe('Analytics filters', () => {
  test('adds, removes and steps back through filters', async ({ page }) => {
    const tag = `filters-${Date.now()}`;
    const path = `/${tag}`;
    const hostA = `${tag}-a.example.com`;
    const hostB = `${tag}-b.example.com`;
    const ch = makeClient();
    const now = Math.floor(Date.now() / 1000);
    const row = (host: string, i: number) => ({
      ts: chDateTime(now - i),
      client_ip: '203.0.113.7',
      host,
      method: 'GET',
      uri: path,
      status: 200,
      proto: 'HTTP/2.0',
      bytes_sent: 100,
      user_agent: 'analytics-filters-e2e',
      is_blocked: 0,
    });

    try {
      // On a fresh stack the web container may not have created the table yet.
      await expect
        .poll(async () => (await (await ch.query({ query: 'EXISTS TABLE traffic_events', format: 'JSONEachRow' })).json<{ result: number }>())[0]?.result, { timeout: 60_000 })
        .toBe(1);
      await ch.insert({
        table: 'traffic_events',
        format: 'JSONEachRow',
        values: [row(hostA, 1), row(hostA, 2), row(hostA, 3), row(hostB, 4), row(hostB, 5)],
      });

      const start = `/analytics?range=1h&filter=${encodeURIComponent(`path:${path}`)}`;
      await page.goto(start);
      await expect(page.getByRole('button', { name: `Remove filter: Path is ${path}` })).toBeVisible();
      await expect(hostsPanel(page).getByText(hostA, { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(hostsPanel(page).getByText(hostB, { exact: true })).toBeVisible();

      // Only on a row: only that host is left, and the toast says so.
      await hostsPanel(page).getByRole('button', { name: `Only: Host is ${hostA}` }).click();
      await expect(page).toHaveURL(new RegExp(`filter=host%3A${hostA.replace(/\./g, '\\.')}`));
      await expect(page.getByRole('button', { name: `Remove filter: Host is ${hostA}` })).toBeVisible();
      await expect(page.getByText(`Showing only Host is ${hostA}`)).toBeVisible();
      await expect(hostsPanel(page).getByText(hostB, { exact: true })).not.toBeVisible({ timeout: 15_000 });

      // Undo in the toast takes it away again.
      await page.getByRole('button', { name: 'Undo' }).click();
      await expect(page.getByRole('button', { name: `Remove filter: Host is ${hostA}` })).not.toBeVisible();
      await expect(hostsPanel(page).getByText(hostB, { exact: true })).toBeVisible({ timeout: 15_000 });

      // Again; this time the back button undoes it.
      await hostsPanel(page).getByRole('button', { name: `Only: Host is ${hostA}` }).click();
      await expect(page.getByRole('button', { name: `Remove filter: Host is ${hostA}` })).toBeVisible();

      await page.goBack();
      await expect(page.getByRole('button', { name: `Remove filter: Host is ${hostA}` })).not.toBeVisible();
      await expect(hostsPanel(page).getByText(hostB, { exact: true })).toBeVisible({ timeout: 15_000 });

      // Exclude on a row hides it; the chip removes it again.
      await hostsPanel(page).getByRole('button', { name: `Exclude: Host is ${hostB}` }).click();
      const chip = page.getByRole('button', { name: `Remove filter: Host is not ${hostB}` });
      await expect(chip).toBeVisible();
      await expect(hostsPanel(page).getByText(hostB, { exact: true })).not.toBeVisible({ timeout: 15_000 });
      await chip.click();
      await expect(chip).not.toBeVisible();
      await expect(page).not.toHaveURL(/filter=%21host/);

      // The filter bar adds one by hand, and refuses a value the API would.
      const bar = page.getByRole('group', { name: 'Filters' });
      await bar.getByRole('button', { name: 'More filters' }).click();
      await page.getByRole('group', { name: 'Filter by' }).getByRole('button', { name: 'Country', exact: true }).click();
      await page.getByLabel('Country value').fill('Germany');
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(page.getByText('Country must be a two-letter code, LAN or XX')).toBeVisible();

      await bar.getByRole('button', { name: 'More filters' }).click();
      await page.getByRole('group', { name: 'Filter by' }).getByRole('button', { name: 'Host', exact: true }).click();
      await page.getByLabel('Host value').fill(hostB);
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(page.getByRole('button', { name: `Remove filter: Host is ${hostB}` })).toBeVisible();
      await expect(hostsPanel(page).getByText(hostA, { exact: true })).not.toBeVisible({ timeout: 15_000 });
      await page.getByRole('button', { name: `Remove filter: Host is ${hostB}` }).click();

      // The search box finds hosts by part of their name: "contains", or one of the hosts found.
      const search = bar.getByRole('combobox', { name: 'Search values to filter by' });
      await search.fill(hostB.slice(0, 6));
      const found = page.getByRole('listbox', { name: 'Filters to add' });
      await expect(found.getByRole('option', { name: new RegExp(`Host\\s+${hostB.replace(/[.]/g, '\\.')}`) })).toBeVisible({ timeout: 15_000 });
      await found.getByRole('option', { name: /Host contains/ }).click();
      await expect(page).toHaveURL(/filter=%7Ehost/);
      // Clicking the operator turns the filter around.
      await bar.getByRole('button', { name: new RegExp(`Host contains .*: change to does not contain`) }).click();
      await expect(page).toHaveURL(/filter=%21%7Ehost/);
      await bar.getByRole('button', { name: /Remove filter: Host does not contain/ }).click();

      // Clear filters removes every filter, the starting path one included.
      await bar.getByRole('button', { name: 'Clear filters' }).click();
      await expect(page.getByRole('button', { name: /^Remove filter:/ })).toHaveCount(0);
      await expect(bar.getByRole('button', { name: 'Clear filters' })).not.toBeVisible();
    } finally {
      await ch
        .command({
          query: `ALTER TABLE traffic_events DELETE WHERE uri = {p:String} SETTINGS mutations_sync = 2`,
          query_params: { p: path },
        })
        .catch(() => {
          /* best-effort cleanup */
        });
      await ch.close();
    }
  });
});
