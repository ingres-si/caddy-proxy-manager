/**
 * Functional tests: L4 (TCP) load balancing (regression #301).
 *
 * Enabling load balancing on an L4 proxy host used to make Caddy reject the
 * whole configuration ("json: unknown field \"retries\"" / "selection_policy"),
 * because the HTTP reverse_proxy load-balancing schema was sent to caddy-l4.
 *
 * Reproduces the steps from the issue through the UI — two upstreams,
 * "First Available", try duration/interval and an active health check — then
 * sends real TCP traffic through Caddy. The first upstream is dead, so every
 * connection only succeeds if caddy-l4 actually applied the load-balancing
 * and health-check config (the dead upstream is marked down by the active
 * check and connections fail over to the live one).
 *
 * Test port exposed on the Caddy container: TCP 15434
 * Upstreams: tcp-echo:9999 (nothing listening) and tcp-echo:9000 (echo)
 */
import { test, expect } from '@playwright/test';
import { tcpSend, waitForTcpRoute } from '../../helpers/tcp';

const TCP_PORT = 15434;
const HOST_NAME = 'L4 LB First Available Test';
const BASE_URL = 'http://localhost:3000';
// Session-cookie API calls need an Origin header to pass the CSRF check.
const SESSION_HEADERS = { Origin: BASE_URL };

test.describe.serial('L4 TCP Load Balancing', () => {
  test('setup: create L4 host with load balancing and active health check', async ({ page }) => {
    await page.goto('/l4-proxy-hosts/new');
    await expect(page.locator('nav[data-host-tabs][data-hydrated="true"]')).toBeVisible();

    await page.getByLabel('Name', { exact: true }).fill(HOST_NAME);
    await page.getByLabel('Listen address').fill(`:${TCP_PORT}`);
    await page.getByLabel('Upstream 1', { exact: true }).fill('tcp-echo:9999');
    await page.getByRole('button', { name: 'Add upstream' }).click();
    await page.getByLabel('Upstream 2', { exact: true }).fill('tcp-echo:9000');

    await page.getByRole('tab', { name: 'Load balancing' }).click();
    await page.getByRole('switch', { name: 'Load balancing and health checks' }).click();
    await page.getByLabel('Policy').selectOption('first');
    await page.getByLabel('Keep trying for').fill('5s');
    await page.getByLabel('Wait between tries').fill('250ms');
    await page.getByRole('switch', { name: 'Active health checks' }).click();

    // Fields caddy-l4 does not support must not be offered.
    await expect(page.getByLabel('Max retries')).toHaveCount(0);
    await expect(page.getByLabel('Unhealthy latency')).toHaveCount(0);

    await page.getByTestId('host-editor-bar').getByRole('button', { name: 'Create host' }).click();

    // Before the fix Caddy rejected the config and the host was not created
    // ("Caddy rejected configuration").
    await expect(page).toHaveURL(/\/l4-proxy-hosts\/\d+$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { level: 1, name: HOST_NAME })).toBeVisible({ timeout: 10_000 });

    await waitForTcpRoute('127.0.0.1', TCP_PORT);
  });

  test('stores the load balancer settings', async ({ page }) => {
    const res = await page.request.get('/api/v1/l4-proxy-hosts');
    expect(res.ok()).toBe(true);
    const hosts = (await res.json()) as Array<{ name: string; loadBalancer: Record<string, unknown> | null }>;
    const host = hosts.find((h) => h.name === HOST_NAME);
    expect(host?.loadBalancer).toMatchObject({
      enabled: true,
      policy: 'first',
      tryDuration: '5s',
      tryInterval: '250ms',
      activeHealthCheck: { enabled: true },
    });
  });

  test('fails over from the dead first upstream on every connection', async () => {
    for (let i = 0; i < 5; i++) {
      // tcpSend returns after the socket has been idle for timeoutMs (the echo
      // server keeps the connection open), so keep it short to fit 5 probes.
      const res = await tcpSend('127.0.0.1', TCP_PORT, `lb-probe-${i}\n`, 4_000);
      expect(res.connected).toBe(true);
      expect(res.data).toContain(`lb-probe-${i}`);
    }
  });

  test('cleanup: delete the load-balanced L4 host', async ({ page }) => {
    const res = await page.request.get('/api/v1/l4-proxy-hosts');
    const hosts = (await res.json()) as Array<{ id: number; name: string }>;
    const host = hosts.find((h) => h.name === HOST_NAME);
    expect(host).toBeDefined();
    const del = await page.request.delete(`/api/v1/l4-proxy-hosts/${host!.id}`, { headers: SESSION_HEADERS });
    expect(del.ok()).toBe(true);
  });
});
