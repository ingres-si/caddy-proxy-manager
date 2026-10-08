/**
 * Forward-auth request-path state behind its store interface
 * (src/lib/forward-auth-state.ts): the SQLite tables without high
 * availability, Redis/Valkey with shared state (ioredis-mock, which runs the
 * real Lua scripts). The same flow on both; then what only the shared store
 * does: every node sees the same sessions, revocation reaches every node at
 * once, every key has a TTL, and nothing secret is stored in clear.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from '../helpers/ioredis-mock';
import type Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});
vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));
vi.mock('../../src/lib/caddy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/caddy')>();
  return { ...actual, applyCaddyConfig: vi.fn().mockResolvedValue(undefined) };
});

import * as schema from '../../src/lib/db/schema';
import {
  checkHostAccess,
  consumeRedirectIntent,
  createExchangeCode,
  createForwardAuthSession,
  createRedirectIntent,
  deleteForwardAuthSession,
  getForwardAuthSession,
  isRedirectIntentUsable,
  listForwardAuthSessions,
  redeemExchangeCode,
  revokeForwardAuthSessionsWithoutAccess,
  setForwardAuthAccess,
  validateForwardAuthSession,
} from '../../src/lib/models/forward-auth';
import { forwardAuthStateStore } from '../../src/lib/forward-auth-state';
import { addGroupMember, createGroup, deleteGroup, removeGroupMember } from '../../src/lib/models/groups';
import { deleteUser, updateUserStatus } from '../../src/lib/models/user';
import { deleteProxyHost } from '../../src/lib/models/proxy-hosts';
import { setSharedStateForTests } from '../../ee/high-availability/shared-state/connection';
import { createRedisForwardAuthStore } from '../../ee/high-availability/shared-state/forward-auth-store';

const NAMESPACE = 'ingressi:0123abcd:';
const now = () => new Date().toISOString();
let redis: Redis;

async function insertUser(email: string, role = 'user') {
  const [user] = await ctx.db
    .insert(schema.users)
    .values({ email, name: email, role, provider: 'credentials', subject: email, status: 'active', createdAt: now(), updatedAt: now() })
    .returning();
  return user;
}

async function insertHost(domain = 'app.example.com') {
  const [host] = await ctx.db
    .insert(schema.proxyHosts)
    .values({
      name: domain,
      domains: JSON.stringify([domain]),
      upstreams: JSON.stringify(['backend:8080']),
      sslForced: true,
      hstsEnabled: true,
      hstsSubdomains: false,
      allowWebsocket: true,
      preserveHostHeader: true,
      skipHttpsHostnameValidation: false,
      enabled: true,
      meta: JSON.stringify({ cpm_forward_auth: { enabled: true } }),
      createdAt: now(),
      updatedAt: now(),
    })
    .returning();
  return host;
}

async function grantUser(hostId: number, userId: number) {
  await ctx.db.insert(schema.forwardAuthAccess).values({ proxyHostId: hostId, userId, groupId: null, createdAt: now() });
}

/** The portal and callback flow: intent, session, exchange code, redemption. */
async function signIn(userId: number, target = 'https://app.example.com/page') {
  const rid = await createRedirectIntent(target);
  expect(await isRedirectIntentUsable(rid)).toBe(true);
  const intent = await consumeRedirectIntent(rid);
  expect(intent).not.toBeNull();
  // An intent is used once.
  expect(await consumeRedirectIntent(rid)).toBeNull();
  expect(await isRedirectIntentUsable(rid)).toBe(false);
  const { rawToken: initialToken, session } = await createForwardAuthSession(userId, intent!.audience);
  const { rawCode } = await createExchangeCode(session.id, intent!.redirectUri, intent!.audience);
  const redeemed = await redeemExchangeCode(rawCode, intent!.audience);
  expect(redeemed).toMatchObject({ sessionId: session.id, redirectUri: target });
  // A code is redeemed once.
  expect(await redeemExchangeCode(rawCode, intent!.audience)).toBeNull();
  return { audience: intent!.audience, session, token: redeemed!.rawSessionToken, initialToken };
}

async function allKeys(): Promise<string[]> {
  return redis.keys('*');
}

beforeEach(async () => {
  await ctx.db.delete(schema.forwardAuthAccess);
  await ctx.db.delete(schema.forwardAuthSessions);
  await ctx.db.delete(schema.forwardAuthExchanges);
  await ctx.db.delete(schema.forwardAuthRedirectIntents);
  await ctx.db.delete(schema.groupMembers);
  await ctx.db.delete(schema.groups);
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.users);
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
});

afterEach(() => {
  setSharedStateForTests(undefined);
});

describe.each([
  ['SQLite (no high availability)', false],
  ['Redis/Valkey shared state', true],
])('forward-auth state in %s', (_name, shared) => {
  beforeEach(() => {
    setSharedStateForTests(shared ? { redis, namespace: NAMESPACE } : null);
  });

  it('uses the expected store', async () => {
    expect((await forwardAuthStateStore()).backend).toBe(shared ? 'redis' : 'sqlite');
  });

  it('signs in through intent, session and exchange code, and validates the rotated token only', async () => {
    const user = await insertUser('alice@localhost');
    const host = await insertHost();
    await grantUser(host.id, user.id);
    const { audience, session, token, initialToken } = await signIn(user.id);

    await expect(validateForwardAuthSession(token, audience)).resolves.toEqual({ sessionId: session.id, userId: user.id });
    // The token created with the session is replaced at redemption and never valid.
    await expect(validateForwardAuthSession(initialToken, audience)).resolves.toBeNull();
    // Bound to its audience.
    await expect(validateForwardAuthSession(token, { ...audience, origin: 'https://other.example.com' })).resolves.toBeNull();
    await expect(getForwardAuthSession(session.id)).resolves.toMatchObject({ userId: user.id, proxyHostId: host.id });

    const listed = await listForwardAuthSessions();
    expect(listed.map((entry) => entry.id)).toEqual([session.id]);
  });

  it('keeps an exchange code for its own audience only', async () => {
    const user = await insertUser('alice@localhost');
    const host = await insertHost();
    await grantUser(host.id, user.id);
    const rid = await createRedirectIntent('https://app.example.com/');
    const intent = (await consumeRedirectIntent(rid))!;
    const { session } = await createForwardAuthSession(user.id, intent.audience);
    const { rawCode } = await createExchangeCode(session.id, intent.redirectUri, intent.audience);
    // Another audience cannot claim it, and does not use it up.
    await expect(redeemExchangeCode(rawCode, { ...intent.audience, proxyHostId: host.id + 1 })).resolves.toBeNull();
    await expect(redeemExchangeCode(rawCode, intent.audience)).resolves.toMatchObject({ sessionId: session.id });
  });

  it('ends sessions when the user signs out, is disabled or deleted', async () => {
    const alice = await insertUser('alice@localhost');
    const bob = await insertUser('bob@localhost');
    const host = await insertHost();
    await grantUser(host.id, alice.id);
    await grantUser(host.id, bob.id);
    const first = await signIn(alice.id);
    const second = await signIn(bob.id);

    await deleteForwardAuthSession(first.session.id);
    await expect(validateForwardAuthSession(first.token, first.audience)).resolves.toBeNull();

    const third = await signIn(alice.id);
    await updateUserStatus(alice.id, 'disabled');
    await expect(validateForwardAuthSession(third.token, third.audience)).resolves.toBeNull();

    await deleteUser(bob.id);
    await expect(validateForwardAuthSession(second.token, second.audience)).resolves.toBeNull();
    expect(await listForwardAuthSessions()).toEqual([]);
  });

  it('keeps sessions in SQLite when access shrinks (verify checks it), ends them in the shared store', async () => {
    const admin = await insertUser('admin@localhost', 'admin');
    const alice = await insertUser('alice@localhost');
    const host = await insertHost();
    const group = await createGroup({ name: 'Staff' }, admin.id);
    await addGroupMember(group.id, alice.id, admin.id);
    await ctx.db.insert(schema.forwardAuthAccess).values({ proxyHostId: host.id, userId: null, groupId: group.id, createdAt: now() });
    const signedIn = await signIn(alice.id);
    expect(await checkHostAccess(alice.id, host.id)).toBe(true);

    await removeGroupMember(group.id, alice.id, admin.id);
    expect(await checkHostAccess(alice.id, host.id)).toBe(false);
    const session = await validateForwardAuthSession(signedIn.token, signedIn.audience);
    if (shared) expect(session).toBeNull();
    else expect(session).toMatchObject({ userId: alice.id });
  });

  it('ends the sessions of a deleted group and of grants taken away (shared store)', async () => {
    const admin = await insertUser('admin@localhost', 'admin');
    const alice = await insertUser('alice@localhost');
    const bob = await insertUser('bob@localhost');
    const host = await insertHost();
    const group = await createGroup({ name: 'Staff' }, admin.id);
    await addGroupMember(group.id, alice.id, admin.id);
    await ctx.db.insert(schema.forwardAuthAccess).values({ proxyHostId: host.id, userId: null, groupId: group.id, createdAt: now() });
    await grantUser(host.id, bob.id);
    const aliceSession = await signIn(alice.id);
    const bobSession = await signIn(bob.id);

    await deleteGroup(group.id, admin.id);
    expect((await validateForwardAuthSession(aliceSession.token, aliceSession.audience)) === null).toBe(shared);

    await setForwardAuthAccess(host.id, { userIds: [], groupIds: [] }, admin.id);
    expect((await validateForwardAuthSession(bobSession.token, bobSession.audience)) === null).toBe(shared);
  });

  it('ends a deleted host’s sessions in the shared store', async () => {
    const admin = await insertUser('admin@localhost', 'admin');
    const alice = await insertUser('alice@localhost');
    const host = await insertHost();
    await grantUser(host.id, alice.id);
    const signedIn = await signIn(alice.id);
    await deleteProxyHost(host.id, admin.id);
    // SQLite rows are left as before (no route reaches them once the host is gone).
    if (shared) {
      expect(await (await forwardAuthStateStore()).listSessions()).toEqual([]);
      await expect(validateForwardAuthSession(signedIn.token, signedIn.audience)).resolves.toBeNull();
    }
  });
});

describe('shared forward-auth state', () => {
  beforeEach(() => {
    setSharedStateForTests({ redis, namespace: NAMESPACE });
  });

  it('stores nothing in SQLite and lets another node validate the session', async () => {
    const user = await insertUser('alice@localhost');
    const host = await insertHost();
    await grantUser(host.id, user.id);
    const { audience, session, token } = await signIn(user.id);
    expect(await ctx.db.select().from(schema.forwardAuthSessions)).toEqual([]);
    expect(await ctx.db.select().from(schema.forwardAuthExchanges)).toEqual([]);
    expect(await ctx.db.select().from(schema.forwardAuthRedirectIntents)).toEqual([]);

    // Node B: its own client, the same server.
    const nodeB = createRedisForwardAuthStore({ redis: new RedisMock() as unknown as Redis, namespace: NAMESPACE });
    const { createHash } = await import('node:crypto');
    const found = await nodeB.findSessionByTokenHash(createHash('sha256').update(token).digest('hex'));
    expect(found).toMatchObject({ id: session.id, userId: user.id, proxyHostId: host.id, audienceOrigin: audience.origin });
  });

  it('gives every key a TTL matching today’s lifetimes', async () => {
    const user = await insertUser('alice@localhost');
    const host = await insertHost();
    await grantUser(host.id, user.id);
    const rid = await createRedirectIntent('https://app.example.com/');
    const intentKey = (await allKeys()).find((key) => key.includes(':i:'))!;
    const intentTtl = await redis.pttl(intentKey);
    expect(intentTtl).toBeGreaterThan(9 * 60_000);
    expect(intentTtl).toBeLessThanOrEqual(10 * 60_000);

    const intent = (await consumeRedirectIntent(rid))!;
    const { session } = await createForwardAuthSession(user.id, intent.audience);
    await createExchangeCode(session.id, intent.redirectUri, intent.audience);
    const codeKey = (await allKeys()).find((key) => key.includes(':x:'))!;
    const codeTtl = await redis.pttl(codeKey);
    expect(codeTtl).toBeGreaterThan(50_000);
    expect(codeTtl).toBeLessThanOrEqual(60_000);

    const sessionTtl = await redis.pttl(`${NAMESPACE}{fa}:s:${session.id}`);
    expect(sessionTtl).toBeGreaterThan(7 * 24 * 3600_000 - 60_000);
    expect(sessionTtl).toBeLessThanOrEqual(7 * 24 * 3600_000);

    for (const key of await allKeys()) {
      expect(key.startsWith(NAMESPACE), key).toBe(true);
      expect(await redis.pttl(key), key).toBeGreaterThan(0);
    }
  });

  it('stores tokens, codes and intent ids only as SHA-256 hashes', async () => {
    const user = await insertUser('alice@localhost');
    const host = await insertHost();
    await grantUser(host.id, user.id);
    const rid = await createRedirectIntent('https://app.example.com/');
    const intent = (await consumeRedirectIntent(rid))!;
    const { rawToken, session } = await createForwardAuthSession(user.id, intent.audience);
    const { rawCode } = await createExchangeCode(session.id, intent.redirectUri, intent.audience);
    const dump: string[] = [];
    for (const key of await allKeys()) {
      dump.push(key);
      const type = await redis.type(key);
      if (type === 'hash') dump.push(...Object.values(await redis.hgetall(key)));
      if (type === 'string') dump.push(String(await redis.get(key)));
      if (type === 'set') dump.push(...(await redis.smembers(key)));
    }
    const text = dump.join('\n');
    for (const secret of [rid, rawToken, rawCode]) expect(text.includes(secret)).toBe(false);
  });

  it('re-checks every session after a configuration change and keeps the ones still allowed', async () => {
    const alice = await insertUser('alice@localhost');
    const bob = await insertUser('bob@localhost');
    const host = await insertHost();
    await grantUser(host.id, alice.id);
    await grantUser(host.id, bob.id);
    const aliceSession = await signIn(alice.id);
    const bobSession = await signIn(bob.id);
    await ctx.db.delete(schema.forwardAuthAccess).where(eq(schema.forwardAuthAccess.userId, bob.id));
    expect(await revokeForwardAuthSessionsWithoutAccess({ all: true })).toBe(1);
    await expect(validateForwardAuthSession(aliceSession.token, aliceSession.audience)).resolves.not.toBeNull();
    await expect(validateForwardAuthSession(bobSession.token, bobSession.audience)).resolves.toBeNull();
  });

  it('refuses (fails closed) when the shared server does not answer', async () => {
    const user = await insertUser('alice@localhost');
    const host = await insertHost();
    await grantUser(host.id, user.id);
    const { audience, token } = await signIn(user.id);
    vi.spyOn(redis, 'hgetall').mockRejectedValueOnce(new Error('Connection is closed.'));
    await expect(validateForwardAuthSession(token, audience)).rejects.toThrow();

    // The verify endpoint Caddy calls answers 503, never 200.
    const { GET: verify } = await import('../../app/api/forward-auth/verify/route');
    const { FORWARD_AUTH_COOKIE_NAME, FORWARD_AUTH_PROXY_HOST_ID_HEADER, FORWARD_AUTH_PROXY_PROOF_HEADER, getForwardAuthProxyProof } =
      await import('../../src/lib/forward-auth-trust');
    const { NextRequest } = await import('next/server');
    const verifyRequest = () =>
      new NextRequest('http://web:3000/api/forward-auth/verify', {
        headers: {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'app.example.com',
          [FORWARD_AUTH_PROXY_PROOF_HEADER]: getForwardAuthProxyProof(),
          [FORWARD_AUTH_PROXY_HOST_ID_HEADER]: String(host.id),
          cookie: `${FORWARD_AUTH_COOKIE_NAME}=${token}`,
        },
      });
    expect((await verify(verifyRequest())).status).toBe(200);
    vi.spyOn(redis, 'hgetall').mockRejectedValueOnce(new Error('Connection is closed.'));
    expect((await verify(verifyRequest())).status).toBe(503);
  });
});
