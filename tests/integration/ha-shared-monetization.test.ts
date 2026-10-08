/**
 * API monetization with high availability shared state
 * (ee/high-availability/shared-state/monetization-*.ts), on ioredis-mock,
 * which runs the real Lua scripts: atomic charging across nodes (no
 * overspend), free requests and the per-minute limit shared, credits once
 * per reference, the leader's write-back to the ledger (idempotent, also
 * after a crash between commit and cleanup), immediate refusal of disabled
 * consumers and revoked keys, failing closed, TTLs. Without shared state the
 * local store stays in use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from '../helpers/ioredis-mock';
import type Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import type { TestDb } from '../helpers/db';
import { insertConsumer, insertKey, insertMonetizedHost, insertPlan, insertProxyHost } from '../helpers/monetization';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});
vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import * as schema from '../../src/lib/db/schema';
import { reloadMonetization, resetMonetizationEngineForTests, type GateDecision } from '../../ee/monetization/engine';
import { handleGateRequest } from '../../ee/monetization/gate-response';
import { ensureGateSecret } from '../../ee/monetization/settings';
import { localBalanceStore, monetizationBalanceStore } from '../../ee/monetization/balance-store';
import { setSharedStateForTests, type SharedState } from '../../ee/high-availability/shared-state/connection';
import { createRedisMonetizationStore, takeTouchedConsumers } from '../../ee/high-availability/shared-state/monetization-store';
import { monetizationKeyNames } from '../../ee/high-availability/shared-state/monetization-keys';
import { drainSharedMonetization } from '../../ee/high-availability/shared-state/monetization-drain';
import { handleStripeEvent } from '../../ee/monetization/payments';
import { first as dbFirst } from '@/src/lib/db/ops';

const NAMESPACE = 'ingressi:89abcdef:';
const T0 = Date.UTC(2026, 9, 3, 12, 0, 10);
let redis: Redis;
let state: SharedState;

type World = { token: string; hostId: number; consumerId: number; key: string; keyId: number };

async function seed(options: { price?: number; included?: number; perMinute?: number | null; balance?: number; overdraft?: number } = {}): Promise<World> {
  const plan = await insertPlan(ctx.db, {
    name: `Plan ${Math.random()}`,
    pricePerRequestMicros: options.price ?? 1_000,
    includedRequestsPerMonth: options.included ?? 0,
    requestsPerMinute: options.perMinute ?? null,
  });
  const consumer = await insertConsumer(ctx.db, { planId: plan.id, balanceMicros: options.balance ?? 10_000, overdraftAllowanceMicros: options.overdraft ?? 0 });
  const { raw, row } = await insertKey(ctx.db, consumer.id);
  const host = await insertProxyHost(ctx.db);
  await insertMonetizedHost(ctx.db, host.id);
  const { token } = await ensureGateSecret();
  await reloadMonetization();
  return { token, hostId: host.id, consumerId: consumer.id, key: raw, keyId: row.id };
}

function request(world: World, now = T0) {
  const headers = new Headers({ authorization: `Bearer ${world.key}` });
  return { gateToken: world.token, hostId: String(world.hostId), header: (name: string) => headers.get(name), now };
}

function gateHeaders(world: World): Headers {
  return new Headers({ 'X-Ingressi-Gate-Token': world.token, 'X-Ingressi-Host-Id': String(world.hostId), Authorization: `Bearer ${world.key}` });
}

async function consumerRow(id: number) {
  return (await dbFirst(ctx.db.select().from(schema.monetizationConsumers).where(eq(schema.monetizationConsumers.id, id)).limit(1)))!;
}

async function ledger(consumerId: number) {
  return await ctx.db.select().from(schema.monetizationLedger).where(eq(schema.monetizationLedger.consumerId, consumerId));
}

beforeEach(async () => {
  for (const table of [
    schema.monetizationLedger,
    schema.monetizationKeys,
    schema.monetizationConsumers,
    schema.monetizationPlans,
    schema.monetizationHosts,
    schema.monetizationSharedCursors,
    schema.proxyHosts,
    schema.settings,
  ]) {
    await ctx.db.delete(table);
  }
  resetMonetizationEngineForTests();
  takeTouchedConsumers();
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  state = { redis, namespace: NAMESPACE };
  setSharedStateForTests(state);
});

afterEach(() => {
  setSharedStateForTests(undefined);
  vi.restoreAllMocks();
});

describe('store selection', () => {
  it('uses the local store without shared state, the shared one with it', async () => {
    setSharedStateForTests(null);
    expect(await monetizationBalanceStore()).toBe(localBalanceStore);
    setSharedStateForTests(state);
    expect((await monetizationBalanceStore()).backend).toBe('redis');
  });
});

describe('charging', () => {
  it('charges the shared balance, not SQLite, and seeds it from the database once', async () => {
    const world = await seed({ price: 1_000, balance: 10_000 });
    const response = await handleGateRequest(gateHeaders(world), T0);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-ingressi-consumer-id')).toBe(String(world.consumerId));
    expect((await consumerRow(world.consumerId)).balanceMicros).toBe(10_000);
    const keys = monetizationKeyNames(NAMESPACE);
    expect(await redis.hget(keys.consumer(world.consumerId), 'bal')).toBe('9000');
    // Later changes to the row do not reseed the shared hash.
    await ctx.db.update(schema.monetizationConsumers).set({ balanceMicros: 1 }).where(eq(schema.monetizationConsumers.id, world.consumerId));
    expect((await handleGateRequest(gateHeaders(world), T0)).status).toBe(200);
    expect(await redis.hget(keys.consumer(world.consumerId), 'bal')).toBe('8000');
  });

  it('never overspends with concurrent requests on several nodes', async () => {
    const world = await seed({ price: 1_000, balance: 10_000, overdraft: 2_000 });
    const nodes = [createRedisMonetizationStore(state), createRedisMonetizationStore({ redis: new RedisMock() as unknown as Redis, namespace: NAMESPACE }), createRedisMonetizationStore(state)];
    const decisions: GateDecision[] = await Promise.all(
      Array.from({ length: 60 }, (_, index) => nodes[index % nodes.length].decide(request(world)))
    );
    const allowed = decisions.filter((decision) => decision.allow);
    expect(allowed).toHaveLength(12); // 10,000 + 2,000 overdraft at 1,000 each
    expect(decisions.filter((decision) => !decision.allow && decision.status === 402)).toHaveLength(48);
    expect(await redis.hget(monetizationKeyNames(NAMESPACE).consumer(world.consumerId), 'bal')).toBe('-2000');
  });

  it('shares free monthly requests and the per-minute limit across nodes', async () => {
    const world = await seed({ price: 500, balance: 0, included: 3, perMinute: 5 });
    const a = createRedisMonetizationStore(state);
    const b = createRedisMonetizationStore(state);
    const results = [];
    for (let index = 0; index < 6; index++) results.push(await (index % 2 ? a : b).decide(request(world)));
    // Three free requests, then the empty balance refuses (refusals do not count against the limit of five a minute).
    expect(results.slice(0, 3).map((decision) => decision.allow && decision.free)).toEqual([true, true, true]);
    expect(results[3]).toMatchObject({ allow: false, status: 402 });
    expect(results[4]).toMatchObject({ allow: false, status: 402 });
    expect(await a.decide(request(world))).toMatchObject({ status: 402 });
    // A new month has its free requests again.
    expect(await a.decide(request(world, Date.UTC(2026, 10, 1, 0, 0, 5)))).toMatchObject({ allow: true, free: true });
  });

  it('applies the per-minute limit to allowed requests', async () => {
    const world = await seed({ price: 1, balance: 1_000_000, perMinute: 2 });
    const store = createRedisMonetizationStore(state);
    expect(await store.decide(request(world))).toMatchObject({ allow: true });
    expect(await store.decide(request(world))).toMatchObject({ allow: true });
    expect(await store.decide(request(world))).toMatchObject({ allow: false, status: 429 });
    expect(await store.decide(request(world, T0 + 60_000))).toMatchObject({ allow: true });
  });

  it('refuses a disabled consumer and a revoked key on every node at once', async () => {
    const world = await seed({ price: 1, balance: 1_000 });
    const store = createRedisMonetizationStore(state);
    expect(await store.decide(request(world))).toMatchObject({ allow: true });
    // Another node disabled it: this node's index has not reloaded yet.
    await ctx.db.update(schema.monetizationConsumers).set({ status: 'disabled' }).where(eq(schema.monetizationConsumers.id, world.consumerId));
    await store.consumerStatusChanged(world.consumerId, false);
    expect(await store.decide(request(world))).toMatchObject({ allow: false, status: 403, error: 'consumer_disabled' });
    await ctx.db.update(schema.monetizationConsumers).set({ status: 'active' }).where(eq(schema.monetizationConsumers.id, world.consumerId));
    await store.consumerStatusChanged(world.consumerId, true);
    expect(await store.decide(request(world))).toMatchObject({ allow: true });
    await store.keyRevoked(world.consumerId, world.keyId);
    expect(await store.decide(request(world))).toMatchObject({ allow: false, status: 401, error: 'invalid_api_key' });
  });

  it('fails closed when the shared server does not answer, and says nothing without the gate token', async () => {
    const world = await seed();
    vi.spyOn(redis, 'evalsha').mockRejectedValue(new Error('Connection is closed.'));
    vi.spyOn(redis, 'eval').mockRejectedValue(new Error('Connection is closed.'));
    const response = await handleGateRequest(gateHeaders(world), T0);
    expect(response.status).toBe(503);
    const forged = new Headers({ 'X-Ingressi-Gate-Token': 'wrong', 'X-Ingressi-Host-Id': String(world.hostId), Authorization: `Bearer ${world.key}` });
    expect((await handleGateRequest(forged, T0)).status).toBe(403);
  });

  it('sets a TTL on every key it writes', async () => {
    const world = await seed({ price: 1, balance: 1_000 });
    const store = createRedisMonetizationStore(state);
    await store.decide(request(world));
    await store.credit({ consumerId: world.consumerId, type: 'topup', amountMicros: 5, reference: 'stripe:cs_ttl', description: null, createdBy: null });
    await store.allowCall('me:1', 60, 60_000);
    const keys = await redis.keys('*');
    expect(keys.length).toBeGreaterThan(3);
    for (const key of keys) {
      expect(key.startsWith(NAMESPACE), key).toBe(true);
      expect(await redis.pttl(key), key).toBeGreaterThan(0);
    }
  });
});

describe('credits and the ledger', () => {
  it('credits once per reference, at once on every node, and writes the ledger row on the leader', async () => {
    const world = await seed({ price: 1_000, balance: 0 });
    const store = createRedisMonetizationStore(state);
    expect(await store.decide(request(world))).toMatchObject({ status: 402 });
    const topup = { consumerId: world.consumerId, type: 'topup' as const, amountMicros: 5_000, reference: 'stripe:cs_test_1', description: 'Stripe Checkout top-up', createdBy: null };
    const result = await store.credit(topup);
    expect(result).toMatchObject({ status: 'applied', balanceMicros: 5_000 });
    expect(result.status === 'applied' && result.entry).toMatchObject({ type: 'topup', amountMicros: 5_000, reference: 'stripe:cs_test_1', balanceAfterMicros: 5_000 });
    expect(await store.credit(topup)).toEqual({ status: 'duplicate' });
    expect(await store.decide(request(world))).toMatchObject({ allow: true });
    expect((await consumerRow(world.consumerId)).balanceMicros).toBe(5_000);
    expect(await redis.llen(monetizationKeyNames(NAMESPACE).credits(world.consumerId))).toBe(0);
  });

  it('takes Stripe webhooks through the shared balances', async () => {
    const world = await seed({ price: 1_000, balance: 0 });
    await ctx.db.insert(schema.settings).values({ key: 'monetization_payments', value: JSON.stringify({ currency: 'usd' }), updatedAt: new Date().toISOString() });
    const installId = (await ensureGateSecret()).installId;
    const event = {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_hook', mode: 'payment', payment_status: 'paid', amount_total: 100, currency: 'usd', metadata: { ingressi_consumer_id: String(world.consumerId), ingressi_install: installId } } },
    };
    expect(await handleStripeEvent(event)).toMatchObject({ handled: true, duplicate: false, amountMicros: 1_000_000 });
    expect(await handleStripeEvent(event)).toMatchObject({ handled: true, duplicate: true });
    expect((await ledger(world.consumerId)).filter((row) => row.type === 'topup')).toHaveLength(1);
  });

  it('writes usage to the ledger idempotently, also after a crash before the cleanup', async () => {
    const world = await seed({ price: 1_000, balance: 10_000, included: 1 });
    const store = createRedisMonetizationStore(state);
    for (let index = 0; index < 4; index++) expect(await store.decide(request(world))).toMatchObject({ allow: true });
    const at = new Date(T0 + 1_000);
    const first = await drainSharedMonetization(state, { consumerIds: [world.consumerId], now: at });
    expect(first).toMatchObject({ requests: 4, chargedMicros: 3_000 });
    expect(await consumerRow(world.consumerId)).toMatchObject({ balanceMicros: 7_000, freeUsageMonth: '2026-10', freeUsageCount: 1 });
    const usage = (await ledger(world.consumerId)).filter((row) => row.type === 'usage');
    expect(usage).toMatchObject([{ amountMicros: -3_000, requests: 4, freeRequests: 1, balanceAfterMicros: 7_000 }]);

    // Again: nothing new.
    expect(await drainSharedMonetization(state, { consumerIds: [world.consumerId], now: at })).toMatchObject({ requests: 0, chargedMicros: 0, credits: 0 });

    // A credit still queued after the commit (the node stopped before taking it out of the queue).
    await store.decide(request(world));
    const credits = monetizationKeyNames(NAMESPACE).credits(world.consumerId);
    await redis.rpush(credits, JSON.stringify({ id: 'b2f0c6a4-credit-1', ref: null, type: 'adjustment', amount: 500, desc: 'x', by: null, at: at.toISOString() }));
    const lrem = vi.spyOn(redis, 'lrem').mockRejectedValueOnce(new Error('Connection is closed.'));
    await expect(drainSharedMonetization(state, { consumerIds: [world.consumerId], now: at })).rejects.toThrow();
    lrem.mockRestore();
    expect(await redis.llen(credits)).toBe(1);
    const after = await drainSharedMonetization(state, { consumerIds: [world.consumerId], now: at });
    expect(after).toMatchObject({ requests: 0, credits: 0 });
    expect((await consumerRow(world.consumerId)).balanceMicros).toBe(7_000 - 1_000 + 500);
    expect((await ledger(world.consumerId)).filter((row) => row.type === 'adjustment')).toHaveLength(1);
    expect((await ledger(world.consumerId)).filter((row) => row.type === 'usage')).toHaveLength(1);
    expect(await redis.llen(monetizationKeyNames(NAMESPACE).credits(world.consumerId))).toBe(0);
  });

  it('starts a new epoch when the shared hash is created again', async () => {
    const world = await seed({ price: 100, balance: 1_000 });
    const store = createRedisMonetizationStore(state);
    await store.decide(request(world));
    await drainSharedMonetization(state, { consumerIds: [world.consumerId] });
    expect((await consumerRow(world.consumerId)).balanceMicros).toBe(900);
    // Redis lost the hash: it is seeded again from the ledger's balance, and only new usage is written.
    await redis.del(monetizationKeyNames(NAMESPACE).consumer(world.consumerId));
    await store.decide(request(world));
    await store.decide(request(world));
    const result = await drainSharedMonetization(state, { consumerIds: [world.consumerId] });
    expect(result).toMatchObject({ requests: 2, chargedMicros: 200 });
    expect((await consumerRow(world.consumerId)).balanceMicros).toBe(700);
  });

  it('drains the consumers other nodes reported, and lets a running drain go first', async () => {
    const world = await seed({ price: 10, balance: 1_000 });
    const store = createRedisMonetizationStore(state);
    await store.decide(request(world));
    const { reportTouchedConsumers } = await import('../../ee/high-availability/shared-state/monetization-drain');
    await reportTouchedConsumers(state, takeTouchedConsumers());
    expect(await redis.smembers(monetizationKeyNames(NAMESPACE).dirty)).toEqual([String(world.consumerId)]);
    await redis.set(monetizationKeyNames(NAMESPACE).drainLock, 'other-node', 'PX', 30_000);
    expect(await drainSharedMonetization(state)).toMatchObject({ ran: false });
    await redis.del(monetizationKeyNames(NAMESPACE).drainLock);
    expect(await drainSharedMonetization(state)).toMatchObject({ ran: true, requests: 1 });
    expect(await redis.smembers(monetizationKeyNames(NAMESPACE).dirty)).toEqual([]);
  });

  it('writes a consumer’s usage before it is deleted', async () => {
    const world = await seed({ price: 10, balance: 1_000 });
    const store = createRedisMonetizationStore(state);
    await store.decide(request(world));
    const { deleteConsumer } = await import('../../ee/monetization/consumers');
    await deleteConsumer(world.consumerId, 1);
    expect((await ledger(world.consumerId)).filter((row) => row.type === 'usage')).toMatchObject([{ requests: 1, amountMicros: -10 }]);
    expect(await redis.exists(monetizationKeyNames(NAMESPACE).consumer(world.consumerId))).toBe(0);
  });
});

describe('background work', () => {
  it('drains on the leader only, and every node reports charges and reloads after a change', async () => {
    const { resetSharedStateWorkersForTests, runSharedStateDrainTick, runSharedStateNodeTick } = await import('../../ee/high-availability/shared-state/workers');
    const { setSharedStateLeaderCheck } = await import('../../ee/high-availability/shared-state/leader');
    const { publishMonetizationChange } = await import('../../ee/high-availability/shared-state/monetization-store');
    resetSharedStateWorkersForTests();
    const world = await seed({ price: 10, balance: 1_000 });
    const store = createRedisMonetizationStore(state);
    await store.decide(request(world));

    // A standby: reports the charge, never writes the ledger.
    setSharedStateLeaderCheck(() => false);
    try {
      await runSharedStateNodeTick(T0);
      expect(await redis.smembers(monetizationKeyNames(NAMESPACE).dirty)).toEqual([String(world.consumerId)]);
      await runSharedStateDrainTick(T0);
      expect(await ledger(world.consumerId)).toEqual([]);

      // Another node changes the price and announces it: this one reloads its copy.
      const consumer = await consumerRow(world.consumerId);
      await ctx.db.update(schema.monetizationPlans).set({ pricePerRequestMicros: 25 }).where(eq(schema.monetizationPlans.id, consumer.planId!));
      expect(await store.decide(request(world))).toMatchObject({ chargedMicros: 10 });
      await publishMonetizationChange(state);
      await runSharedStateNodeTick(T0 + 2_000);
      expect(await store.decide(request(world))).toMatchObject({ chargedMicros: 25 });
    } finally {
      setSharedStateLeaderCheck(null);
    }

    // The leader writes it back.
    await runSharedStateDrainTick(T0 + 5_000);
    expect((await ledger(world.consumerId)).filter((row) => row.type === 'usage')).toMatchObject([{ requests: 3, amountMicros: -45 }]);
    resetSharedStateWorkersForTests();
  });
});
