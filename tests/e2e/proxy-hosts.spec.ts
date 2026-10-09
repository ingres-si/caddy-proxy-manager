import { test, expect, type Page } from '@playwright/test';
import { findHostRow, proxyHostIdByName } from '../helpers/proxy-api';

const API_PROXY_HOSTS = 'http://localhost:3000/api/v1/proxy-hosts';

/** Opens the row menu of the host named `name` (found with the list's search). */
async function openRowMenu(page: Page, name: string) {
  const row = await findHostRow(page, name);
  await row.getByRole('button', { name: /^more actions for/i }).click();
  return row;
}

/**
 * Runs `fn` with one host in the list, so the table (and its sortable
 * headers) shows even when this spec runs on an empty stack.
 */
async function withHost(page: Page, name: string, domain: string, fn: () => Promise<void>) {
  const origin = new URL(page.url()).origin;
  const created = await (await page.request.post(API_PROXY_HOSTS, {
    headers: { Origin: origin },
    data: { name, domains: [domain], upstreams: ['localhost:9978'] },
  })).json() as { id: number };
  try {
    await page.reload();
    await fn();
  } finally {
    await page.request.delete(`${API_PROXY_HOSTS}/${created.id}`, { headers: { Origin: origin } });
  }
}

test.describe('Proxy Hosts', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/proxy-hosts');
  });

  test('page loads with the New proxy host link', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1, name: /proxy hosts/i })).toBeVisible();
    // The header's link (an empty list shows a second one in its empty state).
    await expect(page.getByRole('link', { name: /new proxy host/i }).first()).toHaveAttribute('href', '/proxy-hosts/new');
  });

  test('the create deep link opens the host editor', async ({ page }) => {
    await page.goto('/proxy-hosts?create=1');
    await expect(page).toHaveURL(/\/proxy-hosts\/new$/);
    await expect(page.getByLabel('Add domains')).toBeVisible();
  });

  test('the edit deep link opens that host\'s page at Routing', async ({ page }) => {
    const origin = new URL(page.url()).origin;
    const created = await (await page.request.post(API_PROXY_HOSTS, {
      headers: { Origin: origin },
      data: { name: 'Edit Deep Link Host', domains: ['edit-deep-link.local'], upstreams: ['localhost:9979'] },
    })).json() as { id: number };
    try {
      await page.goto(`/proxy-hosts?edit=${created.id}`);
      await expect(page).toHaveURL(new RegExp(`/proxy-hosts/${created.id}#routing$`));
      await expect(page.getByRole('heading', { level: 1, name: 'edit-deep-link.local' })).toBeVisible();
      await expect(page.getByRole('tab', { name: /^Routing/ })).toHaveAttribute('aria-selected', 'true');
    } finally {
      await page.request.delete(`${API_PROXY_HOSTS}/${created.id}`, { headers: { Origin: origin } });
    }
  });

  test('clicking the Host header sorts the table', async ({ page }) => {
    await withHost(page, 'Sort By Host', 'sort-by-host.local', async () => {
      const sortBtn = page.getByRole('button', { name: 'Host', exact: true });
      await expect(sortBtn).toBeVisible({ timeout: 10_000 });

      // Click to sort ascending
      await sortBtn.click();
      await expect(page).toHaveURL(/sortBy=host/);
      await expect(page).toHaveURL(/sortDir=asc/);

      // Click again to toggle to descending
      await sortBtn.click();
      await expect(page).toHaveURL(/sortDir=desc/);
    });
  });

  test('clicking Status header sorts by status', async ({ page }) => {
    await withHost(page, 'Sort By Status', 'sort-by-status.local', async () => {
      const sortBtn = page.getByRole('button', { name: 'Status', exact: true });
      await expect(sortBtn).toBeVisible();

      await sortBtn.click();
      await expect(page).toHaveURL(/sortBy=status/);
    });
  });

  test('the status filter shows disabled hosts only', async ({ page }) => {
    const origin = new URL(page.url()).origin;
    const created = await (await page.request.post(API_PROXY_HOSTS, {
      headers: { Origin: origin },
      data: { name: 'Status Filter Disabled', domains: ['status-filter-disabled.local'], upstreams: ['localhost:9984'], enabled: false },
    })).json() as { id: number };
    try {
      await page.goto('/proxy-hosts?search=status-filter');
      await page.getByRole('group', { name: 'Status' }).getByRole('button', { name: /^Disabled/ }).click();
      await expect(page).toHaveURL(/status=disabled/);
      const row = page.locator('tr', { hasText: 'Status Filter Disabled' });
      await expect(row).toBeVisible({ timeout: 10_000 });
      await expect(row.getByText('Disabled', { exact: true })).toBeVisible();
    } finally {
      await page.request.delete(`${API_PROXY_HOSTS}/${created.id}`, { headers: { Origin: origin } });
    }
  });

  /**
   * Regression test for #120: Toggling a proxy host disabled then re-enabled
   * from the list wiped custom configs (redirects, rewrite, location_rules)
   * because they were not included in existingMeta when updateProxyHost was
   * called with only { enabled }.
   */
  test('toggling enabled/disabled preserves redirects and rewrite config (#120)', async ({ page }) => {
    const origin = new URL(page.url()).origin;

    // Create a host with redirect rules and a rewrite config via the REST API
    const createResp = await page.request.post(API_PROXY_HOSTS, {
      headers: { Origin: origin },
      data: {
        name: 'Toggle Persistence Test',
        domains: ['toggle-persist.local'],
        upstreams: ['localhost:9988'],
        redirects: [{ from: '/.well-known/carddav', to: '/remote.php/dav/', status: 308 }],
        rewrite: { path_prefix: '/app' },
      },
    });
    expect(createResp.ok()).toBeTruthy();
    const created = await createResp.json() as { id: number; redirects: unknown[]; rewrite: unknown };
    expect(created.redirects).toHaveLength(1);
    expect(created.rewrite).toBeDefined();

    const readHost = async () => (await page.request.get(`${API_PROXY_HOSTS}/${created.id}`)).json() as Promise<{
      redirects: unknown[]; rewrite: unknown; enabled: boolean
    }>;

    try {
      // Disable the host from its row menu
      await openRowMenu(page, 'Toggle Persistence Test');
      await page.getByRole('menuitem', { name: 'Disable' }).click();
      await expect.poll(async () => (await readHost()).enabled, { timeout: 10000 }).toBe(false);

      // Verify redirects and rewrite survive the disable toggle
      const afterDisable = await readHost();
      expect(afterDisable.redirects).toHaveLength(1);
      expect(afterDisable.rewrite).toBeDefined();

      // Re-enable
      await openRowMenu(page, 'Toggle Persistence Test');
      await page.getByRole('menuitem', { name: 'Enable' }).click();
      await expect.poll(async () => (await readHost()).enabled, { timeout: 10000 }).toBe(true);

      // Verify redirects and rewrite survive the re-enable toggle
      const afterEnable = await readHost();
      expect(afterEnable.redirects).toHaveLength(1);
      expect(afterEnable.rewrite).toBeDefined();
    } finally {
      await page.request.delete(`${API_PROXY_HOSTS}/${created.id}`, { headers: { Origin: origin } });
    }
  });

  test('delete proxy host removes it from table', async ({ page }) => {
    // Create one to delete (the host editor has its own spec, proxy-hosts-editor.spec.ts)
    const origin = new URL(page.url()).origin;
    const createResp = await page.request.post(API_PROXY_HOSTS, {
      headers: { Origin: origin },
      data: { name: 'Host To Delete', domains: ['delete-me.local'], upstreams: ['localhost:7777'] },
    });
    expect(createResp.ok()).toBeTruthy();
    await page.reload();
    await expect(page.getByRole('table').getByText('Host To Delete')).toBeVisible({ timeout: 10000 });

    // Open the row menu for that host and click Delete
    await openRowMenu(page, 'Host To Delete');
    await page.getByRole('menuitem', { name: /delete/i }).click();

    // Confirm dialog
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: /^delete$/i }).click();

    // Wait for dialog to close, then verify the row is gone from the table
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10000 });
    await expect(page.locator('tbody').getByText('Host To Delete')).not.toBeVisible({ timeout: 5000 });
  });

  /**
   * The Protection column shows an "SSO" pill when a host has Ingressi
   * forward auth (sign-in with dashboard accounts) enabled, and only then.
   */
  test('SSO protection pill shows for hosts with Ingressi forward auth enabled', async ({ page }) => {
    const origin = new URL(page.url()).origin;

    // Host WITH forward auth enabled. Names avoid "SSO" so the pill assertions
    // (exact: true) never match the host's name cell.
    const withResp = await page.request.post(API_PROXY_HOSTS, {
      headers: { Origin: origin },
      data: {
        name: 'FwdAuth Badge Host',
        domains: ['fwdauth-badge.local'],
        upstreams: ['localhost:9777'],
        ingressiForwardAuth: { enabled: true },
      },
    });
    expect(withResp.ok()).toBeTruthy();
    const withHost = await withResp.json() as { id: number; ingressiForwardAuth: { enabled: boolean } | null };
    expect(withHost.ingressiForwardAuth?.enabled).toBe(true);

    // Host WITHOUT forward auth — used to confirm the pill is conditional
    const withoutResp = await page.request.post(API_PROXY_HOSTS, {
      headers: { Origin: origin },
      data: {
        name: 'Plain Proxy Host',
        domains: ['plain-proxy.local'],
        upstreams: ['localhost:9778'],
      },
    });
    expect(withoutResp.ok()).toBeTruthy();
    const withoutHost = await withoutResp.json() as { id: number };

    try {
      const enabledRow = await findHostRow(page, 'FwdAuth Badge Host');
      await expect(enabledRow.getByText('SSO', { exact: true })).toBeVisible({ timeout: 10000 });

      // The host without forward auth must NOT render the pill.
      const disabledRow = await findHostRow(page, 'Plain Proxy Host');
      await expect(disabledRow.getByText('SSO', { exact: true })).toHaveCount(0);
    } finally {
      await page.request.delete(`${API_PROXY_HOSTS}/${withHost.id}`, { headers: { Origin: origin } });
      await page.request.delete(`${API_PROXY_HOSTS}/${withoutHost.id}`, { headers: { Origin: origin } });
    }
  });

  test('bulk actions tag, disable and delete the selected hosts', async ({ page }) => {
    const origin = new URL(page.url()).origin;
    const ids: number[] = [];
    for (const n of [1, 2]) {
      const resp = await page.request.post(API_PROXY_HOSTS, {
        headers: { Origin: origin },
        data: { name: `Bulk E2E ${n}`, domains: [`bulk-e2e-${n}.local`], upstreams: [`localhost:970${n}`] },
      });
      expect(resp.ok()).toBeTruthy();
      ids.push(((await resp.json()) as { id: number }).id);
    }
    const readHost = async (id: number) =>
      (await page.request.get(`${API_PROXY_HOSTS}/${id}`)).json() as Promise<{ enabled: boolean; tags: string[] }>;
    const selectBoth = async () => {
      await page.goto('/proxy-hosts?search=bulk-e2e');
      await page.getByRole('checkbox', { name: 'Select bulk-e2e-1.local' }).click();
      await page.getByRole('checkbox', { name: 'Select bulk-e2e-2.local' }).click();
      await expect(page.getByText('2 hosts selected')).toBeVisible();
    };

    try {
      await selectBoth();
      await page.getByRole('button', { name: 'Add tag' }).click();
      await page.getByLabel('Tag', { exact: true }).fill('bulk-e2e');
      await page.getByRole('button', { name: 'Add to 2 hosts' }).click();
      await expect.poll(async () => (await readHost(ids[1])).tags, { timeout: 10000 }).toContain('bulk-e2e');
      expect((await readHost(ids[0])).tags).toContain('bulk-e2e');

      await selectBoth();
      await page.getByRole('button', { name: 'Disable', exact: true }).click();
      await expect.poll(async () => (await readHost(ids[0])).enabled, { timeout: 10000 }).toBe(false);
      expect((await readHost(ids[1])).enabled).toBe(false);

      await selectBoth();
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Delete 2 proxy hosts' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect.poll(async () => (await page.request.get(`${API_PROXY_HOSTS}/${ids[0]}`)).status(), { timeout: 10000 }).toBe(404);
      expect((await page.request.get(`${API_PROXY_HOSTS}/${ids[1]}`)).status()).toBe(404);
    } finally {
      for (const id of ids) await page.request.delete(`${API_PROXY_HOSTS}/${id}`, { headers: { Origin: origin } });
    }
  });

  test('the host name opens the host page', async ({ page }) => {
    const origin = new URL(page.url()).origin;
    const resp = await page.request.post(API_PROXY_HOSTS, {
      headers: { Origin: origin },
      // Two upstreams: with one, the page does not offer health checks (they would only refuse requests).
      data: { name: 'Detail Page Host', domains: ['detail-page.local', 'www.detail-page.local'], upstreams: ['http://localhost:9779', 'http://localhost:9780'] },
    });
    expect(resp.ok()).toBeTruthy();
    const created = (await resp.json()) as { id: number };

    try {
      const row = await findHostRow(page, 'Detail Page Host');
      await row.getByRole('link', { name: 'detail-page.local' }).click();
      await expect(page).toHaveURL(new RegExp(`/proxy-hosts/${created.id}$`));
      await expect(page.getByRole('heading', { level: 1, name: 'detail-page.local' })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Proxy hosts' })).toHaveAttribute('href', '/proxy-hosts');
      // One page: Overview, the editor's sections and History are tabs of it.
      await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tab', { name: /^Routing/ })).toHaveAttribute('href', '#routing');
      await expect(page.getByRole('link', { name: 'Edit host' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Configuration' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Upstreams' })).toBeVisible();
      await expect(page.getByText('http://localhost:9779')).toBeVisible();
      await expect(page.getByText('Health checks are off')).toBeVisible();
      await page.getByRole('tab', { name: /^History/ }).click();
      await expect(page.getByRole('heading', { name: 'Changes to this host' })).toBeVisible();
      await page.getByRole('tab', { name: 'Overview' }).click();
      // Nothing needs attention: that is all the status says, not that the upstreams were checked.
      await expect(page.getByText('No issues', { exact: true }).first()).toBeVisible();

      // Turn on health checks: the editor opens with passive checks on, as an unsaved change.
      await page.getByRole('link', { name: 'Turn on health checks' }).click();
      await expect(page).toHaveURL(new RegExp(`/proxy-hosts/${created.id}#routing$`));
      const passive = page.getByRole('switch', { name: 'Passive health checks' });
      await expect(passive).toBeChecked();
      await expect(passive).toBeFocused();
      await expect(page.getByLabel('Remember failures for')).toHaveValue('30s');
      const bar = page.getByTestId('host-editor-bar');
      await bar.getByRole('button', { name: 'Review changes' }).click();
      await page.getByRole('region', { name: /^Review \d+ changes? to Detail Page Host$/ }).getByRole('button', { name: 'Save changes' }).click();
      await expect(bar.getByText('Saved', { exact: true })).toBeVisible({ timeout: 15_000 });

      await page.goto(`/proxy-hosts/${created.id}`);
      await expect(page.getByText('Passive: taken out after 1 failure within 30s.')).toBeVisible();
      await expect(page.getByText('Health checks are off')).not.toBeVisible();
    } finally {
      await page.request.delete(`${API_PROXY_HOSTS}/${created.id}`, { headers: { Origin: origin } });
    }
  });

  test('an unknown host page answers 404', async ({ page }) => {
    const response = await page.goto('/proxy-hosts/999999');
    expect(response?.status()).toBe(404);
  });

  test('GET /api/v1/proxy-hosts/{id}/health reports the upstreams from Caddy', async ({ page }) => {
    const origin = new URL(page.url()).origin;
    const resp = await page.request.post(API_PROXY_HOSTS, {
      headers: { Origin: origin },
      data: { name: 'Health API Host', domains: ['health-api.local'], upstreams: ['localhost:9780'] },
    });
    expect(resp.ok()).toBeTruthy();
    const created = (await resp.json()) as { id: number };
    try {
      const id = await proxyHostIdByName(page, 'Health API Host');
      const health = await page.request.get(`${API_PROXY_HOSTS}/${id}/health`);
      expect(health.status()).toBe(200);
      const body = (await health.json()) as { proxyHostId: number; caddyReachable: boolean; upstreams: Array<{ dial: string; status: string }> };
      expect(body.proxyHostId).toBe(id);
      expect(body.caddyReachable).toBe(true);
      expect(body.upstreams).toHaveLength(1);
      expect(body.upstreams[0].dial).toBe('localhost:9780');
      expect(['unchecked', 'unknown', 'degraded']).toContain(body.upstreams[0].status);
      expect((await page.request.get(`${API_PROXY_HOSTS}/999999/health`)).status()).toBe(404);
    } finally {
      await page.request.delete(`${API_PROXY_HOSTS}/${created.id}`, { headers: { Origin: origin } });
    }
  });
});
