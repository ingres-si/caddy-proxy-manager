/**
 * Monetized hosts on sync replicas (ee/monetization/replica-*.ts): the master
 * sends them, with the gate's index and sealed key digests, only while it
 * serves them on replicas; a replica inserts them only behind its own gate,
 * and gates them with the master's balances, through allowances from the
 * master's gate over the authenticated sync channel or through the master's
 * shared state. Never ungated: without a usable mode the host stays off the
 * replica; an unreachable master or shared state refuses requests (503).
 *
 * The bound: however replicas and the master interleave requests, every
 * request a replica admits was reserved (charged) on the master first, so
 * the admitted total never passes the balance plus the overdraft, and once
 * the replicas report, the ledger holds exactly the requests admitted.
 *
 * Two test databases stand for the master and the replica, and two engine
 * states for their processes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from '../helpers/ioredis-mock';
import type Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import type { TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { setSettingRow } from '../helpers/config-fixture';
import { insertConsumer, insertKey, insertMonetizedHost, insertPlan, insertProxyHost } from '../helpers/monetization';

const ctx = vi.hoisted(() => {
  const { mkdirSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const dir = join(tmpdir(), `monetization-replica-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  process.env.L4_PORTS_DIR = dir;
  return { db: null as unknown as TestDb };
});

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  const { adminAccess } = await import('../../src/lib/permissions');
  return { ...actual, requireApiPermission: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer', access: adminAccess(1) }) };
});

import { createTestDb } from '../helpers/db';
import { encryptSecret } from '../../src/lib/secret';
import { applySyncPayload, buildSyncPayload, setSlaveMasterToken, type SyncPayload } from '../../src/lib/instance-sync';
import { syncPayloadValidationError } from '../../src/lib/instance-sync-validation';
import { decideGate, flushUsage, reloadMonetization, replicaMeta, resetMonetizationEngineForTests, type GateDecision } from '../../ee/monetization/engine';
import { handleGateRequest } from '../../ee/monetization/gate-response';
import { localBalanceStore } from '../../ee/monetization/balance-store';
import { ensureGateSecret } from '../../ee/monetization/settings';
import { loadMonetizationForCaddy } from '../../ee/monetization/caddy-config';
import { REPLICA_SETTING_KEY } from '../../ee/monetization/replica-index';
import {
  createAllowanceStore,
  deriveAllowanceCredential,
  grantAllowance,
  handleAllowanceHttp,
  LEASE_TTL_MS,
  MAX_LEASE_REQUESTS,
  MAX_NODES_PER_REPLICA,
  MAX_UNREPORTED_PER_CONSUMER,
  MAX_UNREPORTED_REQUESTS_PER_CONSUMER,
  parseAllowanceRequest,
  readAllowanceReply,
  resetAllowancesForTests,
  type AllowanceStore,
} from '../../ee/monetization/replica-allowance';
import { resetServedHostsForTests } from '../../ee/monetization/replica-hosts';
import { monetizationBalanceStore } from '../../ee/monetization/balance-store';
import { getMonetizationOptions, OPTIONS_SETTING_KEY, saveMonetizationOptions } from '../../ee/monetization/options';
import { adminAccess } from '../../src/lib/permissions';
import { replicaSectionError } from '../../ee/monetization/replica-index';
import * as settingsRoute from '../../app/api/v1/monetization/settings/route';
import { requireApiPermission } from '../../src/lib/api-auth';
import { NextRequest } from 'next/server';
import { resetReplicaStoreForTests } from '../../ee/monetization/replica-store';
import { setReplicaSharedRedisForTests, setSharedStateForTests } from '../../ee/high-availability/shared-state/connection';
import { createRedisMonetizationStore, seedSharedConsumers } from '../../ee/high-availability/shared-state/monetization-store';
import { drainSharedMonetization } from '../../ee/high-availability/shared-state/monetization-drain';
import { first } from '@/src/lib/db/ops';

type EngineGlobal = typeof globalThis & { __ingressiMonetization?: unknown };
const engines = globalThis as EngineGlobal;

const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);
const SYNC_TOKEN = 'f'.repeat(64);
/** What a replica presents at the allowance endpoint: derived from its sync token, never the token. */
const ALLOWANCE_CREDENTIAL = deriveAllowanceCredential(SYNC_TOKEN);
/** A node (process) of the replica, as it names itself. */
const NODE_A = 'node-a';
const GATE_URL = 'https://dash.example.com';
const NAMESPACE = 'ingressi:0a0b0c0d:';

let master: TestDb;
let replica: TestDb;
let masterEngine: unknown;
let replicaEngine: unknown;

type MasterWorld = { token: string; hostId: number; consumerId: number; key: string; keyId: number };

/** Runs `fn` as the master process (its database and engine), then switches back. */
async function onMaster<T>(fn: () => T | Promise<T>): Promise<T> {
  const saved = { db: ctx.db, engine: engines.__ingressiMonetization };
  ctx.db = master;
  engines.__ingressiMonetization = masterEngine;
  try {
    return await fn();
  } finally {
    masterEngine = engines.__ingressiMonetization;
    ctx.db = saved.db;
    engines.__ingressiMonetization = saved.engine;
  }
}

async function onReplica<T>(fn: () => T | Promise<T>): Promise<T> {
  const saved = { db: ctx.db, engine: engines.__ingressiMonetization };
  ctx.db = replica;
  engines.__ingressiMonetization = replicaEngine;
  try {
    return await fn();
  } finally {
    replicaEngine = engines.__ingressiMonetization;
    ctx.db = saved.db;
    engines.__ingressiMonetization = saved.engine;
  }
}

async function seedMaster(options: { price?: number; included?: number; balance?: number; overdraft?: number; perMinute?: number | null; mode?: string } = {}): Promise<MasterWorld> {
  return await onMaster(async () => {
    await setSettingRow(master, 'instance_mode', 'master');
    await setSettingRow(master, OPTIONS_SETTING_KEY, { replicas: { mode: options.mode ?? 'allowance', gateUrl: GATE_URL } });
    const t = new Date().toISOString();
    await master.insert(schema.instances).values({ name: 'Replica', baseUrl: 'https://replica.example.com', apiToken: encryptSecret(SYNC_TOKEN), syncMode: 'push', enabled: true, createdAt: t, updatedAt: t });
    const plan = await insertPlan(master, { pricePerRequestMicros: options.price ?? 1_000, includedRequestsPerMonth: options.included ?? 0, requestsPerMinute: options.perMinute ?? null });
    const consumer = await insertConsumer(master, { planId: plan.id, balanceMicros: options.balance ?? 10_000, overdraftAllowanceMicros: options.overdraft ?? 0 });
    const { raw, row } = await insertKey(master, consumer.id);
    const host = await insertProxyHost(master, { name: 'Paid API', domains: JSON.stringify(['paid.example.com']) });
    await insertMonetizedHost(master, host.id);
    await insertProxyHost(master, { name: 'Free site', domains: JSON.stringify(['free.example.com']) });
    const { token } = await ensureGateSecret();
    await reloadMonetization({ quiet: true });
    return { token, hostId: host.id, consumerId: consumer.id, key: raw, keyId: row.id };
  });
}

/** The master's payload, applied by the replica (as a push or a poll would). */
async function syncReplica(): Promise<SyncPayload> {
  const payload = await onMaster(() => buildSyncPayload());
  // What travels: JSON.
  const received = JSON.parse(JSON.stringify(payload)) as SyncPayload;
  expect(syncPayloadValidationError(received)).toBeNull();
  await onReplica(async () => {
    await setSettingRow(replica, 'instance_mode', 'slave');
    await setSlaveMasterToken(SYNC_TOKEN);
    await applySyncPayload(received);
  });
  return payload;
}

/** The replica's gate token, as its Caddy configuration gets it (which also tells the replica's gate). */
async function replicaGateToken(): Promise<string> {
  return await onReplica(async () => (await loadMonetizationForCaddy())!.gateToken);
}

function gateHeaders(token: string, world: MasterWorld): Headers {
  return new Headers({ 'X-Ingressi-Gate-Token': token, 'X-Ingressi-Host-Id': String(world.hostId), Authorization: `Bearer ${world.key}` });
}

async function masterConsumer(id: number) {
  return await onMaster(async () => (await first(master.select().from(schema.monetizationConsumers).where(eq(schema.monetizationConsumers.id, id)).limit(1)))!);
}

async function masterUsage(consumerId: number) {
  return await onMaster(async () => (await master.select().from(schema.monetizationLedger).where(eq(schema.monetizationLedger.consumerId, consumerId))).filter((row) => row.type === 'usage'));
}

/** What replicas sent to the gate URL (its Authorization header and body). */
const sentToGate: Array<{ authorization: string | null; body: Record<string, unknown> }> = [];

/** Requests from the replica process reach the master's allowance endpoint in-process. */
function routeAllowancesToMaster() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toBe(`${GATE_URL}/api/monetization/replica/allowance`);
      const request = new Request(url, init);
      sentToGate.push({ authorization: request.headers.get('authorization'), body: JSON.parse(String(init?.body ?? '{}')) });
      return await onMaster(() => handleAllowanceHttp(request));
    })
  );
}

beforeEach(async () => {
  master = createTestDb();
  replica = createTestDb();
  ctx.db = master;
  resetMonetizationEngineForTests();
  masterEngine = undefined;
  replicaEngine = undefined;
  resetReplicaStoreForTests();
  resetServedHostsForTests();
  await resetAllowancesForTests();
  sentToGate.length = 0;
  vi.spyOn(Date, 'now').mockReturnValue(T0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSharedStateForTests(undefined);
  setReplicaSharedRedisForTests(null);
  resetReplicaStoreForTests();
});

describe('the sync payload', () => {
  it('keeps monetized hosts out without replica serving, as before', async () => {
    const world = await seedMaster({ mode: 'off' });
    const payload = await onMaster(() => buildSyncPayload());
    expect(payload.settings.monetization_replica).toBeUndefined();
    expect(payload.data.proxyHosts.map((host) => host.id)).not.toContain(world.hostId);
    expect(payload.data.proxyHosts.map((host) => host.name)).toEqual(['Free site']);
  });

  it('keeps them out in shared mode while this master has no shared state', async () => {
    const world = await seedMaster({ mode: 'shared' });
    const payload = await onMaster(() => buildSyncPayload());
    expect(payload.settings.monetization_replica).toBeUndefined();
    expect(payload.data.proxyHosts.map((host) => host.id)).not.toContain(world.hostId);
  });

  it('sends the gate index without balances, the key digests as secrets, and the host only inside the section', async () => {
    const world = await seedMaster({ balance: 123_456 });
    const payload = await onMaster(() => buildSyncPayload());
    expect(payload.data.proxyHosts.map((host) => host.id)).not.toContain(world.hostId);
    const section = payload.settings.monetization_replica as Record<string, any>;
    expect(section).toMatchObject({ v: 1, mode: 'allowance', gateUrl: GATE_URL, namespace: null, currency: 'usd' });
    expect(section.hosts).toEqual([{ proxyHostId: world.hostId, keyHeader: 'Authorization', allowedPlanIds: [] }]);
    expect(section.proxyHosts.map((host: { id: number }) => host.id)).toEqual([world.hostId]);
    expect(JSON.stringify(section.consumers)).not.toContain('123456');
    // The digest travels in clear only inside the payload, listed for sealing; the stored row never leaves.
    expect(section.keys[0]).toMatchObject({ id: world.keyId, consumerId: world.consumerId, prefix: world.key.slice(0, 15) });
    expect(section.keys[0].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.settings_secret_paths).toContainEqual([REPLICA_SETTING_KEY, 'keys', 0, 'hash']);
  });
});

describe('a replica serving a monetized host with allowances', () => {
  it('inserts the host behind its own gate and charges the master\'s balance over the sync channel', async () => {
    const world = await seedMaster({ price: 1_000, balance: 3_000 });
    await syncReplica();
    routeAllowancesToMaster();
    const replicaToken = await onReplica(async () => {
      expect((await replica.select().from(schema.proxyHosts)).map((host) => host.name).sort()).toEqual(['Free site', 'Paid API']);
      // The key digest is stored encrypted on the replica.
      const stored = (await first(replica.select().from(schema.settings).where(eq(schema.settings.key, `synced:${REPLICA_SETTING_KEY}`)).limit(1)))!;
      expect(stored.value).toContain('"prefix"');
      expect(stored.value).not.toMatch(/"hash":"[a-f0-9]{64}"/);
      await reloadMonetization({ quiet: true });
      expect(replicaMeta()).toEqual({ mode: 'allowance', namespace: null, gateUrl: GATE_URL });
      const caddy = await loadMonetizationForCaddy();
      expect(caddy?.hostIds.has(world.hostId)).toBe(true);
      return caddy!.gateToken;
    });
    expect(replicaToken).not.toBe(world.token);

    const results: number[] = [];
    for (let i = 0; i < 4; i++) results.push((await onReplica(() => handleGateRequest(gateHeaders(replicaToken, world), T0))).status);
    expect(results).toEqual([200, 200, 200, 402]);
    // The master's own gate sees the reservation at once.
    expect(await onMaster(() => decideGate({ gateToken: world.token, hostId: String(world.hostId), header: (name) => (name === 'authorization' ? `Bearer ${world.key}` : null), now: T0 }))).toMatchObject({ status: 402 });
    const body = await (await onReplica(() => handleGateRequest(gateHeaders(replicaToken, world), T0))).json();
    expect(body).toMatchObject({ error: 'payment_required', topUpUrl: expect.stringContaining('/api-portal') });
    await onMaster(() => flushUsage(T0));
    expect((await masterConsumer(world.consumerId)).balanceMicros).toBe(0);
    // The master's gate token is refused on the replica: only Caddy there has the replica's.
    expect((await onReplica(() => handleGateRequest(gateHeaders(world.token, world), T0))).status).toBe(403);
  });

  it('refuses requests (503) when the master cannot be reached, or refuses the replica\'s credential', async () => {
    const world = await seedMaster();
    await syncReplica();
    const replicaToken = await replicaGateToken();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect((await onReplica(() => handleGateRequest(gateHeaders(replicaToken, world), T0))).status).toBe(503);
    resetReplicaStoreForTests();
    await onMaster(() => master.delete(schema.instances));
    routeAllowancesToMaster();
    expect((await onReplica(() => handleGateRequest(gateHeaders(replicaToken, world), T0))).status).toBe(503);
  });

  it('answers unauthenticated and malformed allowance requests without granting anything', async () => {
    const world = await seedMaster();
    const post = (authorization: string | null, body: unknown) =>
      onMaster(() =>
        handleAllowanceHttp(
          new Request(`${GATE_URL}/api/monetization/replica/allowance`, {
            method: 'POST',
            headers: authorization ? { authorization } : {},
            body: JSON.stringify(body),
          })
        )
      );
    const valid = { v: 1, hostId: world.hostId, key: world.key, want: 5, node: NODE_A };
    expect((await post(null, valid)).status).toBe(401);
    expect((await post(`Bearer ${deriveAllowanceCredential('0'.repeat(64))}`, valid)).status).toBe(401);
    expect((await post(`Bearer pull_${'A'.repeat(43)}`, valid)).status).toBe(401);
    // The sync token itself opens nothing here: it is only ever sent to the slave's own sync endpoint.
    expect((await post(`Bearer ${SYNC_TOKEN}`, valid)).status).toBe(401);
    expect((await post(`Bearer ${ALLOWANCE_CREDENTIAL}`, { ...valid, v: 9 })).status).toBe(400);
    // Naming a consumer and key by id, without the key the client presented, is not a request.
    expect((await post(`Bearer ${ALLOWANCE_CREDENTIAL}`, { v: 1, hostId: world.hostId, consumerId: world.consumerId, keyId: world.keyId, want: 5 })).status).toBe(400);
    const granted = await (await post(`Bearer ${ALLOWANCE_CREDENTIAL}`, valid)).json();
    expect(granted.lease).toMatchObject({ granted: 5, free: 0, priceMicros: 1_000, ttlMs: LEASE_TTL_MS });
    // A key the master does not know, an unknown host: refused like at the gate.
    expect((await (await post(`Bearer ${ALLOWANCE_CREDENTIAL}`, { ...valid, key: `${world.key.slice(0, 15)}${'0'.repeat(32)}` })).json()).denied).toMatchObject({ status: 401 });
    expect((await (await post(`Bearer ${ALLOWANCE_CREDENTIAL}`, { ...valid, hostId: world.hostId + 99 })).json()).denied).toMatchObject({ status: 403 });
  });

  it('sends the master an allowance credential derived from the sync token, never the token, and the key the client presented', async () => {
    const world = await seedMaster();
    await syncReplica();
    routeAllowancesToMaster();
    const replicaToken = await replicaGateToken();
    expect((await onReplica(() => handleGateRequest(gateHeaders(replicaToken, world), T0))).status).toBe(200);
    expect(sentToGate.length).toBeGreaterThan(0);
    for (const sent of sentToGate) {
      expect(sent.authorization).toBe(`Bearer ${ALLOWANCE_CREDENTIAL}`);
      expect(sent.authorization).not.toContain(SYNC_TOKEN);
    }
    expect(sentToGate[0].body).toMatchObject({ v: 1, hostId: world.hostId, key: world.key });
    expect(sentToGate[0].body).not.toHaveProperty('consumerId');
  });

  it('never sends the credential to a plain HTTP gate URL (unless sync over HTTP is allowed)', async () => {
    // The master refuses to serve allowances behind an http gate URL, set or by BASE_URL.
    await onMaster(async () => {
      await setSettingRow(master, 'instance_mode', 'master');
      await expect(saveMonetizationOptions({ replicas: { mode: 'allowance', gateUrl: 'http://dash.example.com' } }, 1, adminAccess(1))).rejects.toThrow(/https/);
    });
    const checks = { isProxyHost: () => true, isWafRuleExclusion: () => true, proxyHostContentError: () => null };
    const section = { v: 1, mode: 'allowance', namespace: null, gateUrl: 'http://dash.example.com', currency: 'usd', topUpUrl: '/api-portal', hosts: [], plans: [], consumers: [], keys: [], proxyHosts: [], wafRuleExclusions: [] };
    expect(replicaSectionError(section, checks)).toMatch(/https/);
    expect(replicaSectionError(section, { ...checks, allowHttpGate: true })).toBeNull();
    expect(replicaSectionError({ ...section, gateUrl: 'https://dash.example.com' }, checks)).toBeNull();
    // A replica holding such a URL (stored before) refuses requests instead of sending anything there.
    const world = await seedMaster();
    await syncReplica();
    const replicaToken = await replicaGateToken();
    await onReplica(async () => {
      const key = `synced:${REPLICA_SETTING_KEY}`;
      const stored = (await first(replica.select().from(schema.settings).where(eq(schema.settings.key, key)).limit(1)))!;
      await replica.update(schema.settings).set({ value: stored.value.replace(GATE_URL, 'http://dash.example.com') }).where(eq(schema.settings.key, key));
      await reloadMonetization({ quiet: true });
    });
    resetReplicaStoreForTests();
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    expect((await onReplica(() => handleGateRequest(gateHeaders(replicaToken, world), T0))).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('needs instances:write as well to change how replicas serve monetized hosts', async () => {
    await seedMaster();
    const put = (body: unknown) =>
      onMaster(() => settingsRoute.PUT(new NextRequest('http://localhost/api/v1/monetization/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })));
    // A custom role with monetization:write but not instances:write.
    const access = { ...adminAccess(2), role: 'viewer', isAdmin: false, permissions: new Set(['monetization:read', 'monetization:write'] as const) };
    vi.mocked(requireApiPermission).mockResolvedValue({ userId: 2, role: 'viewer', authMethod: 'bearer', access } as never);
    for (const body of [{ replicas: { mode: 'off' } }, { replicas: { mode: 'allowance', gateUrl: 'https://attacker.example.net' } }]) {
      const response = await put(body);
      expect(response.status).toBe(403);
      expect((await response.json()).error).toContain('instances:write');
    }
    expect(await onMaster(async () => (await getMonetizationOptions()).replicaGateUrl)).toBe(GATE_URL);
    // Retention alone needs only monetization:write.
    expect((await put({ usageRetentionMonths: 12 })).status).toBe(200);
    vi.mocked(requireApiPermission).mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer', access: adminAccess(1) } as never);
    expect((await put({ replicas: { mode: 'off' } })).status).toBe(200);
  });

  it('grants nothing while this master does not serve replicas with allowances', async () => {
    const world = await seedMaster({ mode: 'off' });
    const request = { kind: 'lease' as const, hostId: world.hostId, key: world.key, want: 5, node: NODE_A, reports: [] };
    expect(await onMaster(() => grantAllowance(1, request, T0))).toEqual({ denied: { allow: false, status: 503, error: 'unavailable' } });
    await onMaster(() => setSettingRow(master, OPTIONS_SETTING_KEY, { replicas: { mode: 'shared' } }));
    expect(await onMaster(() => grantAllowance(1, request, T0))).toEqual({ denied: { allow: false, status: 503, error: 'unavailable' } });
    await onMaster(() => flushUsage(T0));
    expect((await masterConsumer(world.consumerId)).balanceMicros).toBe(10_000);
  });

  it('grants only for hosts the replica was sent: a promotion-only environment serves its revisions\' hosts', async () => {
    const world = await seedMaster();
    const request = { kind: 'lease' as const, hostId: world.hostId, key: world.key, want: 1, node: NODE_A, reports: [] };
    const replicaId = await onMaster(async () => {
      const t = new Date().toISOString();
      const instance = (await first(master.select().from(schema.instances).limit(1)))!;
      const [environment] = await master.insert(schema.fleetEnvironments).values({ name: 'Production', position: 1, promotionOnly: true, createdAt: t, updatedAt: t }).returning();
      await master.insert(schema.fleetInstances).values({ instanceId: instance.id, environmentId: environment.id, revisionId: null, updatedAt: t });
      return instance.id;
    });
    // No revision yet: it serves no monetized host, so it may reserve nothing.
    expect(await onMaster(() => grantAllowance(replicaId, request, T0))).toEqual({ denied: { allow: false, status: 403, error: 'host_not_monetized' } });
    // A replica outside any environment gets the live configuration.
    expect('lease' in (await onMaster(() => grantAllowance(replicaId + 1, request, T0)))).toBe(true);
  });

  it('caps the allowances a replica holds unreported per consumer', async () => {
    const world = await seedMaster({ balance: 1_000_000 });
    const lease = { kind: 'lease' as const, hostId: world.hostId, key: world.key, want: 1, node: NODE_A, reports: [] };
    const ids: string[] = [];
    for (let i = 0; i < MAX_UNREPORTED_PER_CONSUMER; i++) {
      const reply = await onMaster(() => grantAllowance(1, lease, T0));
      if (!('lease' in reply)) throw new Error('expected a lease');
      ids.push(reply.lease.id);
    }
    expect(await onMaster(() => grantAllowance(1, lease, T0))).toMatchObject({ denied: { status: 429, error: 'rate_limited' } });
    // Another replica has its own count; a report frees a place.
    expect('lease' in (await onMaster(() => grantAllowance(2, lease, T0)))).toBe(true);
    expect('lease' in (await onMaster(() => grantAllowance(1, { ...lease, reports: [{ leaseId: ids[0], used: 1 }] }, T0)))).toBe(true);
    // Places of allowances never reported come back once the master forgets them.
    expect('lease' in (await onMaster(() => grantAllowance(1, lease, T0 + LEASE_TTL_MS + 6 * 60_000)))).toBe(true);
  });

  it('gives each node of a replica its own share, and bounds what a replica can hold unreported per consumer', async () => {
    const world = await seedMaster({ balance: 100_000_000 });
    const lease = (node: string) => ({ kind: 'lease' as const, hostId: world.hostId, key: world.key, want: MAX_LEASE_REQUESTS, node, reports: [] });
    // A replica run on six nodes (more than the old per-replica count of 4 per consumer): every node is served.
    for (let n = 0; n < 6; n++) {
      for (let i = 0; i < MAX_UNREPORTED_PER_CONSUMER; i++) expect('lease' in (await onMaster(() => grantAllowance(1, lease(`node-${n}`), T0))), `node ${n}`).toBe(true);
      expect(await onMaster(() => grantAllowance(1, lease(`node-${n}`), T0))).toMatchObject({ denied: { status: 429 } });
    }
    // A compromised replica inventing node names: at most MAX_NODES_PER_REPLICA of them at once.
    for (let n = 6; n < MAX_NODES_PER_REPLICA; n++) {
      for (let i = 0; i < MAX_UNREPORTED_PER_CONSUMER; i++) expect('lease' in (await onMaster(() => grantAllowance(1, lease(`node-${n}`), T0)))).toBe(true);
    }
    expect(await onMaster(() => grantAllowance(1, lease('one-more-node'), T0))).toMatchObject({ denied: { status: 429 } });
    // The bound holds: what one replica holds unreported for one consumer never passes it.
    await onMaster(() => flushUsage(T0));
    const charged = 100_000_000 - (await masterConsumer(world.consumerId)).balanceMicros;
    expect(charged).toBe(MAX_UNREPORTED_REQUESTS_PER_CONSUMER * 1_000);
    expect(MAX_UNREPORTED_REQUESTS_PER_CONSUMER).toBe(3_200);
    // Another replica has its own nodes.
    expect('lease' in (await onMaster(() => grantAllowance(2, lease('node-0'), T0)))).toBe(true);
  });

  it('limits failed authentications per client address before looking at any credential', async () => {
    const world = await seedMaster();
    const post = (authorization: string, address: string) =>
      onMaster(() =>
        handleAllowanceHttp(
          new Request(`${GATE_URL}/api/monetization/replica/allowance`, {
            method: 'POST',
            headers: { authorization, 'x-forwarded-for': address },
            body: JSON.stringify({ v: 1, hostId: world.hostId, key: world.key, want: 1, node: NODE_A }),
          })
        )
      );
    const wrong = `Bearer ${deriveAllowanceCredential('1'.repeat(64))}`;
    for (let i = 0; i < 30; i++) expect((await post(wrong, '192.0.2.50')).status).toBe(401);
    // Blocked now, even with the right credential, from that address only.
    expect((await post(`Bearer ${ALLOWANCE_CREDENTIAL}`, '192.0.2.50')).status).toBe(429);
    expect((await post(`Bearer ${ALLOWANCE_CREDENTIAL}`, '192.0.2.51')).status).toBe(200);
  });
});

describe('the bound', () => {
  /** A deterministic pseudo-random sequence. */
  function prng(seed: number): () => number {
    let x = seed;
    return () => {
      x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
      return x / 2_147_483_648;
    };
  }

  it('replicas and the master together never admit more than the balance plus the overdraft, and the ledger ends exact', async () => {
    const PRICE = 1_000;
    const world = await seedMaster({ price: PRICE, included: 3, balance: 20_000, overdraft: 5_000 });
    await syncReplica();
    const replicaToken = await replicaGateToken();
    let clock = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const transportFor = (instanceId: number) => async (body: unknown) =>
      readAllowanceReply(
        JSON.parse(
          JSON.stringify(
            await onMaster(async () => {
              const parsed = parseAllowanceRequest(JSON.parse(JSON.stringify(body)));
              if (!parsed) throw new Error('bad request');
              return grantAllowance(instanceId, parsed, T0);
            })
          )
        )
      );
    const replicas: AllowanceStore[] = [1, 2, 3].map((id) => createAllowanceStore(transportFor(id), localBalanceStore));
    const random = prng(42);
    let admitted = 0;
    let admittedFree = 0;
    let admittedCharged = 0;
    for (let i = 0; i < 300; i++) {
      const actor = Math.floor(random() * 4);
      let decision: GateDecision;
      if (actor === 3) {
        decision = await onMaster(() => decideGate({ gateToken: world.token, hostId: String(world.hostId), header: (name) => (name === 'authorization' ? `Bearer ${world.key}` : null), now: T0 }));
      } else {
        decision = await onReplica(() =>
          replicas[actor].decide({ gateToken: replicaToken, hostId: String(world.hostId), header: (name) => (name === 'authorization' ? `Bearer ${world.key}` : null), now: T0 })
        );
      }
      if (decision.allow) {
        admitted += 1;
        if (decision.free) admittedFree += 1;
        else admittedCharged += decision.chargedMicros;
      }
      // Never more than 3 free requests and the balance plus the overdraft, at any moment.
      expect(admittedFree).toBeLessThanOrEqual(3);
      expect(admittedCharged).toBeLessThanOrEqual(25_000);
      if (random() < 0.05) clock += LEASE_TTL_MS + 1; // allowances expire now and then
    }
    expect(admitted).toBeLessThanOrEqual(28);
    // Not vacuous: the replicas did serve, and most of what could be served was.
    expect(admitted).toBeGreaterThanOrEqual(20);
    expect(admittedFree).toBe(3);

    // The replicas report what they used; what they did not use goes back.
    clock += LEASE_TTL_MS + 1;
    for (const store of replicas) await onReplica(() => store.reportExpired());
    await onMaster(() => flushUsage(T0));
    const consumer = await masterConsumer(world.consumerId);
    expect(consumer.balanceMicros).toBe(20_000 - admittedCharged);
    const usage = await masterUsage(world.consumerId);
    expect(usage.reduce((sum, row) => sum + row.requests, 0)).toBe(admitted);
    expect(usage.reduce((sum, row) => sum + row.freeRequests, 0)).toBe(admittedFree);
    expect(-usage.reduce((sum, row) => sum + row.amountMicros, 0)).toBe(admittedCharged);
    // A report repeated or for another replica's allowance gives nothing back twice.
    await onMaster(() => flushUsage(T0));
    expect((await masterConsumer(world.consumerId)).balanceMicros).toBe(20_000 - admittedCharged);
  });

  it('an allowance is used only until it expires, and only by the replica it was granted to', async () => {
    const world = await seedMaster({ price: 1_000, balance: 100_000 });
    await syncReplica();
    const replicaToken = await replicaGateToken();
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const grants: number[] = [];
    const leaseIds: string[] = [];
    const transport = async (body: unknown) => {
      const reply = await onMaster(async () => grantAllowance(1, parseAllowanceRequest(JSON.parse(JSON.stringify(body)))!, T0));
      if ('lease' in reply) {
        grants.push(reply.lease.granted);
        leaseIds.push(reply.lease.id);
      }
      return readAllowanceReply(JSON.parse(JSON.stringify(reply)));
    };
    const store = createAllowanceStore(transport, localBalanceStore);
    const request = { gateToken: replicaToken, hostId: String(world.hostId), header: (name: string) => (name === 'authorization' ? `Bearer ${world.key}` : null), now: T0 };
    await onReplica(() => store.decide(request));
    await onReplica(() => store.decide(request));
    expect(grants).toEqual([50]);
    clock += LEASE_TTL_MS;
    await onReplica(() => store.decide(request));
    expect(grants).toEqual([50, 50]);
    // The first allowance's report (2 used) gave 48 back; the second one is reserved in full until reported.
    await onMaster(() => flushUsage(T0));
    expect((await masterConsumer(world.consumerId)).balanceMicros).toBe(100_000 - 2_000 - 50_000);
    // Another replica cannot report this replica's allowance (nor make it unreportable).
    expect(await onMaster(() => grantAllowance(2, { kind: 'report', reports: [{ leaseId: leaseIds[1], used: 0 }] }, T0))).toEqual({ reported: 1 });
    await onMaster(() => flushUsage(T0));
    expect((await masterConsumer(world.consumerId)).balanceMicros).toBe(100_000 - 2_000 - 50_000);
    clock += LEASE_TTL_MS;
    expect(await onReplica(() => store.reportExpired())).toBe(1);
    await onMaster(() => flushUsage(T0));
    expect((await masterConsumer(world.consumerId)).balanceMicros).toBe(100_000 - 3_000);
  });
});

describe('a report that comes after the month changed', () => {
  // Granted ten seconds before the month ends, reported twenty seconds into the next one.
  const OCTOBER_END = Date.UTC(2026, 9, 31, 23, 59, 50);
  const NOVEMBER = Date.UTC(2026, 10, 1, 0, 0, 20);

  async function run(decide: (world: MasterWorld, now: number) => Promise<GateDecision>) {
    const world = await seedMaster({ price: 1_000, included: 3, balance: 100_000 });
    vi.spyOn(Date, 'now').mockReturnValue(OCTOBER_END);
    const reply = await onMaster(() => grantAllowance(1, { kind: 'lease', hostId: world.hostId, key: world.key, want: 5, node: NODE_A, reports: [] }, OCTOBER_END));
    if (!('lease' in reply)) throw new Error('expected a lease');
    expect(reply.lease).toMatchObject({ granted: 5, free: 3 });
    vi.spyOn(Date, 'now').mockReturnValue(NOVEMBER);
    const before = [await decide(world, NOVEMBER), await decide(world, NOVEMBER)];
    // October's allowance, reported now: none of it was used.
    await onMaster(() => grantAllowance(1, { kind: 'report', reports: [{ leaseId: reply.lease.id, used: 0 }] }, NOVEMBER));
    const after = [await decide(world, NOVEMBER), await decide(world, NOVEMBER)];
    return { world, decisions: [...before, ...after].map((decision) => (decision.allow ? (decision.free ? 'free' : 'charged') : 'refused')) };
  }

  it('gives the money back and leaves this month\'s free requests alone', async () => {
    const { world, decisions } = await run((current, now) =>
      onMaster(() => decideGate({ gateToken: current.token, hostId: String(current.hostId), header: (name) => (name === 'authorization' ? `Bearer ${current.key}` : null), now }))
    );
    // Three free requests in November, then charged: never three more because October's were given back.
    expect(decisions).toEqual(['free', 'free', 'free', 'charged']);
    await onMaster(() => flushUsage(NOVEMBER));
    const consumer = await masterConsumer(world.consumerId);
    expect(consumer).toMatchObject({ balanceMicros: 100_000 - 1_000, freeUsageMonth: '2026-11', freeUsageCount: 3 });
  });

  it('does the same through shared state', async () => {
    const redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    const state = { redis, namespace: NAMESPACE };
    setSharedStateForTests(state);
    const store = createRedisMonetizationStore(state);
    const { decisions } = await run((current, now) =>
      onMaster(() => store.decide({ gateToken: current.token, hostId: String(current.hostId), header: (name) => (name === 'authorization' ? `Bearer ${current.key}` : null), now }))
    );
    expect(decisions).toEqual(['free', 'free', 'free', 'charged']);
    expect(await onMaster(async () => (await monetizationBalanceStore()).backend)).toBe('redis');
  });
});

describe('a replica serving a monetized host through shared state', () => {
  it('charges the master\'s shared balances, never seeds one, and the master\'s leader seeds for it', async () => {
    const redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    const state = { redis, namespace: NAMESPACE };
    setSharedStateForTests(state);
    setReplicaSharedRedisForTests(redis);
    const world = await seedMaster({ mode: 'shared', price: 1_000, balance: 3_000 });
    const payload = await syncReplica();
    expect(payload.settings.monetization_replica).toMatchObject({ mode: 'shared', namespace: NAMESPACE, gateUrl: null });
    const replicaToken = await replicaGateToken();
    expect(await onReplica(() => replicaMeta())).toMatchObject({ mode: 'shared', namespace: NAMESPACE });
    // No hash yet: the replica refuses rather than invent a balance.
    expect((await onReplica(() => handleGateRequest(gateHeaders(replicaToken, world), T0))).status).toBe(503);
    expect(await onMaster(() => seedSharedConsumers(state, [world.consumerId]))).toBe(1);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await onReplica(() => handleGateRequest(gateHeaders(replicaToken, world), T0))).status);
    expect(statuses).toEqual([200, 200, 200, 402]);
    // The master's nodes see the same balance.
    const masterStore = createRedisMonetizationStore(state);
    expect(await onMaster(() => masterStore.decide({ gateToken: world.token, hostId: String(world.hostId), header: (name) => (name === 'authorization' ? `Bearer ${world.key}` : null), now: T0 }))).toMatchObject({ status: 402 });
    await onMaster(() => drainSharedMonetization(state, { all: true, now: new Date(T0) }));
    expect((await masterConsumer(world.consumerId)).balanceMicros).toBe(0);
    expect((await masterUsage(world.consumerId)).reduce((sum, row) => sum + row.requests, 0)).toBe(3);
  });
});
