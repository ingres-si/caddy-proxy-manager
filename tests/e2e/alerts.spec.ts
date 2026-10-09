/**
 * Alerts page on the E2E stack: the Open view, the tabs, the built-in rules,
 * the rule editor with its scope control and every rule type, testing a
 * channel before saving it, and AI settings with the model timeout.
 */
import { test, expect } from '@playwright/test';

test.describe('Alerts', () => {
  test('loads with the open alerts', async ({ page }) => {
    await page.goto('/alerts');
    await expect(page).not.toHaveURL(/login/);
    await expect(page.getByRole('heading', { name: 'Alerts', level: 1 })).toBeVisible();
    await expect(page.getByText(/needs a license/i)).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /Open/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Open now', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'AI' })).toHaveCount(0);
  });

  test('switches tabs and keeps the tab in the URL', async ({ page }) => {
    await page.goto('/alerts');
    await page.getByRole('tab', { name: /History/ }).click();
    await expect(page).toHaveURL(/tab=history/);
    await expect(page.getByRole('heading', { name: 'Last 7 days', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Event log, last 90 days' })).toBeVisible();

    await page.getByRole('tab', { name: /Rules/ }).click();
    await expect(page).toHaveURL(/tab=rules/);
    await expect(page.getByRole('heading', { name: 'Rules', exact: true })).toBeVisible();

    await page.getByRole('tab', { name: /Channels/ }).click();
    await expect(page).toHaveURL(/tab=channels/);
    await expect(page.getByRole('heading', { name: 'Channels', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add channel' }).first()).toBeVisible();
  });

  test('lists the built-in rules, which can be disabled but not deleted', async ({ page }) => {
    await page.goto('/alerts?tab=rules');
    await expect(page.getByText('Certificates expiring or not renewed')).toBeVisible();
    await expect(page.getByText('Built-in', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete rule Server errors' })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'Enabled: WAF block spike' })).toHaveAttribute('aria-checked', 'false');

    const rules = (await (await page.request.get('/api/v1/alert-rules')).json()) as { id: number; builtIn: string | null }[];
    const certificates = rules.find((rule) => rule.builtIn === 'certificates');
    expect(certificates).toBeTruthy();
    const refused = await page.request.delete(`/api/v1/alert-rules/${certificates!.id}`, { headers: { Origin: 'http://localhost:3000' } });
    expect(refused.status()).toBe(409);
  });

  test('New rule opens the editor with a scope control', async ({ page }) => {
    await page.goto('/alerts?tab=rules');
    await page.getByRole('button', { name: 'New rule' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'New rule' })).toBeVisible();

    // A certificate rule can be limited to chosen hosts.
    const scope = dialog.getByRole('group', { name: 'Hosts the rule watches' });
    await expect(scope.getByRole('button', { name: 'All hosts' })).toHaveAttribute('aria-pressed', 'true');
    await scope.getByRole('button', { name: 'Chosen hosts' }).click();
    await expect(dialog.getByRole('button', { name: 'Search and choose proxy hosts' })).toBeVisible();
    await expect(dialog.getByLabel('Fire after the condition held for')).toBeVisible();

    // Every rule type can be chosen.
    await dialog.getByRole('combobox', { name: 'Rule type' }).click();
    await expect(page.getByRole('option', { name: 'Error rate', exact: true })).not.toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('option', { name: /License/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('a channel can be tested before it is saved', async ({ page }) => {
    const before = ((await (await page.request.get('/api/v1/alert-channels')).json()) as unknown[]).length;
    await page.goto('/alerts?tab=channels');
    await page.getByRole('button', { name: 'Add channel' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox', { name: 'Channel type' }).click();
    await page.getByRole('option', { name: 'Webhook' }).click();
    await dialog.getByLabel('Name').fill('Draft webhook');
    // Nothing listens there: the test reports the failure, and nothing is saved.
    await dialog.getByLabel('URL', { exact: true }).fill('http://127.0.0.1:9/alerts');
    await dialog.getByRole('button', { name: 'Send test' }).click();
    await expect(dialog.getByText(/could not|refused|not allowed|failed/i).first()).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(((await (await page.request.get('/api/v1/alert-channels')).json()) as unknown[]).length).toBe(before);
  });

  test('AI settings show the model timeout, 60 seconds unless set; the old AI tab leads there', async ({ page }) => {
    await page.goto('/alerts?tab=ai');
    await expect(page).toHaveURL(/\/settings\/ai$/);
    await expect(page.getByRole('heading', { name: 'AI settings', level: 1 })).toBeVisible();
    const timeout = page.getByLabel('Timeout (seconds)');
    await expect(timeout).toHaveValue('60');
    await expect(timeout).toHaveAttribute('min', '5');
    await expect(timeout).toHaveAttribute('max', '300');
    await expect(timeout).toBeEnabled();

    const settings = await page.request.get('/api/v1/ai/settings');
    expect(settings.status()).toBe(200);
    expect(await settings.json()).toMatchObject({ timeoutSeconds: 60 });
  });
});
