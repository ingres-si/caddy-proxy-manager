/**
 * Higher-level helpers for creating L4 proxy hosts in E2E tests.
 *
 * All helpers accept a Playwright `Page` (pre-authenticated via the
 * global storageState) so they integrate cleanly with the standard
 * `page` test fixture.
 */
import { expect, type Page } from '@playwright/test';

export interface L4ProxyHostConfig {
  name: string;
  protocol?: 'tcp' | 'udp';
  listenAddress: string;
  upstream: string;          // e.g. "tcp-echo:9000"
  matcherType?: 'none' | 'tls_sni' | 'http_host' | 'proxy_protocol';
  matcherValue?: string;     // comma-separated
  tlsTermination?: boolean;
  proxyProtocolReceive?: boolean;
  proxyProtocolVersion?: 'v1' | 'v2';
}

/**
 * Create an L4 proxy host via the browser UI: the L4 host editor at
 * /l4-proxy-hosts/new, which opens the host's page once it is created.
 */
export async function createL4ProxyHost(page: Page, config: L4ProxyHostConfig): Promise<void> {
  await page.goto('/l4-proxy-hosts/new');
  // The fields are reset by hydration: wait until React owns them.
  await expect(page.locator('nav[data-host-tabs][data-hydrated="true"]')).toBeVisible();

  await page.getByLabel('Name', { exact: true }).fill(config.name);
  if (config.protocol && config.protocol !== 'tcp') {
    await page.getByRole('group', { name: 'Protocol' }).getByRole('button', { name: config.protocol.toUpperCase() }).click();
  }
  await page.getByLabel('Listen address').fill(config.listenAddress);
  await page.getByLabel('Upstream 1', { exact: true }).fill(config.upstream);

  if (config.matcherType && config.matcherType !== 'none') {
    await page.getByLabel('Matcher').selectOption(config.matcherType);
    if (config.matcherValue && (config.matcherType === 'tls_sni' || config.matcherType === 'http_host')) {
      const input = page.getByLabel(/^Add an? (SNI|HTTP) hostname$/);
      for (const name of config.matcherValue.split(',').map((value) => value.trim()).filter(Boolean)) {
        await input.fill(name);
        await input.press('Enter');
      }
    }
  }
  if (config.tlsTermination) await page.getByRole('switch', { name: 'TLS termination' }).click();
  if (config.proxyProtocolReceive) await page.getByRole('switch', { name: 'Accept inbound PROXY protocol' }).click();
  if (config.proxyProtocolVersion) await page.getByLabel('Send PROXY protocol to the upstream').selectOption(config.proxyProtocolVersion);

  await page.getByTestId('host-editor-bar').getByRole('button', { name: 'Create host' }).click();
  // The new host's page opens.
  await expect(page).toHaveURL(/\/l4-proxy-hosts\/\d+$/, { timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 1, name: config.name })).toBeVisible({ timeout: 10_000 });
}
