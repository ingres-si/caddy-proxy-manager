/**
 * Functional tests: redirect rules with full URLs, cross-domain destinations,
 * and wildcard path patterns.
 *
 * All tests send real HTTP requests to Caddy (port 80) with a custom Host
 * header and assert the response from Caddy — no redirect following.
 *
 * Caddy path matcher wildcard behaviour (used in the "from" field):
 *   - Exact:          "/foo/bar"  — only that path
 *   - Suffix glob:    "/foo/bar*" — anything starting with /foo/bar
 *   - Dir glob:       "/foo/*"    — anything under /foo/ (requires the slash)
 *
 * Domain: func-redirects-adv.test
 */
import { test, expect } from '@playwright/test';
import { httpGet, injectFormFields, waitForRoute, setForceSsl } from '../../helpers/http';

const DOMAIN = 'func-redirects-adv.test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the Location header value from a response, normalised to a string. */
function location(res: Awaited<ReturnType<typeof httpGet>>): string {
  const h = res.headers['location'];
  return Array.isArray(h) ? h[0] : (h ?? '');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe.serial('Redirect Rules – full URLs, cross-domain, wildcards', () => {
  test('setup: create proxy host with advanced redirect rules', async ({ page }) => {
    await page.goto('/proxy-hosts');
    await page.getByRole('button', { name: /create host/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByLabel('Name').fill('Functional Advanced Redirects Test');
    await page.getByLabel(/domains/i).fill(DOMAIN);
    await page.getByPlaceholder('10.0.0.5:8080').first().fill('echo-server:8080');

    // Force SSL defaults to ON; these tests exercise plain-HTTP routing.
    await setForceSsl(page, false);
    await injectFormFields(page, {
      redirectsJson: JSON.stringify([
        // ── full absolute URL destinations ──────────────────────────────────
        // Exact path → full URL on a completely different host (301)
        { from: '/old-page',          to: 'https://new-site.example.com/page',  status: 301 },
        // Exact path → full URL with path on another domain (308 permanent)
        { from: '/docs',              to: 'https://docs.example.com/v2/',        status: 308 },
        // Exact path → full URL using http:// scheme (302 temporary)
        { from: '/insecure-legacy',   to: 'http://legacy.example.com/',          status: 302 },

        // ── wildcard "from" → relative destination ──────────────────────────
        // /.well-known/* → any well-known path redirected to /dav/ (301)
        { from: '/.well-known/*',     to: '/dav/',                               status: 301 },
        // /api/v1/* → all v1 endpoints redirected to /api/v2/ (302)
        { from: '/api/v1/*',          to: '/api/v2/',                            status: 302 },
        // /legacy* → bare prefix (no slash after) covers /legacy and /legacy/* (307)
        { from: '/legacy*',           to: '/current/',                           status: 307 },

        // ── wildcard "from" → full URL destination ──────────────────────────
        // /moved/* → absolute URL on another domain (308)
        { from: '/moved/*',           to: 'https://archive.example.com/',        status: 308 },
      ]),
    });

    await page.getByRole('button', { name: /^create$/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('table').getByText('Functional Advanced Redirects Test')).toBeVisible({ timeout: 10_000 });

    await waitForRoute(DOMAIN);
  });

  // ── full absolute URL destinations ─────────────────────────────────────────

  test('exact path → full URL: status is 301', async () => {
    const res = await httpGet(DOMAIN, '/old-page');
    expect(res.status).toBe(301);
  });

  test('exact path → full URL: Location is the full absolute URL', async () => {
    const res = await httpGet(DOMAIN, '/old-page');
    expect(location(res)).toBe('https://new-site.example.com/page');
  });

  test('exact path → full URL on another domain: status is 308', async () => {
    const res = await httpGet(DOMAIN, '/docs');
    expect(res.status).toBe(308);
  });

  test('exact path → full URL on another domain: Location preserves path', async () => {
    const res = await httpGet(DOMAIN, '/docs');
    expect(location(res)).toBe('https://docs.example.com/v2/');
  });

  test('exact path → http:// URL: status is 302', async () => {
    const res = await httpGet(DOMAIN, '/insecure-legacy');
    expect(res.status).toBe(302);
  });

  test('exact path → http:// URL: Location uses http scheme', async () => {
    const res = await httpGet(DOMAIN, '/insecure-legacy');
    expect(location(res)).toMatch(/^http:\/\//);
    expect(location(res)).toBe('http://legacy.example.com/');
  });

  // ── wildcard "from" → relative destination ─────────────────────────────────

  test('wildcard /.well-known/*: first subpath redirects with 301', async () => {
    const res = await httpGet(DOMAIN, '/.well-known/carddav');
    expect(res.status).toBe(301);
    expect(location(res)).toBe('/dav/');
  });

  test('wildcard /.well-known/*: second subpath also redirects with 301', async () => {
    const res = await httpGet(DOMAIN, '/.well-known/caldav');
    expect(res.status).toBe(301);
    expect(location(res)).toBe('/dav/');
  });

  test('wildcard /.well-known/*: deeply nested subpath redirects with 301', async () => {
    const res = await httpGet(DOMAIN, '/.well-known/openid-configuration');
    expect(res.status).toBe(301);
    expect(location(res)).toBe('/dav/');
  });

  test('wildcard /api/v1/*: first v1 endpoint redirects with 302', async () => {
    const res = await httpGet(DOMAIN, '/api/v1/users');
    expect(res.status).toBe(302);
    expect(location(res)).toBe('/api/v2/');
  });

  test('wildcard /api/v1/*: second v1 endpoint also redirects with 302', async () => {
    const res = await httpGet(DOMAIN, '/api/v1/orders/42');
    expect(res.status).toBe(302);
    expect(location(res)).toBe('/api/v2/');
  });

  test('wildcard /api/v2/* is not matched (different prefix)', async () => {
    const res = await httpGet(DOMAIN, '/api/v2/users');
    expect(res.status).toBe(200);
    expect(res.body).toContain('echo-ok');
  });

  test('bare-prefix wildcard /legacy*: matches path without trailing segment', async () => {
    const res = await httpGet(DOMAIN, '/legacy');
    expect(res.status).toBe(307);
    expect(location(res)).toBe('/current/');
  });

  test('bare-prefix wildcard /legacy*: matches path with trailing segment', async () => {
    const res = await httpGet(DOMAIN, '/legacy/old-feature');
    expect(res.status).toBe(307);
    expect(location(res)).toBe('/current/');
  });

  test('bare-prefix wildcard /legacy*: matches path with suffix (no slash)', async () => {
    const res = await httpGet(DOMAIN, '/legacy-stuff');
    expect(res.status).toBe(307);
    expect(location(res)).toBe('/current/');
  });

  // ── wildcard "from" → full URL destination ─────────────────────────────────

  test('wildcard /moved/* → absolute URL: first subpath redirects with 308', async () => {
    const res = await httpGet(DOMAIN, '/moved/post-1');
    expect(res.status).toBe(308);
    expect(location(res)).toBe('https://archive.example.com/');
  });

  test('wildcard /moved/* → absolute URL: second subpath also redirects with 308', async () => {
    const res = await httpGet(DOMAIN, '/moved/category/post-2');
    expect(res.status).toBe(308);
    expect(location(res)).toBe('https://archive.example.com/');
  });

  // ── unmatched paths still reach the upstream ───────────────────────────────

  test('path matching no rule is proxied to the upstream', async () => {
    const res = await httpGet(DOMAIN, '/some/other/path');
    expect(res.status).toBe(200);
    expect(res.body).toContain('echo-ok');
  });

  test('root path matching no rule is proxied to the upstream', async () => {
    const res = await httpGet(DOMAIN, '/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('echo-ok');
  });
});
