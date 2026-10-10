import { test, expect } from '@playwright/test';
import { enableGlobalWafWithCrs } from '../helpers/waf-ui';

test.describe('Security events', () => {
  test('the time range presets and a custom range are held in the URL', async ({ page }) => {
    const customFrom = '2026-05-01T09:00';
    const customTo = '2026-05-02T09:30';
    // The page reads datetime-local values as UTC (fromUtcInput), so compute
    // the expected epochs in UTC rather than the runner's timezone.
    const expectedFrom = Math.floor(new Date(`${customFrom}Z`).getTime() / 1000);
    const expectedTo = Math.floor(new Date(`${customTo}Z`).getTime() / 1000);

    await page.goto('/security');
    await expect(page.getByRole('heading', { level: 1, name: 'Security events' })).toBeVisible();
    const range = page.getByRole('group', { name: 'Time range' });
    await expect(range.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');

    for (const preset of ['24h', '30d', '1h', '7d']) {
      await range.getByRole('button', { name: preset }).click();
      await expect(page).toHaveURL(new RegExp(`range=${preset}`));
      await expect(range.getByRole('button', { name: preset })).toHaveAttribute('aria-pressed', 'true');
    }

    await range.getByRole('button', { name: 'Custom' }).click();
    const dateInputs = page.locator('input[type="datetime-local"]');
    await expect(dateInputs).toHaveCount(2);
    await dateInputs.nth(0).fill(customFrom);
    await dateInputs.nth(1).fill(customTo);
    await page.getByRole('button', { name: 'Apply range' }).click();

    await expect(page).toHaveURL(new RegExp(`range=custom.*from=${expectedFrom}.*to=${expectedTo}`));
    await expect(dateInputs.nth(0)).toHaveValue(customFrom);
    await expect(dateInputs.nth(1)).toHaveValue(customTo);

    await range.getByRole('button', { name: '24h' }).click();
    await expect(page).toHaveURL(/range=24h/);
    await expect(page).not.toHaveURL(/from=/);
    await expect(page.locator('input[type="datetime-local"]')).toHaveCount(0);
  });

  test('the old WAF events address opens Security events filtered to the WAF', async ({ page }) => {
    await page.goto('/waf/events?range=30d');
    await expect(page).toHaveURL(/\/security\?kind=waf&range=30d$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Security events' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Source' }).getByRole('button', { name: 'WAF' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '30d' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('event filters are added, kept in the URL and removed', async ({ page }) => {
    await page.goto('/security');
    await page.getByRole('group', { name: 'Source' }).getByRole('button', { name: 'Geo' }).click();
    await expect(page).toHaveURL(/kind=geo/);

    await page.getByRole('button', { name: 'Add filter' }).click();
    await page.getByRole('button', { name: 'Address', exact: true }).click();
    // A combobox when there are addresses to suggest, a plain textbox otherwise.
    await page.getByLabel('Address value', { exact: true }).fill('192.0.2.10');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page).toHaveURL(/filters=/);
    const chip = page.getByRole('button', { name: 'Remove filter: Address is 192.0.2.10' });
    await expect(chip).toBeVisible();

    await page.reload();
    await expect(page.getByRole('group', { name: 'Source' }).getByRole('button', { name: 'Geo' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Remove filter: Address is 192.0.2.10' }).click();
    await expect(page).not.toHaveURL(/filters=/);
    await expect(page).toHaveURL(/kind=geo/);
  });

  test('an invalid filter in the URL is reported, not applied', async ({ page }) => {
    await page.goto(`/security?filters=${encodeURIComponent('[{"dim":"ip","op":"is","value":"not-an-ip"}]')}`);
    await expect(page.getByText('A filter in the address is not valid, so it is not applied.')).toBeVisible();
  });

  test('links to the WAF settings', async ({ page }) => {
    await page.goto('/security');
    await page.getByRole('link', { name: 'WAF settings' }).first().click();
    await expect(page).toHaveURL(/\/waf$/);
  });
});

test.describe('WAF settings', () => {
  test('WAF settings page loads without redirecting to login', async ({ page }) => {
    await page.goto('/waf');
    await expect(page).not.toHaveURL(/login/);
    await expect(page.getByRole('heading', { level: 1, name: 'WAF settings' })).toBeVisible();
    for (const section of ['Global mode', 'Rule set', 'Request bodies', 'Per-host settings', 'Rule exclusions', 'Custom rules']) {
      await expect(page.getByRole('heading', { level: 2, name: section })).toBeVisible();
    }
  });

  test('changes show as not applied until saved, and Discard puts them back', async ({ page }) => {
    await page.goto('/waf');
    const level = page.getByRole('radiogroup', { name: 'Paranoia level' });
    const crs = page.getByRole('switch', { name: 'Load the Core Rule Set' });
    if ((await crs.getAttribute('data-state')) !== 'checked') await crs.click();
    const before = await level.getByRole('radio', { checked: true }).textContent();
    await level.getByRole('radio', { name: /Paranoid/ }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Not applied yet' })).toContainText('paranoia level');
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByText(/^Not applied yet/)).toHaveCount(0);
    await expect(level.getByRole('radio', { checked: true })).toHaveText(before ?? '');
  });

  test('global settings persist after save and navigation', async ({ page }) => {
    await enableGlobalWafWithCrs(page);

    await page.goto('/hosts');
    await expect(page).not.toHaveURL(/login/);
    await page.goto('/waf');

    await expect(page.getByRole('switch', { name: /^Apply to all \d+ hosts$/ })).toHaveAttribute('data-state', 'checked');
    await expect(page.getByRole('switch', { name: 'Load the Core Rule Set' })).toHaveAttribute('data-state', 'checked');
    await expect(page.getByRole('radiogroup', { name: 'Global mode' }).getByRole('radio', { name: /^Blocking/ })).toHaveAttribute('aria-checked', 'true');
  });

  test('tuning is saved', async ({ page }) => {
    await enableGlobalWafWithCrs(page);
    await page.getByRole('radiogroup', { name: 'Paranoia level' }).getByRole('radio', { name: /Elevated/ }).click();
    await page.getByLabel('Inbound anomaly threshold').fill('7');
    await expect(page.getByRole('status').filter({ hasText: 'Not applied yet' })).toContainText('inbound threshold');
    await page.getByRole('button', { name: 'Save and apply' }).first().click();
    await expect(page.getByText('WAF settings saved and applied.')).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await expect(page.getByLabel('Inbound anomaly threshold')).toHaveValue('7');
    await expect(page.getByRole('radiogroup', { name: 'Paranoia level' }).getByRole('radio', { name: /Elevated/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Core Rule Set 4.25, paranoia level 2')).toBeVisible();

    // Put the defaults back for the specs that follow.
    await page.getByRole('radiogroup', { name: 'Paranoia level' }).getByRole('radio', { name: /Baseline/ }).click();
    await page.getByLabel('Inbound anomaly threshold').fill('5');
    await page.getByRole('button', { name: 'Save and apply' }).first().click();
    await expect(page.getByText('WAF settings saved and applied.')).toBeVisible({ timeout: 15_000 });
  });

  test('adds and removes a rule exclusion', async ({ page }) => {
    await page.goto('/waf');
    await page.getByRole('button', { name: 'Add exclusion' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add exclusion' });
    await dialog.getByLabel('Rule', { exact: true }).fill('920350');
    await dialog.getByRole('textbox', { name: /^Path/ }).fill('/e2e-exclusion/');
    await dialog.getByLabel('Reason').fill('Playwright exclusion');
    await dialog.getByRole('button', { name: 'Add exclusion' }).click();
    await expect(dialog).toHaveCount(0);

    await page.getByRole('searchbox', { name: 'Search exclusions' }).fill('Playwright');
    const row = page.getByRole('row').filter({ hasText: 'Playwright exclusion' });
    await expect(row).toContainText('/e2e-exclusion/');
    await row.getByRole('button', { name: /Remove exclusion of rule 920350/ }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Playwright exclusion' })).toHaveCount(0);
  });

  test('refuses an exclusion of a rule that decides blocking', async ({ page }) => {
    await page.goto('/waf');
    await page.getByRole('button', { name: 'Add exclusion' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add exclusion' });
    await dialog.getByLabel('Rule', { exact: true }).fill('949110');
    await dialog.getByLabel('Reason').fill('Should not be possible');
    await dialog.getByRole('button', { name: 'Add exclusion' }).click();
    await expect(dialog.getByRole('alert')).toContainText('decides whether a request is blocked');
  });
});
