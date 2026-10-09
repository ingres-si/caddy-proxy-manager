import { test, expect, type Page } from '@playwright/test';
import { escapeRegExp } from '../helpers/text';

/**
 * The settings pages: Settings itself (the general settings), and the
 * pages next to what they configure (Certificate settings, Host defaults,
 * Geo blocking, Rate limiting, Analytics settings, OAuth providers, Instance
 * sync, High availability, Backups). Old /settings links lead to them.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Every settings page, its heading, and the sidebar entry it is listed under. */
const SETTINGS_PAGES = [
  { path: '/settings', title: 'Settings', entry: 'Settings' },
  { path: '/certificates/settings', title: 'Certificate settings', entry: 'Certificates' },
  { path: '/proxy-hosts/defaults', title: 'Host defaults', entry: 'Proxy hosts' },
  { path: '/geo-blocking', title: 'Geo blocking', entry: 'Security events' },
  { path: '/rate-limiting', title: 'Rate limiting', entry: 'Security events' },
  { path: '/analytics/settings', title: 'Analytics settings', entry: 'Analytics' },
  { path: '/oauth-providers', title: 'OAuth providers', entry: 'Sign-in and directories' },
  { path: '/instances', title: 'Instance sync', entry: 'Fleet' },
  { path: '/high-availability', title: 'High availability', entry: 'High availability' },
  { path: '/backups', title: 'Backups', entry: 'Change history' },
] as const;

/** Open a page and wait until it is interactive: fields typed into before hydration do not count as changes. */
async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

function main(page: Page) {
  return page.getByRole('main');
}

function saveBar(page: Page) {
  return main(page).getByTestId('settings-save-bar');
}

/** The dashboard's command palette (src/components/command-palette). */
function commandPalette(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  return { dialog, input: dialog.getByRole('combobox', { name: 'Search hosts, actions, settings and documentation' }) };
}

// ─── Pages and navigation ────────────────────────────────────────────────────

test.describe('Settings pages — load and navigation', () => {
  for (const { path, title } of SETTINGS_PAGES) {
    test(`${path} loads with its heading`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status() ?? 0).toBeLessThan(400);
      await expect(page).not.toHaveURL(/login/);
      await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
    });
  }

  test('each page is a sub-item of its sidebar entry, marked current', async ({ page }) => {
    for (const { path, title, entry } of SETTINGS_PAGES) {
      if (path === '/high-availability' || path === '/settings') continue; // Entries of their own, with no sub-items.
      await page.goto(path);
      const subItems = page.getByRole('list', { name: entry, exact: true });
      await expect(subItems, path).toBeVisible();
      await expect(subItems.getByRole('link', { name: title, exact: true }), path).toHaveAttribute('aria-current', 'page');
    }
  });

  test('Settings is one page, without the old group list', async ({ page }) => {
    await page.goto('/settings');
    await expect(main(page).getByRole('heading', { level: 2, name: 'General' })).toBeVisible();
    await expect(page.locator('aside[aria-label="Settings navigation"]')).toHaveCount(0);
    await expect(page.getByRole('searchbox', { name: 'Search settings' })).toHaveCount(0);
  });
});

// ─── Old links ───────────────────────────────────────────────────────────────

test.describe('Settings — old links', () => {
  test('?section= links open the page that holds the section', async ({ page }) => {
    await page.goto('/settings?section=dns-providers');
    await expect(page).toHaveURL(/\/certificates\/settings#dns-providers$/);
    await expect(page.getByRole('heading', { name: 'DNS-01 providers' })).toBeVisible();

    await page.goto('/settings?section=logging');
    await expect(page).toHaveURL(/\/analytics\/settings#logging$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Access log' })).toBeVisible();

    await page.goto('/settings?section=default-response');
    await expect(page).toHaveURL(/\/proxy-hosts\/defaults#default-response$/);
    await expect(page.getByRole('heading', { name: 'Requests for unknown hosts' })).toBeVisible();

    await page.goto('/settings?section=authentik');
    await expect(page).toHaveURL(/\/proxy-hosts\/defaults#authentik$/);

    for (const [id, path] of [['sync', '/instances'], ['geoblock', '/geo-blocking'], ['rate-limit', '/rate-limiting'], ['oauth', '/oauth-providers'], ['backups', '/backups'], ['high-availability', '/high-availability']]) {
      await page.goto(`/settings?section=${id}`);
      await expect(page, id).toHaveURL(new RegExp(`${escapeRegExp(path)}$`));
    }
  });

  test('#section and ?group= links open the page that holds the section', async ({ page }) => {
    await page.goto('/settings#geoblock');
    await expect(page).toHaveURL(/\/geo-blocking$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Geo blocking' })).toBeVisible();

    await page.goto('/settings#metrics');
    await expect(page).toHaveURL(/\/analytics\/settings#metrics$/);

    await page.goto('/settings?group=networking');
    await expect(page).toHaveURL(/\/proxy-hosts\/defaults#trusted-proxies$/);
  });
});

// ─── Save bar ────────────────────────────────────────────────────────────────

test.describe('Settings — save bar', () => {
  test('counts unsaved changes and discards them', async ({ page }) => {
    await open(page, '/settings');
    const domain = main(page).locator('input[name="primaryDomain"]');
    const original = await domain.inputValue();
    await domain.fill('unsaved-change.example.com');
    await expect(saveBar(page)).toContainText('1 unsaved change in General');

    await saveBar(page).getByRole('button', { name: 'Discard' }).click();
    await expect(main(page).locator('input[name="primaryDomain"]')).toHaveValue(original);
    await expect(saveBar(page)).toContainText('No unsaved changes');
    await expect(saveBar(page).getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  test('one save bar saves every changed card of Host defaults', async ({ page }) => {
    await open(page, '/proxy-hosts/defaults');
    await expect(saveBar(page)).toHaveCount(1);
    await main(page).getByRole('radio', { name: /^Custom response/ }).check();
    await main(page).getByRole('switch', { name: 'Resolve upstream hostnames when applying' }).click();
    await expect(saveBar(page)).toContainText(/unsaved changes in Host defaults/);
    await saveBar(page).getByRole('button', { name: 'Discard' }).click();
    await expect(saveBar(page)).toContainText('No unsaved changes');
  });
});

// ─── Command palette ─────────────────────────────────────────────────────────

test.describe('Settings — command palette', () => {
  test('Cmd+K opens the command palette', async ({ page }) => {
    await open(page, '/settings');
    await page.keyboard.press('ControlOrMeta+k');
    const { dialog, input } = commandPalette(page);
    await expect(dialog).toBeVisible();
    await expect(input).toBeFocused();
  });

  test('palette finds the sections of the settings pages', async ({ page }) => {
    await open(page, '/settings');
    await page.keyboard.press('ControlOrMeta+k');
    const { dialog, input } = commandPalette(page);
    await input.fill('dns');
    await expect(dialog.getByRole('option', { name: /^DNS-01 providers/ })).toBeVisible();
    await expect(dialog.getByRole('option', { name: /^DNS-01 resolvers/ })).toBeVisible();
  });

  test('typing in the palette filters results', async ({ page }) => {
    await open(page, '/settings');
    await page.keyboard.press('ControlOrMeta+k');
    const { dialog, input } = commandPalette(page);
    await input.fill('geo bl');
    await expect(dialog.getByRole('option', { name: /^Geo blocking/ }).first()).toBeVisible();
    await expect(dialog.getByRole('option', { name: /Instance sync/ })).toHaveCount(0);
  });

  test('selecting a palette result opens its page at the section', async ({ page }) => {
    await open(page, '/settings');
    await page.keyboard.press('ControlOrMeta+k');
    const { dialog, input } = commandPalette(page);
    await input.fill('access log');
    await dialog.getByRole('option', { name: /Access log/ }).first().click();
    await expect(dialog).not.toBeVisible();
    await expect(page).toHaveURL(/\/analytics\/settings#logging$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Analytics settings' })).toBeVisible();
  });

  test('Enter opens the selected result', async ({ page }) => {
    await open(page, '/settings');
    await page.keyboard.press('ControlOrMeta+k');
    const { dialog, input } = commandPalette(page);
    await input.fill('trusted prox');
    await expect(dialog.getByRole('option', { name: /Trusted proxies/ }).first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(dialog).not.toBeVisible();
    await expect(page).toHaveURL(/\/proxy-hosts\/defaults#trusted-proxies$/);
  });

  test('Escape clears the query first, then closes the palette', async ({ page }) => {
    await open(page, '/settings');
    await page.keyboard.press('ControlOrMeta+k');
    const { dialog, input } = commandPalette(page);
    await input.fill('geob');
    await page.keyboard.press('Escape');
    await expect(input).toHaveValue('');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('palette shows "nothing matches" for gibberish query', async ({ page }) => {
    await open(page, '/settings');
    await page.keyboard.press('ControlOrMeta+k');
    const { dialog, input } = commandPalette(page);
    await input.fill('zzzzxyzzy');
    await expect(dialog.getByText(/Nothing matches “zzzzxyzzy”/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Clear the search' }).first().click();
    await expect(input).toHaveValue('');
  });
});

// ─── Instance sync ───────────────────────────────────────────────────────────

test.describe('Instance sync', () => {
  test('shows the mode as Standalone, Master or Replica', async ({ page }) => {
    await open(page, '/instances');
    const mode = main(page).getByRole('group', { name: 'Instance mode' });
    await expect(mode.getByRole('button', { name: 'Standalone' })).toBeVisible();
    await expect(mode.getByRole('button', { name: 'Master' })).toBeVisible();
    await expect(mode.getByRole('button', { name: 'Replica' })).toBeVisible();
    await expect(saveBar(page).getByRole('button', { name: 'Save changes' })).toBeVisible();
  });
});

// ─── General ─────────────────────────────────────────────────────────────────

test.describe('Settings — General', () => {
  test('shows the primary domain and the dashboard address', async ({ page }) => {
    await open(page, '/settings');
    await expect(main(page).getByLabel('Primary domain')).toBeVisible();
    await expect(main(page).getByText('Set by BASE_URL in the environment.')).toBeVisible();
  });

  test('primary domain persists after save and page reload', async ({ page }) => {
    await open(page, '/settings');
    await main(page).getByLabel('Primary domain').fill('persist-test.local');
    await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
    await expect(saveBar(page).getByText('General settings saved successfully')).toBeVisible({ timeout: 10_000 });

    await open(page, '/settings');
    await expect(main(page).getByLabel('Primary domain')).toHaveValue('persist-test.local');

    await main(page).getByLabel('Primary domain').fill('example.com');
    await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
    await expect(saveBar(page).getByText('General settings saved successfully')).toBeVisible({ timeout: 10_000 });
  });
});

// ─── Requests for unknown hosts (issue #241) ────────────────────────────────

test.describe('Host defaults — Requests for unknown hosts', () => {
  test('shows all supported answers and the custom response fields', async ({ page }) => {
    await open(page, '/proxy-hosts/defaults');
    const card = main(page).locator('#default-response');
    for (const name of ['Caddy default', 'Custom response', 'Redirect', 'Close the connection']) {
      await expect(card.getByRole('radio', { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await card.getByRole('radio', { name: /^Custom response/ }).check();
    await expect(card.locator('input[name="status"]')).toHaveValue('404');
    await expect(card.locator('textarea[name="body"]')).toBeVisible();
    await expect(card.locator('textarea[name="headers"]')).toBeVisible();
  });

  test('saves and reloads a custom response', async ({ page }) => {
    await open(page, '/proxy-hosts/defaults');
    let card = main(page).locator('#default-response');
    await card.getByRole('radio', { name: /^Custom response/ }).check();
    await card.locator('input[name="status"]').fill('451');
    await card.locator('textarea[name="body"]').fill('Unavailable for legal reasons');
    await card.locator('textarea[name="headers"]').fill('Content-Type: text/plain; charset=utf-8\nX-Test-Ui: saved');
    await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Default response saved and applied successfully')).toBeVisible({ timeout: 10_000 });

    await open(page, '/proxy-hosts/defaults');
    card = main(page).locator('#default-response');
    await expect(card.getByRole('radio', { name: /^Custom response/ })).toBeChecked();
    await expect(card.locator('input[name="status"]')).toHaveValue('451');
    await expect(card.locator('textarea[name="body"]')).toHaveValue('Unavailable for legal reasons');
    await expect(card.locator('textarea[name="headers"]')).toHaveValue('Content-Type: text/plain; charset=utf-8\nX-Test-Ui: saved');

    await card.getByRole('radio', { name: /^Caddy default/ }).check();
    await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Default response saved and applied successfully')).toBeVisible({ timeout: 10_000 });
  });
});

// ─── Certificate authority (custom ACME directory URL — issue #192) ─────────

test.describe('Certificate settings — Certificate authority', () => {
  const API_SETTINGS_ACME = 'http://localhost:3000/api/v1/settings/acme';
  const CUSTOM_DIR = 'https://ca.internal.example.com/acme/acme/directory';

  test.afterEach(async ({ page }) => {
    // Reset to the Let's Encrypt default so other tests/runs start clean.
    await page.request.put(API_SETTINGS_ACME, { data: { caUrl: '', caRootPem: '' } });
  });

  async function chooseCustom(page: Page) {
    await open(page, '/certificates/settings');
    await main(page).getByRole('group', { name: 'Issuer' }).getByRole('button', { name: 'Custom ACME directory' }).click();
  }

  test('the ACME contact e-mail is on Certificate settings', async ({ page }) => {
    await open(page, '/certificates/settings');
    const email = main(page).getByLabel('Contact e-mail');
    await email.fill('test@example.com');
    await expect(email).toHaveValue('test@example.com');
    await expect(saveBar(page)).toContainText('1 unsaved change in Certificate settings');
  });

  test('shows the directory URL and CA root fields for a custom directory', async ({ page }) => {
    await chooseCustom(page);
    await expect(main(page).locator('input[name="caUrl"]')).toBeVisible();
    await expect(main(page).locator('textarea[name="caRootPem"]')).toBeVisible();
  });

  test('saves a custom directory URL and persists it', async ({ page }) => {
    await chooseCustom(page);
    await main(page).locator('input[name="caUrl"]').fill(CUSTOM_DIR);
    await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
    await expect(saveBar(page).getByText('ACME settings saved successfully')).toBeVisible({ timeout: 10_000 });

    const res = await page.request.get(API_SETTINGS_ACME);
    expect((await res.json()).caUrl).toBe(CUSTOM_DIR);

    await open(page, '/certificates/settings');
    await expect(main(page).locator('input[name="caUrl"]')).toHaveValue(CUSTOM_DIR);
  });

  test('rejects a non-HTTPS directory URL', async ({ page }) => {
    await chooseCustom(page);
    await main(page).locator('input[name="caUrl"]').fill('http://ca.internal.example.com/directory');
    await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(/must use HTTPS/i)).toBeVisible({ timeout: 10_000 });
  });
});

// ─── DNS-01 providers and resolvers ─────────────────────────────────────────

test.describe('Certificate settings — DNS-01', () => {
  test('adding a provider reveals its credential fields', async ({ page }) => {
    await open(page, '/certificates/settings');
    await main(page).getByRole('button', { name: 'Add provider' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox', { name: 'DNS provider' }).click();
    await page.getByRole('option').filter({ hasNotText: /choose a provider/i }).first().click();
    const formInputs = page.locator('form#dnsp-add-form input[type="text"], form#dnsp-add-form input[type="password"]');
    await expect(formInputs.first()).toBeVisible({ timeout: 3000 });
  });

  test('own resolvers show their fields when turned on', async ({ page }) => {
    await open(page, '/certificates/settings');
    const resolvers = main(page).locator('#dns-resolvers');
    const toggle = resolvers.getByRole('switch', { name: 'Use my own resolvers' });
    await expect(toggle).toBeVisible();
    if (!(await toggle.isChecked())) await toggle.click();
    await expect(resolvers.locator('textarea[name="resolvers"]')).toBeVisible();
    await expect(resolvers.locator('textarea[name="fallbacks"]')).toBeVisible();
    await expect(resolvers.locator('input[name="timeout"]')).toBeVisible();
  });
});

// ─── Upstream DNS pinning and forward auth ──────────────────────────────────

test.describe('Host defaults — upstream DNS and forward auth', () => {
  test('upstream DNS pinning shows the switch and the address family choices', async ({ page }) => {
    await open(page, '/proxy-hosts/defaults');
    const card = main(page).locator('#upstream-dns');
    await expect(card.getByRole('switch', { name: 'Resolve upstream hostnames when applying' })).toBeVisible();
    const family = card.getByRole('group', { name: 'Address family' });
    await expect(family.getByRole('button', { name: /both/i })).toBeVisible();
    await expect(family.getByRole('button', { name: /ipv6 only/i })).toBeVisible();
    await expect(family.getByRole('button', { name: /ipv4 only/i })).toBeVisible();
  });

  test('forward auth shows the Authentik fields with their placeholders', async ({ page }) => {
    await open(page, '/proxy-hosts/defaults');
    const group = main(page).locator('#forward-auth');
    await expect(group.getByRole('heading', { name: 'Authentik' })).toBeVisible();
    await expect(group.locator('input[name="outpostDomain"]')).toHaveAttribute('placeholder', 'outpost.goauthentik.io');
    await expect(group.locator('input[name="outpostUpstream"]')).toHaveAttribute('placeholder', 'http://authentik-server:9000');
    await expect(group.getByRole('heading', { name: 'Generic forward auth' })).toBeVisible();
    await expect(group.locator('input[name="authUpstream"]')).toBeVisible();
  });
});

// ─── OAuth providers ─────────────────────────────────────────────────────────

test.describe('OAuth providers', () => {
  test('page renders with an Add provider button', async ({ page }) => {
    await open(page, '/oauth-providers');
    await expect(page.getByRole('heading', { level: 1, name: 'OAuth providers' })).toBeVisible();
    await expect(main(page).getByRole('button', { name: /add provider/i }).first()).toBeVisible();
  });

  test('clicking Add provider opens the dialog', async ({ page }) => {
    await open(page, '/oauth-providers');
    await main(page).getByRole('button', { name: /add provider/i }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(/name/i)).toBeVisible();
    await expect(dialog.getByLabel(/client id/i)).toBeVisible();
    await expect(dialog.getByLabel(/client secret/i)).toBeVisible();
  });

  test('create and delete an OAuth provider', async ({ page }) => {
    await open(page, '/oauth-providers');
    await main(page).getByRole('button', { name: /add provider/i }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^name/i).fill('E2E Test Provider');
    await dialog.getByLabel(/client id/i).fill('test-client-id-12345');
    await dialog.getByLabel(/client secret/i).fill('test-client-secret-12345');
    // Skip issuer URL — it's optional and avoids potential OIDC discovery issues
    await dialog.getByRole('button', { name: /create provider/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: 30_000 });

    const providerRow = page.getByTestId('oauth-provider').filter({ hasText: 'E2E Test Provider' });
    await expect(providerRow).toBeVisible({ timeout: 10_000 });
    await providerRow.getByRole('button', { name: 'Delete E2E Test Provider' }).click();
    await providerRow.getByRole('button', { name: /^confirm$/i }).click();
    await expect(page.getByText('E2E Test Provider')).not.toBeVisible({ timeout: 10_000 });
  });

  test('existing OAuth secrets never cross the API or React browser boundary', async ({ page }) => {
    await open(page, '/oauth-providers');
    const origin = new URL(page.url()).origin;
    const secret = `oauth-browser-secret-${Date.now()}`;
    const providerName = `Write-only OAuth ${Date.now()}`;
    const createResponse = await page.request.post(`${origin}/api/v1/oauth-providers`, {
      headers: { Origin: origin },
      data: {
        name: providerName,
        type: 'oidc',
        clientId: 'browser-boundary-client-id',
        clientSecret: secret,
        scopes: 'openid email profile',
      },
    });
    const createBody = await createResponse.text();
    const created = JSON.parse(createBody) as { id: string; hasClientSecret: boolean };

    expect(createResponse.ok()).toBeTruthy();
    expect(created.hasClientSecret).toBe(true);
    expect(createBody).not.toContain(secret);
    expect(createBody).not.toContain('clientSecret');

    try {
      const navigation = await page.goto('/oauth-providers');
      const initialRscHtml = await navigation!.text();
      expect(initialRscHtml).not.toContain(secret);
      expect(initialRscHtml).not.toContain('clientSecret');
      expect(await page.content()).not.toContain(secret);

      const itemResponse = await page.request.get(`${origin}/api/v1/oauth-providers/${created.id}`);
      const itemBody = await itemResponse.text();
      expect(itemResponse.ok()).toBeTruthy();
      expect(itemBody).not.toContain(secret);
      expect(itemBody).not.toContain('clientSecret');

      const providerRow = page.getByTestId('oauth-provider').filter({ hasText: providerName });
      await providerRow.getByTitle('Edit provider').click();

      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText(/existing value cannot be viewed/i)).toBeVisible();
      await expect(dialog.getByLabel(/client secret/i)).toHaveCount(0);
      await dialog.getByRole('button', { name: /rotate secret/i }).click();
      await expect(dialog.getByLabel(/new client secret/i)).toHaveValue('');
      await dialog.getByRole('button', { name: /keep existing/i }).click();

      await dialog.getByLabel(/^name/i).fill(`${providerName} renamed`);
      await dialog.getByRole('button', { name: /update provider/i }).click();
      await expect(dialog).not.toBeVisible({ timeout: 10_000 });

      const preservedResponse = await page.request.get(`${origin}/api/v1/oauth-providers/${created.id}`);
      const preserved = await preservedResponse.json() as { hasClientSecret: boolean };
      expect(preserved.hasClientSecret).toBe(true);
    } finally {
      await page.request.delete(`${origin}/api/v1/oauth-providers/${created.id}`, {
        headers: { Origin: origin },
      }).catch(() => undefined);
    }
  });
});

// ─── Geo blocking ────────────────────────────────────────────────────────────

test.describe('Geo blocking', () => {
  test('shows the default rules and the GeoIP databases', async ({ page }) => {
    await open(page, '/geo-blocking');
    await expect(main(page).getByRole('heading', { name: 'Default rules' })).toBeVisible();
    await expect(main(page).getByRole('heading', { name: 'GeoIP databases' })).toBeVisible();
    await expect(main(page).getByText('/usr/share/GeoIP/GeoLite2-Country.mmdb')).toBeVisible();
    await expect(saveBar(page).getByRole('button', { name: 'Save changes' })).toBeVisible();
  });
});

// ─── Analytics settings ──────────────────────────────────────────────────────

test.describe('Analytics settings', () => {
  test('shows ClickHouse retention read-only', async ({ page }) => {
    await open(page, '/analytics/settings');
    await expect(main(page).getByRole('heading', { name: 'Traffic analytics' })).toBeVisible();
    await expect(main(page).getByText('Keep events for')).toBeVisible();
    await expect(main(page).getByText(/CLICKHOUSE_RETENTION_DAYS/)).toBeVisible();
  });

  test('access log: switch and format', async ({ page }) => {
    await open(page, '/analytics/settings');
    const card = main(page).locator('#logging');
    await expect(card.getByRole('switch', { name: 'Log every proxied request' })).toBeVisible();
    const format = card.getByRole('group', { name: 'Log format' });
    await expect(format.getByRole('button', { name: 'JSON' })).toBeVisible();
    await expect(format.getByRole('button', { name: /console/i })).toBeVisible();
  });

  test('metrics: switch, port 9090 and the scrape address', async ({ page }) => {
    await open(page, '/analytics/settings');
    const card = main(page).locator('#metrics');
    await expect(card.getByRole('switch', { name: 'Expose /metrics on its own port' })).toBeVisible();
    await expect(card.locator('input[name="port"]')).toHaveValue('9090');
    await expect(card.getByText(/ingressi-caddy/).first()).toBeVisible();
  });
});

// ─── Mobile layout ───────────────────────────────────────────────────────────

test.describe('Settings pages — mobile layout', () => {
  test.use({ viewport: { width: 393, height: 852 } });

  test('command palette works on mobile', async ({ page }) => {
    await open(page, '/settings');
    await page.keyboard.press('ControlOrMeta+k');
    const { dialog, input } = commandPalette(page);
    await input.fill('prometheus');
    await dialog.getByRole('option', { name: /^Prometheus metrics/ }).click();
    await expect(page).toHaveURL(/\/analytics\/settings#metrics$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Analytics settings' })).toBeVisible();
  });

  test('content does not overflow the viewport width', async ({ page }) => {
    for (const { path } of SETTINGS_PAGES) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
      const viewportWidth = page.viewportSize()?.width ?? 393;
      expect(bodyWidth, path).toBeLessThanOrEqual(viewportWidth + 5);
    }
  });
});

// ─── Form submissions via API ────────────────────────────────────────────────

test.describe('Settings pages — form data round-trip via API', () => {
  const API_SETTINGS_GENERAL = 'http://localhost:3000/api/v1/settings/general';
  const API_SETTINGS_METRICS = 'http://localhost:3000/api/v1/settings/metrics';
  const API_SETTINGS_LOGGING = 'http://localhost:3000/api/v1/settings/logging';

  test('general settings: UI save is reflected in API', async ({ page }) => {
    await open(page, '/settings');
    await main(page).getByLabel('Primary domain').fill('api-roundtrip.local');
    await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
    await expect(saveBar(page).getByText('General settings saved successfully')).toBeVisible({ timeout: 10_000 });

    const res = await page.request.get(API_SETTINGS_GENERAL);
    expect((await res.json()).primaryDomain).toBe('api-roundtrip.local');

    await page.request.put(API_SETTINGS_GENERAL, { data: { primaryDomain: 'example.com', acmeEmail: '' } });
  });

  test('metrics and access log saved together in one save', async ({ page }) => {
    await open(page, '/analytics/settings');
    const metricsSwitch = main(page).getByRole('switch', { name: 'Expose /metrics on its own port' });
    if (!(await metricsSwitch.isChecked())) await metricsSwitch.click();
    await main(page).locator('input[name="port"]').fill('9191');
    const logSwitch = main(page).getByRole('switch', { name: 'Log every proxied request' });
    if (!(await logSwitch.isChecked())) await logSwitch.click();
    await main(page).getByRole('group', { name: 'Log format' }).getByRole('button', { name: /console/i }).click();

    await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
    await expect(saveBar(page).getByText('Metrics settings saved and applied successfully')).toBeVisible({ timeout: 10_000 });
    await expect(saveBar(page).getByText('Logging settings saved and applied successfully')).toBeVisible();

    const metrics = await (await page.request.get(API_SETTINGS_METRICS)).json();
    expect(metrics.enabled).toBe(true);
    expect(metrics.port).toBe(9191);
    const logging = await (await page.request.get(API_SETTINGS_LOGGING)).json();
    expect(logging.format).toBe('console');

    await page.request.put(API_SETTINGS_METRICS, { data: { enabled: false, port: 9090 } });
    await page.request.put(API_SETTINGS_LOGGING, { data: { enabled: false, format: 'json' } });
  });
});
