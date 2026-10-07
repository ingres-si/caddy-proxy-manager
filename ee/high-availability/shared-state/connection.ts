// SPDX-License-Identifier: Elastic-2.0
/**
 * The connection to the shared state: the Redis or Valkey server configured
 * for certificate storage (phase 1), used by this web container with a key
 * namespace of its own. One client per process, rebuilt when the settings
 * change.
 *
 * Resolution is cached for a few seconds, so request paths read the settings
 * at most once per CONFIG_TTL_MS; saving the setting here invalidates it at
 * once, and with several replicas on one PostgreSQL database it is announced
 * on the invalidation bus (src/lib/db/events.ts, channel "shared-state") so
 * the other replicas forget theirs too. When shared state is on but cannot be used (no Redis settings, a
 * password this container cannot read), getSharedState() throws
 * SharedStateUnavailableError: request paths then fail closed rather than
 * fall back to state only this node has.
 *
 * Secrets: a stored password is decrypted in memory for the client. A
 * password named as an environment variable (CADDY_STORAGE_*) is read from
 * this web container's environment, so it must be set on the web containers
 * too, not only on the Caddy nodes.
 */
import { isIP } from "node:net";
import Redis, { Cluster, type ClusterOptions, type RedisOptions } from "ioredis";
import type { ConnectionOptions } from "node:tls";
import { eq } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { settings as settingsTable } from "@/src/lib/db/schema";
import { getEffectiveSetting } from "@/src/lib/settings";
import { decryptSecret } from "@/src/lib/secret";
import { parseStoredCertificateStorage, STORAGE_SECRET_ENV_FIELDS } from "../settings";
import { CERTIFICATE_STORAGE_SETTING_KEY, type StorageSecretField, type StoredRedisStorage } from "../types";
import { parseStoredSharedState, sharedStateNamespace } from "./settings";
import { SHARED_STATE_SETTING_KEY, type StoredSharedState } from "./types";
import { first } from "@/src/lib/db/ops";
import { outsideTransaction } from "@/src/lib/db/executor";
import { publish, subscribe } from "@/src/lib/db/events";

/** How long a resolved configuration is reused before the settings are read again. */
export const CONFIG_TTL_MS = 3_000;
const CONNECT_TIMEOUT_MS = 5_000;
/** Request paths wait at most this long for one command. */
const COMMAND_TIMEOUT_MS = 2_000;

export type SharedRedis = Redis | Cluster;

export type SharedState = {
  redis: SharedRedis;
  /** `<keyPrefix>:<generation>:`: every key starts with it. */
  namespace: string;
};

/** Shared state is on but cannot be used; the message is safe to show. */
export class SharedStateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedStateUnavailableError";
  }
}

export type ResolvedSharedState =
  | { status: "off"; setting: StoredSharedState | null }
  | { status: "error"; setting: StoredSharedState; message: string }
  | { status: "on"; setting: StoredSharedState; redis: StoredRedisStorage; namespace: string };

type ClientFactory = (redis: StoredRedisStorage) => SharedRedis;

type Cache = {
  resolved: ResolvedSharedState | null;
  resolvedAt: number;
  pending: Promise<ResolvedSharedState> | null;
  client: { fingerprint: string; redis: SharedRedis } | null;
  override: SharedState | null | undefined;
  factory: ClientFactory | null;
  /** A sync replica's client for its master's shared state (getReplicaSharedState). */
  replicaClient?: { fingerprint: string; redis: SharedRedis } | null;
  replicaOverride?: SharedRedis | null;
};

const store = globalThis as typeof globalThis & { __ingressiSharedState?: Cache };
function cache(): Cache {
  return (store.__ingressiSharedState ??= { resolved: null, resolvedAt: 0, pending: null, client: null, override: undefined, factory: null });
}

/** This instance's own switch (never the synced value: the setting does not sync). */
export async function readStoredSharedState(): Promise<StoredSharedState | null> {
  const row = await first(appDb.select({ value: settingsTable.value }).from(settingsTable).where(eq(settingsTable.key, SHARED_STATE_SETTING_KEY)).limit(1));
  if (!row) return null;
  try {
    return parseStoredSharedState(JSON.parse(row.value));
  } catch {
    return null;
  }
}

async function resolveNow(): Promise<ResolvedSharedState> {
  const setting = await readStoredSharedState();
  if (!setting?.enabled) return { status: "off", setting };
  let redis: StoredRedisStorage | null;
  try {
    redis = parseStoredCertificateStorage(await getEffectiveSetting<unknown>(CERTIFICATE_STORAGE_SETTING_KEY))?.redis ?? null;
  } catch {
    return { status: "error", setting, message: "The certificate storage setting is not valid; save it again" };
  }
  if (!redis) {
    return { status: "error", setting, message: "Shared state uses the Redis or Valkey settings of the certificate storage; configure them first" };
  }
  return { status: "on", setting, redis, namespace: sharedStateNamespace(setting) };
}

/** The configuration in effect (cached for CONFIG_TTL_MS). */
export async function resolveSharedState(now: number = Date.now()): Promise<ResolvedSharedState> {
  const c = cache();
  if (c.override !== undefined) {
    return c.override
      ? { status: "on", setting: TEST_SETTING, redis: TEST_REDIS, namespace: c.override.namespace }
      : { status: "off", setting: null };
  }
  if (c.resolved && now - c.resolvedAt < CONFIG_TTL_MS) return c.resolved;
  c.pending ??= resolveNow().finally(() => {
    c.pending = null;
  });
  const resolved = await c.pending;
  c.resolved = resolved;
  c.resolvedAt = Date.now();
  return resolved;
}

const SHARED_STATE_CHANNEL = "shared-state";

function forgetResolved(): void {
  const c = cache();
  c.resolved = null;
  c.resolvedAt = 0;
}

/**
 * Forgets the cached configuration (after the setting or the certificate
 * storage changed here); the other replicas forget theirs too.
 */
export function invalidateSharedState(): void {
  forgetResolved();
  void outsideTransaction(() => publish(SHARED_STATE_CHANNEL));
}

// One subscription per process, whichever copy of this module loads first.
const busStore = globalThis as typeof globalThis & { __ingressiSharedStateBus?: boolean };
if (!busStore.__ingressiSharedStateBus) {
  busStore.__ingressiSharedStateBus = true;
  subscribe(SHARED_STATE_CHANNEL, (event) => {
    if (event.kind === "message" && event.self) return;
    forgetResolved();
  });
}

function splitAddress(address: string): { host: string; port: number } {
  const colon = address.lastIndexOf(":");
  return { host: address.slice(0, colon).replace(/^\[|\]$/g, ""), port: Number(address.slice(colon + 1)) };
}

function readSecret(redis: StoredRedisStorage, field: StorageSecretField): string | undefined {
  const env = redis[STORAGE_SECRET_ENV_FIELDS[field]];
  if (env) {
    const value = process.env[env];
    if (!value) throw new SharedStateUnavailableError(`${env} is not set in this web container's environment`);
    return value;
  }
  const stored = redis[field];
  if (!stored) return undefined;
  try {
    return decryptSecret(stored, "shared state connection");
  } catch {
    throw new SharedStateUnavailableError("The stored Redis or Valkey password cannot be decrypted with this instance's SESSION_SECRET");
  }
}

function tlsOptions(redis: StoredRedisStorage): ConnectionOptions | undefined {
  if (!redis.tls.enabled) return undefined;
  return {
    rejectUnauthorized: !redis.tls.insecureSkipVerify,
    minVersion: "TLSv1.2",
    ...(redis.tls.caPem ? { ca: [redis.tls.caPem] } : {}),
  };
}

/** The ioredis client for these settings (not connected yet). */
export function createSharedRedisClient(redis: StoredRedisStorage): SharedRedis {
  const factory = cache().factory;
  return factory ? factory(redis) : buildIoredisClient(redis);
}

function buildIoredisClient(redis: StoredRedisStorage): SharedRedis {
  const password = readSecret(redis, "password");
  const tls = tlsOptions(redis);
  const common: RedisOptions = {
    username: redis.username,
    password,
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    enableAutoPipelining: true,
    lazyConnect: true,
    connectionName: "ingressi-web",
    // RESP2, as before ioredis 6: servers without HELLO (Redis < 6) keep
    // working, and script and hash replies keep the shapes the stores read.
    protocol: 2,
    ...(tls ? { tls } : {}),
  };
  const retryStrategy = (times: number) => Math.min(250 * times, 5_000);
  let client: SharedRedis;
  if (redis.mode === "cluster") {
    const options: ClusterOptions = {
      redisOptions: common,
      enableAutoPipelining: true,
      lazyConnect: true,
      slotsRefreshTimeout: CONNECT_TIMEOUT_MS,
      clusterRetryStrategy: retryStrategy,
    };
    client = new Cluster(redis.addresses.map(splitAddress), options);
  } else if (redis.mode === "sentinel") {
    client = new Redis({
      ...common,
      db: redis.db,
      sentinels: redis.addresses.map(splitAddress),
      name: redis.masterName,
      sentinelPassword: readSecret(redis, "sentinelPassword"),
      ...(tls ? { enableTLSForSentinelMode: true, sentinelTLS: tls } : {}),
      retryStrategy,
    });
  } else {
    const { host, port } = splitAddress(redis.addresses[0]);
    client = new Redis({
      ...common,
      host,
      port,
      db: redis.db,
      retryStrategy,
      ...(tls && !isIP(host) ? { tls: { ...tls, servername: host } } : {}),
    });
  }
  let lastLogged = 0;
  client.on("error", (error: unknown) => {
    // ioredis reports every failed reconnect; one line a minute is enough.
    const now = Date.now();
    if (now - lastLogged < 60_000) return;
    lastLogged = now;
    const code = (error as { code?: unknown } | null)?.code;
    console.error(`[shared-state] Redis/Valkey connection error${typeof code === "string" ? ` (${code})` : ""}`);
  });
  return client;
}

function fingerprintOf(redis: StoredRedisStorage): string {
  return JSON.stringify(redis);
}

/**
 * The shared state in effect: null when it is off (request paths use this
 * node's own storage), the client and namespace when on.
 * SharedStateUnavailableError when on but unusable.
 */
export async function getSharedState(): Promise<SharedState | null> {
  const c = cache();
  if (c.override !== undefined) return c.override;
  const resolved = await resolveSharedState();
  if (resolved.status === "off") {
    closeClient(c);
    return null;
  }
  if (resolved.status === "error") throw new SharedStateUnavailableError(resolved.message);
  const fingerprint = fingerprintOf(resolved.redis);
  if (!c.client || c.client.fingerprint !== fingerprint) {
    closeClient(c);
    c.client = { fingerprint, redis: createSharedRedisClient(resolved.redis) };
  }
  return { redis: c.client.redis, namespace: resolved.namespace };
}

/**
 * A sync replica's connection to its master's shared state, for API
 * monetization (ee/monetization/replica-store.ts): the Redis or Valkey
 * settings of this instance's certificate storage (synced from the master)
 * and the master's namespace, sent with the configuration. Independent of
 * this instance's own shared state switch. SharedStateUnavailableError when
 * no Redis settings are usable here.
 */
export async function getReplicaSharedState(namespace: string): Promise<SharedState> {
  const c = cache();
  if (c.replicaOverride) return { redis: c.replicaOverride, namespace };
  let redis: StoredRedisStorage | null;
  try {
    redis = parseStoredCertificateStorage(await getEffectiveSetting<unknown>(CERTIFICATE_STORAGE_SETTING_KEY))?.redis ?? null;
  } catch {
    throw new SharedStateUnavailableError("The certificate storage setting is not valid");
  }
  if (!redis) throw new SharedStateUnavailableError("No Redis or Valkey settings reached this replica");
  const fingerprint = fingerprintOf(redis);
  if (!c.replicaClient || c.replicaClient.fingerprint !== fingerprint) {
    const old = c.replicaClient?.redis;
    if (old) old.quit().catch(() => old.disconnect());
    c.replicaClient = { fingerprint, redis: createSharedRedisClient(redis) };
  }
  return { redis: c.replicaClient.redis, namespace };
}

/** Tests only: the client a replica uses for its master's shared state (null: from the settings). */
export function setReplicaSharedRedisForTests(redis: SharedRedis | null): void {
  cache().replicaOverride = redis;
}

/** Whether request paths use shared state now (cached; never throws). */
export async function isSharedStateOn(): Promise<boolean> {
  const c = cache();
  if (c.override !== undefined) return c.override !== null;
  return (await resolveSharedState()).status !== "off";
}

function closeClient(c: Cache): void {
  if (!c.client) return;
  const old = c.client.redis;
  c.client = null;
  old.quit().catch(() => old.disconnect());
}

const TEST_SETTING: StoredSharedState = { enabled: true, keyPrefix: "test", generation: "00000000" };
const TEST_REDIS: StoredRedisStorage = {
  mode: "standalone",
  addresses: ["127.0.0.1:6379"],
  db: 0,
  keyPrefix: "caddy",
  tls: { enabled: false, insecureSkipVerify: false },
};

/** Tests only: build clients with this factory instead of ioredis (null: ioredis again). */
export function setSharedRedisClientFactoryForTests(factory: ClientFactory | null): void {
  const c = cache();
  closeClient(c);
  c.factory = factory;
  c.resolved = null;
}

/**
 * Tests only: use this client and namespace as the shared state (null: shared
 * state off; undefined: back to the settings).
 */
export function setSharedStateForTests(state: SharedState | null | undefined): void {
  const c = cache();
  c.override = state;
  c.resolved = null;
}
