/**
 * Failed-answer credits (ee/monetization/answer-credits.ts): on plans that
 * credit failed answers, the gate issues a charge id that Caddy logs (the
 * log_append route), and requests whose access log line has a 5xx are
 * credited back, once per charge id, with or without high availability
 * shared state. The option needs ClickHouse analytics; without it the gate
 * issues no ids and the plan option cannot be turned on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from '../helpers/ioredis-mock';
import type Redis from 'ioredis';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { insertConsumer, insertKey, insertMonetizedHost, insertPlan, insertProxyHost } from '../helpers/monetization';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb, analytics: true }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('../../src/lib/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/clickhouse/client')>()),
  isAnalyticsEnabled: () => ctx.analytics,
}));
vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  return { ...actual, requireApiPermission: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }) };
});

import { decideGate, reloadMonetization, resetMonetizationEngineForTests, type GateDecision } from '../../ee/monetization/engine';
import { gateResponse } from '../../ee/monetization/gate-response';
import { ensureGateSecret } from '../../ee/monetization/settings';
import { creditFailedAnswers, failedAnswerChargeIds, pruneAnswerCredits, resetAnswerCreditsForTests } from '../../ee/monetization/answer-credits';
import { ANALYTICS_REQUIRED } from '../../ee/monetization/plans';
import { setSharedStateForTests, type SharedState } from '../../ee/high-availability/shared-state/connection';
import { createRedisMonetizationStore } from '../../ee/high-availability/shared-state/monetization-store';
import { drainSharedMonetization } from '../../ee/high-availability/shared-state/monetization-drain';
import { monetizationKeyNames } from '../../ee/high-availability/shared-state/monetization-keys';
import * as plansRoute from '../../app/api/v1/monetization/plans/route';
import * as planRoute from '../../app/api/v1/monetization/plans/[id]/route';
import { first } from '@/src/lib/db/ops';

const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);
const NAMESPACE = 'ingressi:0badc0de:';

type World = { token: string; hostId: number; consumerId: number; key: string };

async function seed(options: { credit?: boolean; price?: number; included?: number; balance?: number } = {}): Promise<World> {
  const plan = await insertPlan(ctx.db, {
    pricePerRequestMicros: options.price ?? 1_000,
    includedRequestsPerMonth: options.included ?? 0,
    creditFailedAnswers: options.credit ?? true,
  });
  const consumer = await insertConsumer(ctx.db, { planId: plan.id, balanceMicros: options.balance ?? 10_000 });
  const { raw } = await insertKey(ctx.db, consumer.id);
  const host = await insertProxyHost(ctx.db);
  await insertMonetizedHost(ctx.db, host.id);
  const { token } = await ensureGateSecret();
  await reloadMonetization({ quiet: true });
  return { token, hostId: host.id, consumerId: consumer.id, key: raw };
}

function call(world: World, now = T0): GateDecision {
  return decideGate({ gateToken: world.token, hostId: String(world.hostId), header: (name) => (name === 'authorization' ? `Bearer ${world.key}` : null), now });
}

/** The access log line Caddy writes for a request the gate let through, answered with `status`. */
function logLine(decision: GateDecision, status: number): string {
  const charge = decision.allow ? decision.chargeId : undefined;
  return JSON.stringify({ level: 'info', ts: T0 / 1000, msg: 'handled request', status, request: { host: 'api.example.com' }, ...(charge ? { ingressi_charge: charge } : {}) });
}

async function consumerRow(id: number) {
  return (await first(ctx.db.select().from(schema.monetizationConsumers).where(eq(schema.monetizationConsumers.id, id)).limit(1)))!;
}

async function credits(consumerId: number) {
  return (await ctx.db.select().from(schema.monetizationLedger).where(eq(schema.monetizationLedger.consumerId, consumerId))).filter((row) => row.type === 'credit');
}

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/v1/monetization/plans', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(async () => {
  ctx.db = createTestDb();
  ctx.analytics = true;
  resetMonetizationEngineForTests();
  resetAnswerCreditsForTests();
  vi.spyOn(Date, 'now').mockReturnValue(T0);
});

afterEach(() => {
  vi.restoreAllMocks();
  setSharedStateForTests(undefined);
});

describe('charge ids at the gate', () => {
  it('are issued on plans that credit failed answers and answered in X-Ingressi-Charge', async () => {
    const world = await seed();
    const decision = call(world);
    expect(decision).toMatchObject({ allow: true, chargedMicros: 1_000 });
    const response = gateResponse(decision);
    expect(response.headers.get('x-ingressi-charge')).toBe(decision.allow ? decision.chargeId : 'none');
    expect(response.headers.get('x-ingressi-charge')).toMatch(/^c1\./);
  });

  it('are not issued without the option, or without ClickHouse analytics', async () => {
    const world = await seed({ credit: false });
    expect(call(world)).not.toHaveProperty('chargeId');
    expect(gateResponse(call(world)).headers.get('x-ingressi-charge')).toBeNull();
    ctx.analytics = false;
    const other = await seed({ credit: true });
    await reloadMonetization({ quiet: true });
    expect(call(other)).not.toHaveProperty('chargeId');
  });
});

describe('crediting failed answers (no shared state)', () => {
  it('credits a 5xx answer once, however often its log line is read, and leaves 2xx and 4xx charged', async () => {
    const world = await seed({ balance: 10_000 });
    const ok = call(world);
    const notFound = call(world);
    const failed = call(world);
    const gatewayDown = call(world);
    const lines = [logLine(ok, 200), logLine(notFound, 404), logLine(failed, 500), logLine(gatewayDown, 502)];
    // The gate's charges are written first (the flush), then the parser reads the log.
    const { flushUsage } = await import('../../ee/monetization/engine');
    await flushUsage(T0);
    expect((await consumerRow(world.consumerId)).balanceMicros).toBe(6_000);

    expect(await creditFailedAnswers(failedAnswerChargeIds(lines), T0 + 30_000)).toEqual({ requests: 2, amountMicros: 2_000, freeRequests: 0 });
    // The same lines again (a crash before the parser stored its position): nothing more.
    expect(await creditFailedAnswers(failedAnswerChargeIds(lines), T0 + 60_000)).toEqual({ requests: 0, amountMicros: 0, freeRequests: 0 });
    expect((await consumerRow(world.consumerId)).balanceMicros).toBe(8_000);
    const rows = await credits(world.consumerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amountMicros: 2_000, requests: 2, freeRequests: 0, balanceAfterMicros: 8_000, description: 'Failed answers credited back' });
    expect(rows[0].externalReference).toBe(`answer-credit:${world.consumerId}:2026-10-04T12`);
    // The gate sees the credit at once.
    for (let i = 0; i < 8; i++) expect(call(world)).toMatchObject({ allow: true });
    expect(call(world)).toMatchObject({ allow: false, status: 402 });
  });

  it('gives back free requests of the current month', async () => {
    const world = await seed({ price: 1_000, included: 2, balance: 0 });
    const first = call(world);
    const second = call(world);
    expect([first, second].map((decision) => decision.allow && decision.free)).toEqual([true, true]);
    expect(call(world)).toMatchObject({ allow: false, status: 402 });
    const { flushUsage } = await import('../../ee/monetization/engine');
    await flushUsage(T0);
    expect(await creditFailedAnswers(failedAnswerChargeIds([logLine(first, 503)]), T0 + 1000)).toEqual({ requests: 1, amountMicros: 0, freeRequests: 1 });
    expect((await consumerRow(world.consumerId)).freeUsageCount).toBe(1);
    expect(call(world)).toMatchObject({ allow: true, free: true });
  });

  it('ignores forged ids and ids of deleted consumers, and retries what could not be written', async () => {
    const world = await seed();
    const decision = call(world);
    const id = decision.allow ? decision.chargeId! : '';
    const forged = id.replace(/\.[A-Za-z0-9_-]{22}$/, `.${'A'.repeat(22)}`);
    expect(await creditFailedAnswers([forged], T0)).toEqual({ requests: 0, amountMicros: 0, freeRequests: 0 });
    // The database refuses once: kept for the next pass.
    const insert = vi.spyOn(ctx.db, 'transaction').mockRejectedValueOnce(new Error('database is locked'));
    expect(await creditFailedAnswers([id], T0)).toEqual({ requests: 0, amountMicros: 0, freeRequests: 0 });
    insert.mockRestore();
    expect(await creditFailedAnswers([], T0)).toEqual({ requests: 1, amountMicros: 1_000, freeRequests: 0 });
    await ctx.db.delete(schema.monetizationConsumers);
    const again = call(world);
    expect(again).toMatchObject({ allow: true });
    expect(await creditFailedAnswers([again.allow ? again.chargeId! : ''], T0)).toEqual({ requests: 0, amountMicros: 0, freeRequests: 0 });
  });

  it('prunes credited ids after the window in which an id is accepted', async () => {
    const world = await seed();
    const decision = call(world);
    await creditFailedAnswers([decision.allow ? decision.chargeId! : ''], T0);
    expect(await ctx.db.select().from(schema.monetizationAnswerCredits)).toHaveLength(1);
    expect(await pruneAnswerCredits(T0 + 7 * 86_400_000)).toBe(0);
    expect(await pruneAnswerCredits(T0 + 9 * 86_400_000)).toBe(1);
  });
});

describe('crediting failed answers with shared state', () => {
  let redis: Redis;
  let state: SharedState;

  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    state = { redis, namespace: NAMESPACE };
    setSharedStateForTests(state);
  });

  it('credits the shared balance once per id, and the leader writes one credit row per hour', async () => {
    const world = await seed({ balance: 10_000 });
    const store = createRedisMonetizationStore(state);
    const request = { gateToken: world.token, hostId: String(world.hostId), header: (name: string) => (name === 'authorization' ? `Bearer ${world.key}` : null), now: T0 };
    const decisions = [await store.decide(request), await store.decide(request), await store.decide(request)];
    const ids = decisions.map((decision) => (decision.allow ? decision.chargeId! : ''));
    expect(ids.every((id) => id.startsWith('c1.'))).toBe(true);
    const keys = monetizationKeyNames(NAMESPACE);
    expect(await redis.hget(keys.consumer(world.consumerId), 'bal')).toBe('7000');

    expect(await creditFailedAnswers([ids[0], ids[1]], T0 + 1_000)).toEqual({ requests: 2, amountMicros: 2_000, freeRequests: 0 });
    expect(await creditFailedAnswers([ids[0], ids[1], ids[0]], T0 + 2_000)).toEqual({ requests: 0, amountMicros: 0, freeRequests: 0 });
    expect(await redis.hget(keys.consumer(world.consumerId), 'bal')).toBe('9000');
    expect(await creditFailedAnswers([ids[2]], T0 + 3_000)).toMatchObject({ requests: 1 });

    await drainSharedMonetization(state, { consumerIds: [world.consumerId], now: new Date(T0 + 4_000) });
    await drainSharedMonetization(state, { consumerIds: [world.consumerId], now: new Date(T0 + 5_000) });
    const rows = await credits(world.consumerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amountMicros: 3_000, requests: 3, externalReference: `answer-credit:${world.consumerId}:2026-10-04T12` });
    // Usage of three requests, all credited back.
    expect((await consumerRow(world.consumerId)).balanceMicros).toBe(10_000);
  });
});

describe('the plan option', () => {
  it('needs ClickHouse analytics to be turned on (409), and is kept when it is gone', async () => {
    ctx.analytics = false;
    const refused = await plansRoute.POST(req('POST', { name: 'Credited', pricePerRequestMicros: 1, creditFailedAnswers: true }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe(ANALYTICS_REQUIRED);
    ctx.analytics = true;
    const created = await plansRoute.POST(req('POST', { name: 'Credited', pricePerRequestMicros: 1, creditFailedAnswers: true }));
    expect(created.status).toBe(201);
    const plan = await created.json();
    expect(plan.creditFailedAnswers).toBe(true);
    ctx.analytics = false;
    // Other changes to a plan that has it still work.
    const renamed = await planRoute.PUT(req('PUT', { name: 'Credited 2' }), { params: Promise.resolve({ id: String(plan.id) }) });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).creditFailedAnswers).toBe(true);
  });
});
