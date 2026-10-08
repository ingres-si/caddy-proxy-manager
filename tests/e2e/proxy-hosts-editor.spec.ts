/**
 * The host editor (/proxy-hosts/new, and the tabs of /proxy-hosts/<id>): creating a
 * host, sections linkable by #anchor, unsaved-change tracking with the
 * review (diff, approval policy, impact) and undo, inline checks, copies,
 * the old ?create=1 deep link, and the regressions the old host dialog had
 * (#119, #141, #232, the geo blocking override mode).
 */
import { test, expect, type Page } from '@playwright/test';
import {
  addDomains,
  fillHostBasics,
  openEditorSection,
  openHostEditor,
  openNewHost,
  saveHostEditor,
  setEditorSwitch,
} from '../helpers/proxy-api';

const BASE = 'http://localhost:3000';
const API_PROXY_HOSTS = `${BASE}/api/v1/proxy-hosts`;
const API_AUTHENTIK_SETTINGS = `${BASE}/api/v1/settings/authentik`;
const HEADERS = { 'Content-Type': 'application/json', Origin: BASE };

type ApiHost = Record<string, unknown> & { id: number; name: string };

async function createHost(page: Page, data: Record<string, unknown>): Promise<ApiHost> {
  const response = await page.request.post(API_PROXY_HOSTS, { headers: HEADERS, data });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as ApiHost;
}

async function getHost(page: Page, id: number): Promise<ApiHost> {
  return (await (await page.request.get(`${API_PROXY_HOSTS}/${id}`)).json()) as ApiHost;
}

async function deleteHost(page: Page, id: number): Promise<void> {
  await page.request.delete(`${API_PROXY_HOSTS}/${id}`, { headers: { Origin: BASE } }).catch(() => undefined);
}

test.describe('Proxy host editor', () => {
  test('creates a host and opens its page', async ({ page }) => {
    await openNewHost(page);
    await fillHostBasics(page, { name: 'E2E Test Host', domain: 'e2etest.local', upstream: 'localhost:9999' });
    await expect(page.getByTestId('host-editor-bar')).toContainText('New host');
    const id = await saveHostEditor(page);
    expect(id).toBeGreaterThan(0);
    try {
      const host = await getHost(page, id!);
      expect(host).toMatchObject({
        name: 'E2E Test Host',
        domains: ['e2etest.local'],
        upstreams: ['http://localhost:9999'],
        enabled: true,
        sslForced: true,
        hstsSubdomains: true,
        skipHttpsHostnameValidation: false,
      });
    } finally {
      await deleteHost(page, id!);
    }
  });

  test('the old ?create=1 link opens a new host with its domain', async ({ page }) => {
    await page.goto('/proxy-hosts?create=1&domain=deep-link.example.test');
    await expect(page).toHaveURL(/\/proxy-hosts\/new\?domain=deep-link\.example\.test$/);
    await expect(page.getByRole('list', { name: 'Domains', exact: true }).getByText('deep-link.example.test')).toBeVisible();
  });

  test('shows problems next to their fields before saving', async ({ page }) => {
    await openNewHost(page);
    await page.getByTestId('host-editor-bar').getByRole('button', { name: 'Create host', exact: true }).click();
    await expect(page.getByText('Enter a name for the host.')).toBeVisible();
    await expect(page.getByText('Add at least one domain.')).toBeVisible();
    await expect(page.getByText('Add at least one upstream.')).toBeVisible();
    await expect(page.getByLabel('Name', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('region', { name: /^Review / })).toHaveCount(0);

    await addDomains(page, 'bad_domain!');
    await expect(page.getByText(/bad_domain! is not a valid domain/)).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Routing/ })).toContainText(/problem/);
  });

  test('sections are linkable and switch the form', async ({ page }) => {
    const host = await createHost(page, { name: 'Anchor Host', domains: ['anchor.local'], upstreams: ['localhost:9981'] });
    try {
      await openHostEditor(page, host.id, 'Security');
      await expect(page.getByRole('heading', { name: 'Web application firewall' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Rate limiting' })).toBeVisible();
      // Geo blocking is part of Security, as on the host's overview.
      await expect(page.getByRole('heading', { name: 'Geo blocking' })).toBeVisible();

      // Tabs switch in place: the page and its header stay.
      await page.getByRole('tab', { name: /^Certificate/ }).click();
      await expect(page).toHaveURL(new RegExp(`/proxy-hosts/${host.id}#certificate$`));
      await expect(page.getByRole('combobox', { name: 'Certificate', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: 'anchor.local' })).toBeVisible();

      // The old editor address leads to the host's page at the section asked for.
      await page.goto(`/proxy-hosts/${host.id}/edit?section=access`);
      await expect(page).toHaveURL(new RegExp(`/proxy-hosts/${host.id}#access$`));
      await expect(page.getByRole('tab', { name: /^Access/ })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('combobox', { name: 'Access list', exact: true })).toBeVisible();
    } finally {
      await deleteHost(page, host.id);
    }
  });

  test('counts unsaved changes, reviews them with undo, and discards', async ({ page }) => {
    const host = await createHost(page, { name: 'Review Host', domains: ['review.local'], upstreams: ['localhost:9982'] });
    try {
      await openHostEditor(page, host.id);
      const bar = page.getByTestId('host-editor-bar');
      // Nothing changed: no bar on the host's page.
      await expect(bar).toHaveCount(0);

      await setEditorSwitch(page, 'WebSockets', false);
      await openEditorSection(page, 'Headers');
      await setEditorSwitch(page, 'Send the HSTS header', false);
      await expect(bar).toContainText('2 unsaved changes');
      await expect(page.getByRole('tab', { name: /^Headers/ })).toContainText('1 unsaved change');

      await bar.getByRole('button', { name: 'Review changes' }).click();
      // Its name follows the count: "Review 2 changes to …", then "Review 1 change to …" after an undo.
      const review = page.getByRole('region', { name: /^Review \d+ changes? to Review Host$/ });
      await expect(review).toBeVisible();
      await expect(review.getByRole('listitem').filter({ hasText: 'WebSockets' })).toBeVisible();
      // The preview has answered: the impact is listed and, with no approval needed, the change saves at once.
      await expect(review.getByText(/Reloads its configuration on this node/)).toBeVisible({ timeout: 15_000 });
      await expect(review.getByRole('button', { name: 'Save changes' })).toBeEnabled();

      await review.getByRole('button', { name: 'Undo change to HSTS header' }).click();
      await expect(bar).toContainText('1 unsaved change');
      await review.getByRole('button', { name: 'Save changes' }).click();
      await expect(bar.getByText('Saved', { exact: true })).toBeVisible({ timeout: 15_000 });

      const saved = await getHost(page, host.id);
      expect(saved).toMatchObject({ allowWebsocket: false, hstsEnabled: true });

      // Still on Headers after saving; the switch is in Routing.
      await openEditorSection(page, 'Routing');
      await setEditorSwitch(page, 'Preserve Host header', false);
      await expect(bar).toContainText('1 unsaved change');
      await bar.getByRole('button', { name: 'Discard' }).click();
      await expect(bar).toHaveCount(0);
      await expect(page.getByRole('switch', { name: 'Preserve Host header' })).toHaveAttribute('aria-checked', 'true');
    } finally {
      await deleteHost(page, host.id);
    }
  });

  test('previews a change through the REST API without saving it', async ({ page }) => {
    const host = await createHost(page, { name: 'Preview Host', domains: ['preview.local'], upstreams: ['localhost:9983'] });
    try {
      const response = await page.request.post(`${API_PROXY_HOSTS}/${host.id}/preview`, { headers: HEADERS, data: { name: 'Preview Host 2' } });
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({
        approval: { required: false },
        changes: [{ path: 'host.name', before: 'Preview Host', after: 'Preview Host 2' }],
      });
      expect((await getHost(page, host.id)).name).toBe('Preview Host');
    } finally {
      await deleteHost(page, host.id);
    }
  });

  /**
   * Regression test for #119: HSTS Subdomains and Skip HTTPS Validation were
   * not saved by the old host form.
   */
  test('advanced options are saved and persist after edit (#119)', async ({ page }) => {
    await openNewHost(page);
    await fillHostBasics(page, { name: 'Advanced Options Test', domain: 'advanced-opts-test.local', upstream: 'localhost:9990' });
    const id = (await saveHostEditor(page))!;
    try {
      expect(await getHost(page, id)).toMatchObject({ hstsSubdomains: true, skipHttpsHostnameValidation: false });

      await openHostEditor(page, id);
      await setEditorSwitch(page, 'Skip upstream certificate check', true);
      await openEditorSection(page, 'Headers');
      await setEditorSwitch(page, 'Include subdomains', false);
      await saveHostEditor(page);
      expect(await getHost(page, id)).toMatchObject({ hstsSubdomains: false, skipHttpsHostnameValidation: true });

      await openHostEditor(page, id, 'Headers');
      await expect(page.getByRole('switch', { name: 'Include subdomains' })).toHaveAttribute('aria-checked', 'false');
      await openEditorSection(page, 'Routing');
      await expect(page.getByRole('switch', { name: 'Skip upstream certificate check' })).toHaveAttribute('aria-checked', 'true');
    } finally {
      await deleteHost(page, id);
    }
  });

  test('a copy starts from the original host', async ({ page }) => {
    const host = await createHost(page, {
      name: 'Copy Source',
      domains: ['copy-source.local'],
      upstreams: ['http://localhost:9984'],
      redirects: [{ from: '/old', to: '/new', status: 301 }],
    });
    try {
      await openNewHost(page, `?from=${host.id}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Copy of Copy Source');
      await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Copy Source (copy)');
      await expect(page.getByText('Change the domains before creating it')).toBeVisible();
      await expect(page.getByPlaceholder('10.0.0.5:8080').first()).toHaveValue('localhost:9984');
    } finally {
      await deleteHost(page, host.id);
    }
  });

  test('Authentik fields of a new host are prefilled from global defaults (#141)', async ({ page }) => {
    const defaults = { outpostDomain: 'auth.example.test', outpostUpstream: 'http://authentik.internal:9000', authEndpoint: '/outpost.goauthentik.io/auth/caddy' };
    const original = (await (await page.request.get(API_AUTHENTIK_SETTINGS)).json()) as Partial<typeof defaults>;
    try {
      expect((await page.request.put(API_AUTHENTIK_SETTINGS, { headers: HEADERS, data: defaults })).ok()).toBeTruthy();
      await openNewHost(page);
      await openEditorSection(page, 'Access');
      await page.getByRole('group', { name: 'Provider' }).getByRole('button', { name: 'Authentik' }).click();
      await expect(page.locator('input[name="authentikOutpostDomain"]')).toHaveValue(defaults.outpostDomain);
      await expect(page.locator('input[name="authentikOutpostUpstream"]')).toHaveValue(defaults.outpostUpstream);
      await expect(page.locator('input[name="authentikAuthEndpoint"]')).toHaveValue(defaults.authEndpoint);
    } finally {
      if (original.outpostDomain && original.outpostUpstream) {
        await page.request.put(API_AUTHENTIK_SETTINGS, { headers: HEADERS, data: { ...original, authEndpoint: original.authEndpoint ?? '' } });
      }
    }
  });

  /**
   * #232: defaults must reach the editor of an existing host too, and only
   * fill blanks: a host's own Authentik values are kept.
   */
  test('Authentik fields of an existing host use its own values, else the defaults (#232)', async ({ page }) => {
    const defaults = { outpostDomain: 'edit-defaults.example.test', outpostUpstream: 'http://authentik-edit.internal:9000', authEndpoint: '/outpost.goauthentik.io/auth/caddy' };
    const original = (await (await page.request.get(API_AUTHENTIK_SETTINGS)).json()) as Partial<typeof defaults>;
    const plain = await createHost(page, { name: 'Authentik Edit Defaults Host', domains: ['authentik-edit-defaults.local'], upstreams: ['localhost:9987'] });
    const own = await createHost(page, {
      name: 'Authentik Own Values Host',
      domains: ['authentik-own-values.local'],
      upstreams: ['localhost:9986'],
      authentik: { enabled: true, outpostDomain: 'host-specific.example.test', outpostUpstream: 'http://host-specific.internal:9000' },
    });
    try {
      expect((await page.request.put(API_AUTHENTIK_SETTINGS, { headers: HEADERS, data: defaults })).ok()).toBeTruthy();

      await openHostEditor(page, plain.id, 'Access');
      await page.getByRole('group', { name: 'Provider' }).getByRole('button', { name: 'Authentik' }).click();
      await expect(page.locator('input[name="authentikOutpostDomain"]')).toHaveValue(defaults.outpostDomain);
      await expect(page.locator('input[name="authentikOutpostUpstream"]')).toHaveValue(defaults.outpostUpstream);
      await expect(page.locator('input[name="authentikAuthEndpoint"]')).toHaveValue(defaults.authEndpoint);

      await openHostEditor(page, own.id, 'Access');
      await expect(page.getByRole('group', { name: 'Provider' }).getByRole('button', { name: 'Authentik' })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('input[name="authentikOutpostDomain"]')).toHaveValue('host-specific.example.test');
      await expect(page.locator('input[name="authentikOutpostUpstream"]')).toHaveValue('http://host-specific.internal:9000');
    } finally {
      await deleteHost(page, plain.id);
      await deleteHost(page, own.id);
      if (original.outpostDomain && original.outpostUpstream) {
        await page.request.put(API_AUTHENTIK_SETTINGS, { headers: HEADERS, data: { ...original, authEndpoint: original.authEndpoint ?? '' } });
      }
    }
  });

  /**
   * Regression: the per-host geo blocking "Override global" mode was dropped
   * by the old form action.
   */
  test('per-host geo blocking override mode persists after save', async ({ page }) => {
    await openNewHost(page);
    await fillHostBasics(page, { name: 'Geoblock Override Host', domain: 'geoblock-override.local', upstream: 'localhost:9991' });
    await openEditorSection(page, 'Access');
    await setEditorSwitch(page, 'Geo blocking for this host', true);
    const rules = page.getByRole('group', { name: 'Rules', exact: true });
    await rules.getByRole('button', { name: 'Override global' }).click();
    const id = (await saveHostEditor(page))!;
    try {
      expect((await getHost(page, id)).geoblockMode).toBe('override');

      await openHostEditor(page, id, 'Access');
      await expect(page.getByRole('group', { name: 'Rules', exact: true }).getByRole('button', { name: 'Override global' })).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('group', { name: 'Rules', exact: true }).getByRole('button', { name: 'Merge with global' }).click();
      await saveHostEditor(page);
      expect((await getHost(page, id)).geoblockMode).toBe('merge');
    } finally {
      await deleteHost(page, id);
    }
  });

  test('asks before leaving with unsaved changes', async ({ page }) => {
    const host = await createHost(page, { name: 'Leave Host', domains: ['leave.local'], upstreams: ['localhost:9985'] });
    try {
      await openHostEditor(page, host.id);
      await setEditorSwitch(page, 'WebSockets', false);
      page.once('dialog', (dialog) => dialog.dismiss());
      await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Audit log' }).click();
      await expect(page).toHaveURL(new RegExp(`/proxy-hosts/${host.id}#routing$`));
      // Switching tabs keeps the change.
      await page.getByRole('tab', { name: /^Overview/ }).click();
      await expect(page.getByTestId('host-editor-bar')).toContainText('1 unsaved change');
    } finally {
      await deleteHost(page, host.id);
    }
  });
});
