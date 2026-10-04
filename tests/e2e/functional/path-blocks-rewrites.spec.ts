/**
 * Functional tests: structured Path Blocks and Path Rewrites.
 *
 * Creates a proxy host with:
 *   - a Path Block for /dns-query → 403 "Forbidden"
 *   - a Path Rewrite for /secretpath → /dns-query
 *   - default routing to whoami-server (which echoes the request line)
 *
 * Verifies that:
 *   - Blocked paths return the configured status + body (no proxying).
 *   - Rewrites change the URI seen by the upstream.
 *   - A rewrite to a path that is ALSO blocked does NOT re-match the block
 *     (subroute routes are evaluated sequentially), so the upstream still
 *     sees the rewritten path.
 *   - Unmatched paths are proxied normally.
 *
 * The pathBlocksJson / pathRewritesJson hidden fields are injected directly
 * (same pattern as redirects.spec.ts) so the test doesn't have to drive the
 * dynamic dialog rows.
 *
 * Domain: func-path-rules.test
 */
import { test, expect } from '@playwright/test';
import { httpGet, injectFormFields, waitForRoute, setForceSsl } from '../../helpers/http';

const DOMAIN = 'func-path-rules.test';

test.describe.serial('Path Blocks and Path Rewrites', () => {
  test('setup: create proxy host with path blocks and rewrites', async ({ page }) => {
    await page.goto('/proxy-hosts');
    await page.getByRole('button', { name: /create host/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByLabel('Name').fill('Functional Path Blocks/Rewrites Test');
    await page.getByLabel(/domains/i).fill(DOMAIN);
    // whoami-server echoes the full request line, letting us assert the
    // rewritten URI is what the upstream received.
    await page.getByPlaceholder('10.0.0.5:8080').first().fill('whoami-server:80');

    // Force SSL defaults to ON; these tests exercise plain-HTTP routing.
    await setForceSsl(page, false);
    await injectFormFields(page, {
      pathBlocksJson: JSON.stringify([
        { path: '/dns-query', status: 403, body: 'Forbidden' },
        { path: '/admin/*',   status: 404 },
      ]),
      pathRewritesJson: JSON.stringify([
        { from: '/secretpath', to: '/dns-query' },
        { from: '/oldapi',     to: '/v2/api' },
      ]),
    });

    await page.getByRole('button', { name: /^create$/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('table').getByText('Functional Path Blocks/Rewrites Test')).toBeVisible({ timeout: 10_000 });

    await waitForRoute(DOMAIN);
  });

  test('blocked exact path returns the configured status and body', async () => {
    const res = await httpGet(DOMAIN, '/dns-query');
    expect(res.status).toBe(403);
    expect(res.body).toBe('Forbidden');
  });

  test('blocked path is terminal — request never reaches the upstream', async () => {
    const res = await httpGet(DOMAIN, '/dns-query');
    // whoami-server echoes "GET /dns-query HTTP/..." when proxied. The block
    // returns a static_response, so that echo must NOT appear in the body.
    expect(res.body).not.toMatch(/GET \/dns-query HTTP/);
  });

  test('wildcard block matches subpaths with the configured status', async () => {
    const res = await httpGet(DOMAIN, '/admin/users');
    expect(res.status).toBe(404);
  });

  test('rewrite changes the URI seen by the upstream', async () => {
    // The upstream is whoami-server, which echoes the request line. After the
    // rewrite, the upstream should see /dns-query — not /secretpath. Crucially,
    // even though /dns-query is in the block list, subroute routes are
    // evaluated sequentially: the block route matched on the ORIGINAL URI
    // (/secretpath, which is not blocked), then the rewrite route ran. The
    // block route does NOT re-evaluate after the rewrite.
    const res = await httpGet(DOMAIN, '/secretpath');
    expect(res.status).toBe(200);
    expect(res.body).toContain('/dns-query');
    expect(res.body).not.toMatch(/GET \/secretpath HTTP/);
  });

  test('second rewrite rule also takes effect', async () => {
    const res = await httpGet(DOMAIN, '/oldapi');
    expect(res.status).toBe(200);
    expect(res.body).toContain('/v2/api');
  });

  test('unmatched path is proxied normally to the upstream', async () => {
    const res = await httpGet(DOMAIN, '/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toContain('/healthz');
  });
});

// A second host that uses Path Allows to carve exceptions out of a catch-all block.
// This validates the "allow first, block second" emission order in the subroute,
// which is the entire point of the pathAllows feature.
const ALLOW_DOMAIN = 'func-path-allows.test';

test.describe.serial('Path Allows override Path Blocks', () => {
  test('setup: create host that blocks /* but allows /secret and /public/*', async ({ page }) => {
    await page.goto('/proxy-hosts');
    await page.getByRole('button', { name: /create host/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByLabel('Name').fill('Functional Path Allows Test');
    await page.getByLabel(/domains/i).fill(ALLOW_DOMAIN);
    await page.getByPlaceholder('10.0.0.5:8080').first().fill('whoami-server:80');

    // Force SSL defaults to ON; these tests exercise plain-HTTP routing.
    await setForceSsl(page, false);
    await injectFormFields(page, {
      pathAllowsJson: JSON.stringify([
        { path: '/secret' },
        { path: '/public/*' },
      ]),
      pathBlocksJson: JSON.stringify([
        { path: '/*', status: 403, body: 'Blocked' },
      ]),
    });

    await page.getByRole('button', { name: /^create$/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('table').getByText('Functional Path Allows Test')).toBeVisible({ timeout: 10_000 });

    await waitForRoute(ALLOW_DOMAIN);
  });

  test('allowed exact path reaches the upstream despite the /* block', async () => {
    const res = await httpGet(ALLOW_DOMAIN, '/secret');
    expect(res.status).toBe(200);
    expect(res.body).toContain('/secret');
    expect(res.body).not.toBe('Blocked');
  });

  test('allowed wildcard subpath reaches the upstream', async () => {
    const res = await httpGet(ALLOW_DOMAIN, '/public/index.html');
    expect(res.status).toBe(200);
    expect(res.body).toContain('/public/index.html');
  });

  test('non-allowed path is still blocked by the /* catch-all', async () => {
    const res = await httpGet(ALLOW_DOMAIN, '/anything-else');
    expect(res.status).toBe(403);
    expect(res.body).toBe('Blocked');
  });

  test('a path that does not match any allow pattern is still blocked', async () => {
    // /notsecret is clearly disjoint from /secret under both exact and prefix
    // path-matching semantics, so this case is independent of Caddy version.
    const res = await httpGet(ALLOW_DOMAIN, '/notsecret');
    expect(res.status).toBe(403);
    expect(res.body).toBe('Blocked');
  });
});
