/**
 * E2E tests: L4 Proxy Hosts page.
 *
 * Verifies the L4 Proxy Hosts UI: navigation, the list (search, filters,
 * sort, pages, bulk actions), a host's page with its tabs, the editor for a
 * new host, and the delete dialog.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

const BASE_URL = 'http://localhost:3000';
const API = `${BASE_URL}/api/v1`;
const FIXTURE = 'E2E L4 Fixture';

/**
 * The page shows an empty state instead of its toolbar and table while there
 * are no L4 hosts at all, so the filter and sort tests make sure one exists.
 * It is disabled, so it needs no published port.
 */
/** Fills the editor for a new L4 host (/l4-proxy-hosts/new) with the fields every host needs. */
async function fillNewHost(page: Page, name: string, listenAddress: string, upstream = '10.0.0.1:5432') {
  await page.goto('/l4-proxy-hosts/new');
  await expect(page.locator('nav[data-host-tabs][data-hydrated="true"]')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Listen address').fill(listenAddress);
  await page.getByLabel('Upstream 1', { exact: true }).fill(upstream);
}

/** Creates the host in the editor and waits for its page. */
async function createFilledHost(page: Page, name: string) {
  await page.getByTestId('host-editor-bar').getByRole('button', { name: 'Create host' }).click();
  await expect(page).toHaveURL(/\/l4-proxy-hosts\/\d+$/, { timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

async function ensureFixtureHost(page: Page) {
  const list = await page.request.get(`${API}/l4-proxy-hosts`, { headers: { Origin: BASE_URL } });
  expect(list.ok()).toBe(true);
  const hosts = (await list.json()) as Array<{ name: string }>;
  if (hosts.some((host) => host.name === FIXTURE)) return;
  const created = await page.request.post(`${API}/l4-proxy-hosts`, {
    data: { name: FIXTURE, protocol: 'tcp', listenAddress: ':19998', upstreams: ['10.0.0.1:5432'], enabled: false },
    headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
  });
  expect(created.status()).toBe(201);
}

test.describe('L4 Proxy Hosts page', () => {
  test('is accessible from sidebar navigation', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'L4 hosts', exact: true }).first().click();
    await expect(page).toHaveURL(/\/l4-proxy-hosts/);
    await expect(page.getByRole('heading', { level: 1, name: /^L4 hosts/ })).toBeVisible();
  });

  test('shows empty state when search has no results', async ({ page }) => {
    await ensureFixtureHost(page);
    await page.goto('/l4-proxy-hosts');
    await page.getByRole('searchbox', { name: 'Filter L4 hosts' }).fill('zzz-nonexistent-host-zzz');
    await expect(page).toHaveURL(/search=zzz-nonexistent-host-zzz/);
    await expect(page.getByText(/no l4 host matches these filters/i).last()).toBeVisible({ timeout: 5_000 });
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).not.toHaveURL(/search=/);
  });

  test('keeps the search deep link', async ({ page }) => {
    await ensureFixtureHost(page);
    await page.goto('/l4-proxy-hosts?search=zzz-deep-link-zzz');
    await expect(page.getByRole('searchbox', { name: 'Filter L4 hosts' })).toHaveValue('zzz-deep-link-zzz');
    await expect(page.getByText(/no l4 host matches these filters/i).last()).toBeVisible({ timeout: 5_000 });
  });

  test('filters by protocol', async ({ page }) => {
    await ensureFixtureHost(page);
    await page.goto('/l4-proxy-hosts');
    const protocol = page.getByRole('group', { name: 'Protocol' });
    await protocol.getByRole('button', { name: /^UDP/ }).click();
    await expect(page).toHaveURL(/protocol=udp/);
    await expect(protocol.getByRole('button', { name: /^UDP/ })).toHaveAttribute('aria-pressed', 'true');
    await protocol.getByRole('button', { name: /^All/ }).click();
    await expect(page).not.toHaveURL(/protocol=/);
  });

  test('New L4 host opens the editor with the expected fields', async ({ page }) => {
    await page.goto('/l4-proxy-hosts');
    await page.getByRole('link', { name: /new l4 host/i }).first().click();
    await expect(page).toHaveURL(/\/l4-proxy-hosts\/new$/);
    await expect(page.getByRole('heading', { level: 1, name: 'New L4 host' })).toBeVisible();

    await expect(page.getByLabel('Name', { exact: true })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Protocol' })).toBeVisible();
    await expect(page.getByLabel('Listen address')).toBeVisible();
    await expect(page.getByLabel('Upstream 1', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Matcher')).toBeVisible();
    for (const tab of ['Routing', 'Load balancing', 'Security', 'Advanced']) {
      await expect(page.getByRole('tab', { name: tab })).toBeVisible();
    }
  });

  test('clicking Name header sorts the table', async ({ page }) => {
    await ensureFixtureHost(page);
    await page.goto('/l4-proxy-hosts');
    const sortBtn = page.getByRole('columnheader', { name: 'Name' }).getByRole('button');
    await expect(sortBtn).toBeVisible();

    await sortBtn.click();
    await expect(page).toHaveURL(/sortBy=name/);
    await expect(page).toHaveURL(/sortDir=asc/);

    // Click again to toggle direction
    await sortBtn.click();
    await expect(page).toHaveURL(/sortDir=desc/);
  });

  test('clicking Status header sorts by enabled state', async ({ page }) => {
    await ensureFixtureHost(page);
    await page.goto('/l4-proxy-hosts');
    const sortBtn = page.getByRole('columnheader', { name: 'Status' }).getByRole('button');
    await expect(sortBtn).toBeVisible();

    await sortBtn.click();
    await expect(page).toHaveURL(/sortBy=enabled/);
  });

  test('clicking Listen header sorts by listen address', async ({ page }) => {
    await ensureFixtureHost(page);
    await page.goto('/l4-proxy-hosts');
    const sortBtn = page.getByRole('columnheader', { name: 'Listen' }).getByRole('button');
    await expect(sortBtn).toBeVisible();

    await sortBtn.click();
    await expect(page).toHaveURL(/sortBy=listenAddress/);
  });

  test('creates a new L4 proxy host', async ({ page }) => {
    await fillNewHost(page, 'E2E Test Host', ':19999');
    await createFilledHost(page, 'E2E Test Host');

    await page.goto('/l4-proxy-hosts');
    await expect(page.getByRole('table').getByText('E2E Test Host')).toBeVisible();
    await expect(page.getByRole('table').getByText(':19999', { exact: true })).toBeVisible();
  });

  test("opening a host shows its page, and its tabs change it in place", async ({ page }) => {
    await page.goto('/l4-proxy-hosts');
    await page.getByRole('table').getByRole('link', { name: 'E2E Test Host', exact: true }).click();
    await expect(page).toHaveURL(/\/l4-proxy-hosts\/\d+$/);
    await expect(page.getByRole('heading', { level: 1, name: 'E2E Test Host' })).toBeVisible();
    await expect(page.getByText(':19999/tcp')).toBeVisible();
    await expect(page.getByRole('term').filter({ hasText: /^Upstream$/ })).toBeVisible();
    await expect(page.getByRole('definition').filter({ hasText: '10.0.0.1:5432' })).toBeVisible();
    // No save bar until something changes.
    await expect(page.getByTestId('host-editor-bar')).toHaveCount(0);

    await page.getByRole('link', { name: 'Edit routing' }).click();
    await expect(page).toHaveURL(/#routing$/);
    await expect(page.getByRole('tab', { name: 'Routing' })).toHaveAttribute('aria-selected', 'true');
    await page.getByLabel('Upstream 1', { exact: true }).fill('10.0.0.2:5432');
    const bar = page.getByTestId('host-editor-bar');
    await expect(bar).toContainText('1 unsaved change');
    // Switching tabs keeps the change.
    await page.getByRole('tab', { name: 'Security' }).click();
    await page.getByRole('tab', { name: 'Routing' }).click();
    await expect(page.getByLabel('Upstream 1', { exact: true })).toHaveValue('10.0.0.2:5432');

    await bar.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(bar).toContainText('Saved', { timeout: 10_000 });
    await bar.getByRole('button', { name: 'Show overview' }).click();
    await expect(page.getByRole('definition').filter({ hasText: '10.0.0.2:5432' })).toBeVisible();
  });

  /**
   * Regression (#295): an L4 host listening on 80/443/2019 collides with
   * Ingressi's own Caddy listeners. SO_REUSEPORT makes the bind succeed, so the
   * conflict is not reported — instead connections are silently split between
   * the two listeners and ~50% of TLS handshakes fail. Creating such a host
   * must be rejected with an explanatory error and the dialog must stay open.
   */
  test('rejects a listen address on reserved port 443', async ({ page }) => {
    await fillNewHost(page, 'E2E Reserved Port Host', ':443', '10.0.0.1:8443');
    await page.getByTestId('host-editor-bar').getByRole('button', { name: 'Create host' }).click();

    // The editor stays open with the problem on the field.
    await expect(page.getByText(/port 443 is caddy's own/i)).toBeVisible();
    await expect(page).toHaveURL(/\/l4-proxy-hosts\/new/);
    const list = await page.request.get(`${API}/l4-proxy-hosts`, { headers: { Origin: BASE_URL } });
    expect(((await list.json()) as Array<{ name: string }>).some((host) => host.name === 'E2E Reserved Port Host')).toBe(false);
  });

  test('listen address field documents the reserved ports', async ({ page }) => {
    await page.goto('/l4-proxy-hosts/new');
    await expect(page.getByText(/ports 80, 443 and 2019 are caddy's own/i)).toBeVisible();
  });

  test('deletes the created L4 proxy host', async ({ page }) => {
    await page.goto('/l4-proxy-hosts');
    await expect(page.getByRole('table').getByText('E2E Test Host')).toBeVisible();

    // Open the dropdown menu for that row and click Delete
    const row = page.locator('tr', { hasText: 'E2E Test Host' });
    await row.getByRole('button', { name: 'More actions for E2E Test Host' }).click();
    await page.getByRole('menuitem', { name: /delete/i }).click();

    // Confirm deletion
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog').getByText('Delete E2E Test Host?')).toBeVisible();
    await expect(page.getByRole('dialog').getByText('This cannot be undone.')).toBeVisible();
    await page.getByRole('button', { name: /delete/i }).click();

    // Host should be removed
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('E2E Test Host')).not.toBeVisible({ timeout: 5_000 });
  });

  /**
   * Regression (#241): creating multiple L4 hosts back-to-back left the list
   * stale until a manual browser refresh. Each new host must be in the list
   * when it is opened next, even on rapid successive creates.
   */
  test('rapid successive creates are all reflected in the list', async ({ page }) => {
    for (let i = 1; i <= 3; i++) {
      await fillNewHost(page, `E2E Rapid Host ${i}`, `:2000${i}`);
      await createFilledHost(page, `E2E Rapid Host ${i}`);
      await page.getByRole('link', { name: 'L4 hosts' }).first().click();
      await expect(page.getByRole('table').getByText(`E2E Rapid Host ${i}`)).toBeVisible({ timeout: 10_000 });
    }
  });

  test('cleanup rapid hosts', async ({ page }) => {
    await page.goto('/l4-proxy-hosts');
    for (let i = 1; i <= 3; i++) {
      const row = page.locator('tr', { hasText: `E2E Rapid Host ${i}` });
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: `More actions for E2E Rapid Host ${i}` }).click();
      await page.getByRole('menuitem', { name: /delete/i }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('button', { name: /delete/i }).click();
      await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(`E2E Rapid Host ${i}`)).not.toBeVisible({ timeout: 5_000 });
    }
  });

  /**
   * Regression (#241): toggling a host's enabled switch updated the DB but
   * the row kept showing the old status until a browser refresh.
   */
  test('toggling enabled updates the row status without reload', async ({ page }) => {
    await fillNewHost(page, 'E2E Toggle Host', ':20010');
    await createFilledHost(page, 'E2E Toggle Host');
    await page.goto('/l4-proxy-hosts');

    const row = page.locator('tr', { hasText: 'E2E Toggle Host' });
    const rowSwitch = row.getByRole('switch').first();
    await expect(row).toBeVisible();

    // Toggle off — the row must show the new status without a reload
    await expect(rowSwitch).toHaveAttribute('data-state', 'checked');
    await rowSwitch.click();
    await expect(rowSwitch).toHaveAttribute('data-state', 'unchecked', { timeout: 10_000 });

    // Toggle back on
    await rowSwitch.click();
    await expect(rowSwitch).toHaveAttribute('data-state', 'checked', { timeout: 10_000 });

    // Cleanup
    await row.getByRole('button', { name: 'More actions for E2E Toggle Host' }).click();
    await page.getByRole('menuitem', { name: /delete/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: /delete/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('E2E Toggle Host')).not.toBeVisible({ timeout: 5_000 });
  });

  test('cleanup fixture host', async ({ page }) => {
    const list = await page.request.get(`${API}/l4-proxy-hosts`, { headers: { Origin: BASE_URL } });
    const hosts = (await list.json()) as Array<{ id: number; name: string }>;
    for (const host of hosts.filter((h) => h.name === FIXTURE)) {
      const res = await page.request.delete(`${API}/l4-proxy-hosts/${host.id}`, { headers: { Origin: BASE_URL } });
      expect(res.ok()).toBe(true);
    }
  });
});

/**
 * The list with more hosts than fit on a page: 62 disabled hosts (every
 * third one UDP, one routing by TLS SNI) created through the REST API and
 * removed again afterwards.
 */
const MANY = 62;
const MANY_PREFIX = 'E2E Many L4';
const manyName = (i: number) => `${MANY_PREFIX} ${String(i).padStart(2, '0')}`;
const MANY_LIST = `/l4-proxy-hosts?search=${encodeURIComponent(MANY_PREFIX)}&sortBy=name&sortDir=asc`;

async function deleteManyHosts(request: APIRequestContext) {
  const list = await request.get(`${API}/l4-proxy-hosts`, { headers: { Origin: BASE_URL } });
  expect(list.ok()).toBe(true);
  const hosts = (await list.json()) as Array<{ id: number; name: string }>;
  for (const host of hosts.filter((h) => h.name.startsWith(MANY_PREFIX))) {
    const res = await request.delete(`${API}/l4-proxy-hosts/${host.id}`, { headers: { Origin: BASE_URL } });
    expect(res.ok()).toBe(true);
  }
}

test.describe.serial('L4 hosts list with many hosts', () => {
  test.beforeAll(async ({ request }) => {
    test.setTimeout(240_000);
    await deleteManyHosts(request);
    for (let i = 1; i <= MANY; i++) {
      const res = await request.post(`${API}/l4-proxy-hosts`, {
        data: {
          name: manyName(i),
          protocol: i % 3 === 0 ? 'udp' : 'tcp',
          listenAddress: `:${43000 + i}`,
          upstreams: [`192.0.2.${i}:5432`],
          enabled: false,
          ...(i === 7 ? { matcherType: 'tls_sni', matcherValue: ['mail-07.example.com'] } : {}),
        },
        headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
      });
      expect(res.status()).toBe(201);
    }
  });

  test.afterAll(async ({ request }) => {
    test.setTimeout(240_000);
    await deleteManyHosts(request);
  });

  test('pages the list with the page in the address', async ({ page }) => {
    await page.goto(MANY_LIST);
    const table = page.getByRole('table');
    const pager = page.getByRole('navigation', { name: 'Pages of L4 hosts' });
    await expect(pager).toContainText('1–25 of 62 hosts');
    await expect(table.getByRole('row')).toHaveCount(26);
    await expect(table.getByRole('link', { name: manyName(1), exact: true })).toBeVisible();

    await pager.getByRole('link', { name: 'Next page' }).click();
    await expect(page).toHaveURL(/[?&]page=2/);
    await expect(pager).toContainText('26–50 of 62 hosts');
    await expect(table.getByRole('link', { name: manyName(26), exact: true })).toBeVisible();
    await expect(table.getByRole('link', { name: manyName(1), exact: true })).toHaveCount(0);

    await pager.getByRole('link', { name: 'Page 3' }).click();
    await expect(page).toHaveURL(/[?&]page=3/);
    await expect(table.getByRole('row')).toHaveCount(13);
    await page.reload();
    await expect(pager).toContainText('51–62 of 62 hosts');
    await expect(table.getByRole('link', { name: manyName(62), exact: true })).toBeVisible();

    // A new search starts on the first page; 10 hosts fit on one page, so there is no pager.
    await page.getByRole('searchbox', { name: 'Filter L4 hosts' }).fill(`${MANY_PREFIX} 1`);
    await expect(page).toHaveURL(/search=E2E\+Many\+L4\+1/);
    await expect(page).not.toHaveURL(/[?&]page=/);
    await expect(table.getByRole('row')).toHaveCount(11);
    await expect(pager).toHaveCount(0);
  });

  test('finds a host by server name, port or upstream', async ({ page }) => {
    await page.goto('/l4-proxy-hosts');
    const search = page.getByRole('searchbox', { name: 'Filter L4 hosts' });
    const table = page.getByRole('table');
    for (const [text, i] of [['mail-07.example.com', 7], [':43042', 42], ['192.0.2.33:', 33]] as const) {
      await search.fill(text);
      await expect(table.getByRole('link', { name: manyName(i), exact: true })).toBeVisible();
      await expect(table.getByRole('row')).toHaveCount(2);
    }
    await expect(table.getByText('mail-07.example.com', { exact: true })).toHaveCount(0);
    await search.fill('mail-07');
    await expect(table.getByText('mail-07.example.com', { exact: true })).toBeVisible();
  });

  test('counts and filters by protocol and status within the search', async ({ page }) => {
    await page.goto(MANY_LIST);
    const protocol = page.getByRole('group', { name: 'Protocol' });
    const status = page.getByRole('group', { name: 'Status' });
    await expect(protocol.getByRole('button', { name: /^UDP/ })).toHaveText('UDP 20');
    await expect(status.getByRole('button', { name: /^Disabled/ })).toHaveText('Disabled 62');
    await protocol.getByRole('button', { name: /^UDP/ }).click();
    await expect(page).toHaveURL(/protocol=udp/);
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(21);
    await expect(page.getByRole('navigation', { name: 'Pages of L4 hosts' })).toHaveCount(0);
    await expect(status.getByRole('button', { name: /^Disabled/ })).toHaveText('Disabled 20');
    await status.getByRole('button', { name: /^Enabled/ }).click();
    await expect(page).toHaveURL(/status=enabled/);
    await expect(page.getByText(/no l4 host matches these filters/i)).toBeVisible();
  });

  test('shows cards and the pager on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${MANY_LIST}&page=2`);
    await expect(page.getByRole('table')).toBeHidden();
    const cards = page.getByRole('list', { name: 'L4 hosts' });
    await expect(cards.getByRole('listitem')).toHaveCount(25);
    await expect(cards.getByRole('link', { name: manyName(26), exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Pages of L4 hosts' })).toContainText('26–50 of 62 hosts');
    await expect(page.getByRole('button', { name: 'Sort: Name' })).toBeVisible();
  });

  test('enables, disables and deletes the selected hosts', async ({ page }) => {
    await page.goto(MANY_LIST);
    const table = page.getByRole('table');
    const switchOf = (i: number) => table.locator('tr', { hasText: manyName(i) }).getByRole('switch');
    const select = async (...ids: number[]) => {
      for (const i of ids) await table.getByRole('checkbox', { name: `Select ${manyName(i)}`, exact: true }).check();
    };

    await select(1, 2);
    await expect(page.getByText('2 hosts selected')).toBeVisible();
    await page.getByRole('button', { name: 'Enable', exact: true }).click();
    await expect(switchOf(1)).toHaveAttribute('data-state', 'checked', { timeout: 15_000 });
    await expect(switchOf(2)).toHaveAttribute('data-state', 'checked');
    await expect(page.getByText('2 hosts selected')).toBeHidden();

    await select(1, 2);
    await page.getByRole('button', { name: 'Disable', exact: true }).click();
    await expect(switchOf(1)).toHaveAttribute('data-state', 'unchecked', { timeout: 15_000 });
    await expect(switchOf(2)).toHaveAttribute('data-state', 'unchecked');

    await table.getByRole('checkbox', { name: 'Select every host on this page' }).check();
    await expect(page.getByText('25 hosts selected')).toBeVisible();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete 25 L4 hosts' });
    await expect(dialog).toContainText('This cannot be undone.');
    await expect(dialog.getByRole('listitem')).toHaveCount(25);
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page.getByRole('navigation', { name: 'Pages of L4 hosts' })).toContainText('1–25 of 37 hosts', { timeout: 15_000 });
    await expect(table.getByRole('link', { name: manyName(26), exact: true })).toBeVisible();
  });
});
