/**
 * Functional tests: path prefix rewrite.
 *
 * Creates a proxy host with a path prefix rewrite (/api) pointing at the
 * whoami-server, which reflects the full request line in its response body.
 * This lets us assert that Caddy rewrote the path before forwarding, e.g.
 * a client request for /users arrives at the upstream as /api/users.
 *
 * Domain: func-rewrite.test
 */
import { test, expect } from '@playwright/test';
import { httpGet, waitForRoute, setForceSsl } from '../../helpers/http';

const DOMAIN = 'func-rewrite.test';

test.describe.serial('Path Prefix Rewrite', () => {
  test('setup: create proxy host with path prefix rewrite', async ({ page }) => {
    await page.goto('/proxy-hosts');
    await page.getByRole('button', { name: /create host/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByLabel('Name').fill('Functional Path Prefix Rewrite Test');
    await page.getByLabel(/domains/i).fill(DOMAIN);
    // whoami-server listens on port 80 by default
    await page.getByPlaceholder('10.0.0.5:8080').first().fill('whoami-server:80');

    // Fill in the path prefix rewrite field
    await page.getByLabel('Path Prefix Rewrite').fill('/api');

    // Force SSL defaults to ON; these tests exercise plain-HTTP routing.
    await setForceSsl(page, false);
    await page.getByRole('button', { name: /^create$/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('table').getByText('Functional Path Prefix Rewrite Test')).toBeVisible({ timeout: 10_000 });

    await waitForRoute(DOMAIN);
  });

  test('request path is prepended with the prefix before reaching the upstream', async () => {
    const res = await httpGet(DOMAIN, '/users');
    expect(res.status).toBe(200);
    // traefik/whoami echoes the request line, e.g. "GET /api/users HTTP/1.1"
    expect(res.body).toContain('/api/users');
  });

  test('root path is prepended with the prefix', async () => {
    const res = await httpGet(DOMAIN, '/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('/api/');
  });

  test('nested path is prepended with the prefix', async () => {
    const res = await httpGet(DOMAIN, '/items/42/details');
    expect(res.status).toBe(200);
    expect(res.body).toContain('/api/items/42/details');
  });

  test('original path without prefix is NOT sent to the upstream', async () => {
    const res = await httpGet(DOMAIN, '/users');
    expect(res.status).toBe(200);
    // The upstream must NOT see the bare /users path — it should see /api/users
    expect(res.body).not.toMatch(/^GET \/users /m);
  });
});
