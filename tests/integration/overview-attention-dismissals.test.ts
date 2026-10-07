/**
 * Dismissing items of "Needs attention" (src/lib/attention/dismissals.ts and
 * /api/v1/overview/attention/dismissals): per account, only items the reader
 * is shown of providers that allow it, back after 24 hours or once more
 * severe, and undone one by one or all at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb, role: 'admin', userId: 1 }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  return {
    ...actual,
    requireApiUser: vi.fn(async () => ({ userId: ctx.userId, role: ctx.role, authMethod: 'bearer' })),
  };
});

import { builtInAccess, type Access } from '../../src/lib/permissions';
import { collectAttention, listAttentionProviders, registerAttentionProvider, unregisterAttentionProvider } from '../../src/lib/attention';
import { mayRead } from '../../src/lib/attention/registry';
import type { AttentionProvider, AttentionSeverity } from '../../src/lib/attention/types';
import { ATTENTION_DISMISS_HOURS, dismissAttentionItem, listAttentionDismissals, restoreAttentionItems } from '../../src/lib/attention/dismissals';
import * as dismissalsRoute from '../../app/api/v1/overview/attention/dismissals/route';
import { first } from '@/src/lib/db/ops';

const HOUR = 3_600_000;
const stamp = () => new Date().toISOString();
let adminId: number;
let otherId: number;
let spikeSeverity: AttentionSeverity;

async function user(email: string, role: string): Promise<number> {
  return (await first(ctx.db.insert(schema.users).values({ email, name: email.split('@')[0], role, status: 'active', createdAt: stamp(), updatedAt: stamp() }).returning()))!.id;
}

const trafficLike: AttentionProvider = {
  id: 'test-dismissible',
  label: 'Test traffic',
  permissions: ['analytics:read'],
  dismissible: true,
  async collect() {
    return [
      { id: 'spike:a.example.com', severity: spikeSeverity, title: 'Spike on a', detail: 'More mitigated requests.', actions: [], at: null },
      { id: 'spike:b.example.com', severity: 'info', title: 'Spike on b', detail: 'More mitigated requests.', actions: [], at: null },
    ];
  },
};

const fixed: AttentionProvider = {
  id: 'test-fixed',
  label: 'Test certificates',
  permissions: ['certificates:read'],
  async collect() {
    return [{ id: 'cert:1', severity: 'warning', title: 'Certificate expires', detail: 'Renew it.', actions: [], at: null }];
  },
};

const access = (userId: number, role = 'admin'): Access => builtInAccess(userId, role);
const readable = (reader: Access) => listAttentionProviders().filter((provider) => mayRead(provider, reader));
const titles = async (reader: Access, now?: Date) =>
  (await collectAttention(reader, { now })).items.filter((item) => item.source.startsWith('test-')).map((item) => item.title);

function request(method: string, query = '', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/overview/attention/dismissals${query}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(async () => {
  ctx.db = createTestDb();
  ctx.role = 'admin';
  spikeSeverity = 'info';
  adminId = await user('admin@example.com', 'admin');
  otherId = await user('other@example.com', 'admin');
  ctx.userId = adminId;
  registerAttentionProvider(trafficLike);
  registerAttentionProvider(fixed);
});

afterEach(() => {
  unregisterAttentionProvider(trafficLike.id);
  unregisterAttentionProvider(fixed.id);
});

describe('dismissing items', () => {
  it('marks only the items of dismissible providers', async () => {
    const view = await collectAttention(access(adminId));
    expect(view.items.find((item) => item.id === 'spike:a.example.com')?.dismissible).toBe(true);
    expect(view.items.find((item) => item.id === 'cert:1')?.dismissible).toBe(false);
    expect(view.dismissed).toBe(0);
  });

  it('hides the item from that account only, and counts it', async () => {
    const dismissal = await dismissAttentionItem(access(adminId), { source: 'test-dismissible', id: 'spike:a.example.com' }, readable(access(adminId)));
    expect(dismissal).toMatchObject({ source: 'test-dismissible', id: 'spike:a.example.com', severity: 'info' });

    const view = await collectAttention(access(adminId));
    expect(view.items.map((item) => item.title)).not.toContain('Spike on a');
    expect(view.items.map((item) => item.title)).toContain('Spike on b');
    expect(view.dismissed).toBe(1);
    expect(view.counts.info).toBe(view.items.filter((item) => item.severity === 'info').length);
    expect(await titles(access(otherId))).toContain('Spike on a');
  });

  it('lists the item again after 24 hours, or sooner once it is more severe', async () => {
    const now = new Date();
    await dismissAttentionItem(access(adminId), { source: 'test-dismissible', id: 'spike:a.example.com' }, readable(access(adminId)), now);
    expect(await titles(access(adminId), new Date(now.getTime() + (ATTENTION_DISMISS_HOURS - 1) * HOUR))).not.toContain('Spike on a');
    expect(await titles(access(adminId), new Date(now.getTime() + ATTENTION_DISMISS_HOURS * HOUR))).toContain('Spike on a');

    spikeSeverity = 'warning';
    expect(await titles(access(adminId), now)).toContain('Spike on a');
    // Dismissed again as a warning, it stays hidden while a warning or less.
    await dismissAttentionItem(access(adminId), { source: 'test-dismissible', id: 'spike:a.example.com' }, readable(access(adminId)), now);
    expect(await titles(access(adminId), now)).not.toContain('Spike on a');
    spikeSeverity = 'info';
    expect(await titles(access(adminId), now)).not.toContain('Spike on a');
    expect(await ctx.db.select().from(schema.attentionDismissals)).toHaveLength(1);
  });

  it('refuses providers that do not allow it, items not listed, and providers the reader may not read', async () => {
    await expect(dismissAttentionItem(access(adminId), { source: 'test-fixed', id: 'cert:1' }, readable(access(adminId))))
      .rejects.toMatchObject({ status: 400 });
    await expect(dismissAttentionItem(access(adminId), { source: 'test-dismissible', id: 'spike:gone.example.com' }, readable(access(adminId))))
      .rejects.toMatchObject({ status: 404 });
    const viewer = await user('viewer@example.com', 'viewer');
    const noAnalytics = { ...access(viewer, 'viewer'), permissions: new Set(['proxy_hosts:read'] as const) } as Access;
    await expect(dismissAttentionItem(noAnalytics, { source: 'test-dismissible', id: 'spike:a.example.com' }, readable(noAnalytics)))
      .rejects.toMatchObject({ status: 404 });
  });

  it('undoes one dismissal or all of them', async () => {
    const reader = access(adminId);
    await dismissAttentionItem(reader, { source: 'test-dismissible', id: 'spike:a.example.com' }, readable(reader));
    await dismissAttentionItem(reader, { source: 'test-dismissible', id: 'spike:b.example.com' }, readable(reader));
    await dismissAttentionItem(access(otherId), { source: 'test-dismissible', id: 'spike:a.example.com' }, readable(access(otherId)));
    expect(await restoreAttentionItems(adminId, { source: 'test-dismissible', id: 'spike:a.example.com' })).toBe(1);
    expect(await titles(reader)).toEqual(['Certificate expires', 'Spike on a']);
    expect(await restoreAttentionItems(adminId)).toBe(1);
    expect(await titles(reader)).toEqual(expect.arrayContaining(['Spike on a', 'Spike on b']));
    expect(await listAttentionDismissals(otherId)).toHaveLength(1);
  });
});

describe('REST API', () => {
  it('dismisses, lists and restores the caller\'s items', async () => {
    const created = await dismissalsRoute.POST(request('POST', '', { source: 'test-dismissible', id: 'spike:a.example.com' }));
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ source: 'test-dismissible', id: 'spike:a.example.com', severity: 'info' });

    const listed = await (await dismissalsRoute.GET(request('GET'))).json();
    expect(listed.dismissals.map((entry: { id: string }) => entry.id)).toEqual(['spike:a.example.com']);

    const restored = await dismissalsRoute.DELETE(request('DELETE', '?source=test-dismissible&id=spike%3Aa.example.com'));
    expect(await restored.json()).toEqual({ restored: 1 });
    expect((await (await dismissalsRoute.GET(request('GET'))).json()).dismissals).toEqual([]);
  });

  it('validates the request', async () => {
    expect((await dismissalsRoute.POST(request('POST', '', { source: 'test-dismissible' }))).status).toBe(400);
    expect((await dismissalsRoute.POST(request('POST', '', { source: 'test-dismissible', id: 'x', note: 'no' }))).status).toBe(400);
    expect((await dismissalsRoute.POST(request('POST', '', { source: 'test-fixed', id: 'cert:1' }))).status).toBe(400);
    expect((await dismissalsRoute.POST(request('POST', '', { source: 'nope', id: 'x' }))).status).toBe(404);
    expect((await dismissalsRoute.DELETE(request('DELETE', '?source=test-dismissible'))).status).toBe(400);
  });
});
