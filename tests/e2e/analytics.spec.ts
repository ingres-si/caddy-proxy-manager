import { test, expect } from '@playwright/test';

/**
 * The traffic analytics page: header controls, headline tiles that pick the
 * chart's metric, and settings that live in the URL (shareable, and the
 * back button undoes them).
 */
test.describe('Analytics', () => {
  test('loads without redirecting to login', async ({ page }) => {
    await page.goto('/analytics');
    await expect(page).not.toHaveURL(/login/);
    await expect(page.getByRole('heading', { level: 1, name: 'Analytics', exact: true })).toBeVisible();
  });

  test('shows the headline tiles, chart and request log', async ({ page }) => {
    await page.goto('/analytics');
    const tiles = page.getByRole('group', { name: 'Headline figures' });
    for (const label of ['Requests', 'Bandwidth', 'Unique addresses', 'Mitigated', '5xx error rate']) {
      await expect(tiles.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible({ timeout: 15_000 });
    }
    await expect(page.getByRole('heading', { level: 2, name: 'Requests by outcome' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Top dimensions' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Requests', exact: true })).toBeVisible();
  });

  test('does not say analytics is off when ClickHouse is configured', async ({ page }) => {
    await page.goto('/analytics');
    await expect(page.getByRole('group', { name: 'Headline figures' }).getByRole('button', { name: /^Requests/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Traffic analytics is off')).not.toBeVisible();
    await expect(page.getByTestId('analytics-load-error')).not.toBeVisible();
  });

  test('keeps the range in the URL and steps back through it', async ({ page }) => {
    await page.goto('/analytics');
    const ranges = page.getByRole('group', { name: 'Time range' });
    await expect(ranges.getByRole('button', { name: '24h' })).toHaveAttribute('aria-pressed', 'true');

    await ranges.getByRole('button', { name: '7d' }).click();
    await expect(page).toHaveURL(/[?&]range=7d/);
    await expect(ranges.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');

    await ranges.getByRole('button', { name: '1h' }).click();
    await expect(page).toHaveURL(/[?&]range=1h/);

    await page.goBack();
    await expect(page).toHaveURL(/[?&]range=7d/);
    await expect(ranges.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');

    await page.goBack();
    await expect(page).not.toHaveURL(/range=/);
    await expect(ranges.getByRole('button', { name: '24h' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('picks a custom range in UTC', async ({ page }) => {
    await page.goto('/analytics');
    await page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: 'Custom' }).click();
    await page.getByLabel('From', { exact: true }).fill('2026-01-01T00:00');
    await page.getByLabel('To', { exact: true }).fill('2026-01-02T00:00');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page).toHaveURL(/range=custom&from=1767225600&to=1767312000/);
  });

  test('selecting a tile switches the chart metric', async ({ page }) => {
    await page.goto('/analytics');
    const tiles = page.getByRole('group', { name: 'Headline figures' });
    const mitigated = tiles.getByRole('button', { name: /^Mitigated/ });
    await mitigated.click();
    await expect(page).toHaveURL(/[?&]metric=mitigated/);
    await expect(mitigated).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('heading', { level: 2, name: 'Mitigated requests by source' })).toBeVisible();

    await tiles.getByRole('button', { name: /^Bandwidth/ }).click();
    await expect(page).toHaveURL(/[?&]metric=bytes/);
    await expect(page.getByRole('heading', { level: 2, name: 'Bytes sent' })).toBeVisible();
    const groups = page.getByRole('group', { name: 'Group by' });
    await groups.getByRole('button', { name: 'Host' }).click();
    await expect(page).toHaveURL(/[?&]group=host/);
    await expect(page.getByRole('heading', { level: 2, name: 'Bytes sent by host' })).toBeVisible();
  });

  test('opens a shared link with its settings', async ({ page }) => {
    await page.goto('/analytics?range=30d&metric=errors&filter=status%3A5xx');
    await expect(page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '30d' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('heading', { level: 2, name: 'Error responses by status class' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove filter: Status code is 5xx' })).toBeVisible();
  });

  test('opens the links other pages make, with filters as JSON', async ({ page }) => {
    const filters = JSON.stringify([
      { dim: 'host', op: 'is', value: 'app.example.com' },
      { dim: 'outcome', op: 'is_not', value: 'served' },
    ]);
    await page.goto(`/analytics?range=7d&filters=${encodeURIComponent(filters)}`);
    await expect(page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Remove filter: Host is app.example.com' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove filter: Outcome is not served' })).toBeVisible();
  });

  test('does not show error content', async ({ page }) => {
    await page.goto('/analytics');
    await expect(page.locator('text=/internal server error/i')).not.toBeVisible();
  });
});
