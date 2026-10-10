import { test, expect } from '@playwright/test';

/**
 * Governance and operations endpoints on the E2E stack (history off): the
 * overview's attention list, the setup checklist, audit log filters and
 * details, configuration versions and previews, firing alerts, managed
 * certificates, the live control status, report schedules and test
 * restores.
 */
const ORIGIN = { Origin: 'http://localhost:3000' };

test.describe('Governance API', () => {
  test('lists what needs attention for the signed-in administrator', async ({ page }) => {
    const response = await page.request.get('/api/v1/overview/attention');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ counts: expect.any(Object), truncated: expect.any(Boolean) });
    const sources = body.sources.map((source: { id: string }) => source.id);
    // Certificates are left out while the built-in certificate alert rule watches every host.
    expect(sources).toEqual(expect.arrayContaining(['alerts', 'approvals', 'my_reviews', 'setup']));
    for (const source of body.sources) expect(['ok', 'error', 'timeout']).toContain(source.status);
  });

  test('reads and marks the setup checklist', async ({ page }) => {
    const before = await (await page.request.get('/api/v1/setup-checklist')).json();
    expect(before.steps.map((step: { key: string }) => step.key)).toEqual(['domain', 'first_proxy_host', 'analytics', 'second_user', 'single_sign_on']);
    const wasMarked = before.steps.find((step: { key: string }) => step.key === 'analytics').doneBy === 'manual';
    const marked = await page.request.put('/api/v1/setup-checklist', { data: { steps: { analytics: true } }, headers: ORIGIN });
    expect(marked.status()).toBe(200);
    expect((await marked.json()).steps.find((step: { key: string }) => step.key === 'analytics').done).toBe(true);
    const undo = await page.request.put('/api/v1/setup-checklist', { data: { steps: { analytics: wasMarked } }, headers: ORIGIN });
    expect(undo.status()).toBe(200);
    expect((await page.request.put('/api/v1/setup-checklist', { data: { steps: { nope: true } }, headers: ORIGIN })).status()).toBe(400);
  });

  test('filters the audit log on the server and returns event details', async ({ page }) => {
    // Two changes that leave the checklist as it was, so at least one audit event exists.
    const checklist = await (await page.request.get('/api/v1/setup-checklist')).json();
    const wasMarked = checklist.steps.find((step: { key: string }) => step.key === 'analytics').doneBy === 'manual';
    await page.request.put('/api/v1/setup-checklist', { data: { steps: { analytics: !wasMarked } }, headers: ORIGIN });
    await page.request.put('/api/v1/setup-checklist', { data: { steps: { analytics: wasMarked } }, headers: ORIGIN });
    const filtered = await page.request.get('/api/v1/audit-log?action=setup_checklist_updated&per_page=5');
    expect(filtered.status()).toBe(200);
    const { events } = await filtered.json();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event: { action: string }) => event.action === 'setup_checklist_updated')).toBe(true);
    const detail = await page.request.get(`/api/v1/audit-log/${events[0].id}`);
    expect(detail.status()).toBe(200);
    expect(await detail.json()).toMatchObject({ id: events[0].id, configDiff: null });
    expect((await page.request.get('/api/v1/audit-log?actor=nobody')).status()).toBe(400);
    const facets = await (await page.request.get('/api/v1/audit-log/facets')).json();
    expect(facets.actions).toContain('setup_checklist_updated');
  });

  test('reads configuration versions, firing alerts, managed certificates and control status', async ({ page }) => {
    const versions = await page.request.get('/api/v1/config-history/versions');
    expect(versions.status()).toBe(200);
    expect(await versions.json()).toMatchObject({ versions: expect.any(Array), recording: expect.any(Object) });
    expect((await page.request.get('/api/v1/config-history/999999/rollback-preview')).status()).toBe(404);
    expect((await page.request.get('/api/v1/alert-events/firing')).status()).toBe(200);
    const managed = await page.request.get('/api/v1/certificates/managed');
    expect(managed.status()).toBe(200);
    expect(await managed.json()).toMatchObject({ certificates: expect.any(Array) });
    const status = await page.request.get('/api/v1/compliance/controls/status');
    expect(status.status()).toBe(200);
    expect((await status.json()).controls).toHaveLength(6);
  });

  test('sets up a report schedule and records a test restore, then deletes them', async ({ page }) => {
    // Created off, so it never runs during the suite.
    const schedule = await page.request.post('/api/v1/compliance/schedules', { data: { name: 'Monthly evidence', enabled: false }, headers: ORIGIN });
    expect(schedule.status()).toBe(201);
    const { id: scheduleId } = await schedule.json();
    expect((await page.request.get('/api/v1/compliance/schedules')).status()).toBe(200);
    expect((await page.request.delete(`/api/v1/compliance/schedules/${scheduleId}`, { headers: ORIGIN })).status()).toBe(204);

    const restore = await page.request.post('/api/v1/compliance/restore-tests', {
      data: { testedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), source: 'backup', outcome: 'success' },
      headers: ORIGIN,
    });
    expect(restore.status()).toBe(201);
    const { id: restoreId } = await restore.json();
    expect((await page.request.delete(`/api/v1/compliance/restore-tests/${restoreId}`, { headers: ORIGIN })).status()).toBe(204);
  });
});
