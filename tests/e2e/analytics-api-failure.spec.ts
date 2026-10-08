import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * The analytics page when /api/v1/analytics misbehaves: errors (with and
 * without a message), answers of an unexpected shape, and ClickHouse
 * reported as unavailable or not configured. The page must explain what is
 * wrong and offer a retry, never crash: a single unreachable ClickHouse used
 * to blank the whole page.
 *
 * Routes are stubbed rather than stopping the ClickHouse container so the
 * failure modes are exact and the shared test stack stays untouched.
 */

const ANALYTICS_API = '**/api/v1/analytics/**';

/** Collects uncaught render errors, the symptom of a crash. */
function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

async function pageShellRendered(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Analytics' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '24h' })).toBeVisible();
}

const zeros = (n: number) => new Array<number>(n).fill(0);
const headline = { value: 0, previous: null, delta: null };

/** An empty answer of each endpoint with the given ClickHouse status. */
function emptyAnswer(path: string, status: 'unavailable' | 'disabled'): unknown {
  if (path.endsWith('/query')) {
    const start = Math.floor(Date.now() / 1000 / 1800) * 1800 - 47 * 1800;
    return {
      status,
      range: { preset: '24h', start, end: start + 48 * 1800, step: 1800, buckets: 48 },
      metric: 'requests',
      groupBy: 'outcome',
      filters: [],
      series: [],
      totals: zeros(48),
      previous: { available: false, reason: 'retention', start: start - 86_400, end: start },
      headline: {
        requests: headline,
        bytes: headline,
        visitors: headline,
        mitigated: { ...headline, share: 0 },
        errorRate5xx: { ...headline, count: 0 },
      },
      headlineSeries: { requests: zeros(48), bytes: zeros(48), visitors: zeros(48), mitigated: zeros(48), errors5xx: zeros(48) },
      peak: null,
      peakMitigated: null,
      retention: { days: 30, start: start - 30 * 86_400 },
    };
  }
  if (path.endsWith('/top')) return { status, total: 0, dimensions: [] };
  if (path.endsWith('/requests')) return { status, requests: [], limit: 25, offset: 0 };
  return [];
}

function fulfillJson(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

test.describe('Analytics API failures', () => {
  test('page survives every analytics endpoint returning 500', async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.route(ANALYTICS_API, (route) => fulfillJson(route, 500, { error: 'ClickHouse unreachable' }));

    await page.goto('/analytics');
    await pageShellRendered(page);

    const banner = page.getByTestId('analytics-load-error');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('ClickHouse unreachable');
    await expect(banner.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(errors, `uncaught errors crashed the page: ${JSON.stringify(errors)}`).toEqual([]);
  });

  test('error banner still appears when the server sends an empty error message', async ({ page }) => {
    // @clickhouse/client throws an AggregateError with an empty `message` on
    // ECONNREFUSED; an empty string must not hide the banner.
    const errors = trackPageErrors(page);
    await page.route(ANALYTICS_API, (route) => fulfillJson(route, 500, { error: '' }));

    await page.goto('/analytics');
    await pageShellRendered(page);

    const banner = page.getByTestId('analytics-load-error');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('answered with status 500');
    expect(errors).toEqual([]);
  });

  test('page survives answers of an unexpected shape', async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.route(ANALYTICS_API, (route) => fulfillJson(route, 200, { unexpected: 'shape' }));

    await page.goto('/analytics');
    await pageShellRendered(page);

    await expect(page.getByTestId('analytics-load-error')).toContainText('does not understand', { timeout: 15_000 });
    await expect(page.getByRole('heading', { level: 2, name: 'Top dimensions' })).toBeVisible();
    expect(errors, `uncaught errors crashed the page: ${JSON.stringify(errors)}`).toEqual([]);
  });

  test('says when ClickHouse does not answer, and retries', async ({ page }) => {
    const errors = trackPageErrors(page);
    let queries = 0;
    await page.route(ANALYTICS_API, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/query')) queries++;
      return fulfillJson(route, 200, emptyAnswer(path, 'unavailable'));
    });

    await page.goto('/analytics');
    await pageShellRendered(page);

    const banner = page.getByTestId('analytics-unavailable');
    await expect(banner).toContainText('ClickHouse is not answering', { timeout: 15_000 });
    const before = queries;
    await banner.getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => queries).toBeGreaterThan(before);
    expect(errors).toEqual([]);
  });

  test('explains how to turn analytics on when the API says it is off', async ({ page }) => {
    await page.route(ANALYTICS_API, (route) => {
      const path = new URL(route.request().url()).pathname;
      return fulfillJson(route, 200, emptyAnswer(path, 'disabled'));
    });

    await page.goto('/analytics');
    const off = page.getByTestId('analytics-disabled');
    await expect(off).toContainText('Traffic analytics is off', { timeout: 15_000 });
    await expect(off).toContainText('CLICKHOUSE_PASSWORD');
  });
});
