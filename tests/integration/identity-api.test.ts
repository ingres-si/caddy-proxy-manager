/**
 * The identity REST endpoints through the real guard (src/lib/api-auth.ts)
 * with API tokens: the caller's sessions, a user's sessions for those with
 * users:read / users:write, passkey management, interface preferences, and
 * the last sign-in and "invited" state in the users API.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  tokens: new Map<string, { user: { id: number; role: string; customRoleId: number | null }; scopes: string[] | null }>(),
  currentSessionId: null as number | null,
}));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('@/src/lib/models/api-tokens', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/src/lib/models/api-tokens')>();
  return {
    ...original,
    validateToken: vi.fn(async (raw: string) => {
      const entry = ctx.tokens.get(raw);
      return entry ? { token: { id: 1, name: 'test', createdBy: entry.user.id, scopes: entry.scopes }, user: entry.user } : null;
    }),
  };
});
vi.mock('@/src/lib/auth', () => ({
  auth: vi.fn(async () => null),
  checkSameOrigin: vi.fn(() => null),
  getCurrentSessionId: vi.fn(async () => ctx.currentSessionId),
}));

import { logAuditEvent } from '@/src/lib/audit';
import * as ownSessions from '@/app/api/v1/sessions/route';
import * as ownSession from '@/app/api/v1/sessions/[id]/route';
import * as userSessions from '@/app/api/v1/users/[id]/sessions/route';
import * as userSession from '@/app/api/v1/users/[id]/sessions/[sessionId]/route';
import * as passkeysRoute from '@/app/api/v1/passkeys/route';
import * as passkeyRoute from '@/app/api/v1/passkeys/[id]/route';
import * as preferencesRoute from '@/app/api/v1/preferences/route';
import * as userRoute from '@/app/api/v1/users/[id]/route';
import { touchSessionLastSeen } from '@/src/lib/models/sessions';
import { recordSignIn } from '@/src/lib/sign-in-activity';
import { first } from '@/src/lib/db/ops';

const ADMIN = 1;
const ALICE = 2;
const BOB = 3;
const OPERATOR = 4;
const ROLE = 1;

const now = () => new Date().toISOString();

async function insertUser(id: number, role: string, customRoleId: number | null = null) {
  await ctx.db.insert(schema.users).values({
    id, email: `user${id}@example.com`, name: `User ${id}`, role, customRoleId, provider: 'credentials',
    subject: `user${id}`, status: 'active', createdAt: now(), updatedAt: now(),
  });
}

async function insertSession(id: number, userId: number, ip: string | null = '203.0.113.24') {
  await ctx.db.insert(schema.sessions).values({
    id, userId, token: `token-${id}`, expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ipAddress: ip, userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
    createdAt: new Date(Date.now() - id * 60_000).toISOString(), updatedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
  });
}

async function insertPasskey(userId: number, name: string): Promise<number> {
  return (await first(ctx.db.insert(schema.passkeys).values({
    userId, name, publicKey: 'public-key', credentialID: `credential-${userId}-${name}`, counter: 0, deviceType: 'multiDevice',
    backedUp: true, createdAt: now(),
  }).returning()))!.id;
}

function request(method: string, token: string, path: string, body?: unknown): any {
  const url = new URL(`https://dash.example.com${path}`);
  return {
    method,
    url: url.toString(),
    headers: new Headers({ authorization: `Bearer ${token}`, 'content-type': 'application/json' }),
    nextUrl: url,
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
      return body;
    },
  };
}

// Route handlers type their params; every test passes the ones its route reads.
const params = (values: Record<string, string | number>) => ({
  params: Promise.resolve(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)]))) as Promise<never>,
});

function audited(): string[] {
  return vi.mocked(logAuditEvent).mock.calls.map(([event]) => event.action);
}

beforeEach(async () => {
  ctx.db = createTestDb();
  ctx.currentSessionId = null;
  vi.mocked(logAuditEvent).mockClear();
  await ctx.db.insert(schema.customRoles).values({
    id: ROLE, name: 'Helpdesk', permissions: JSON.stringify(['users:read', 'users:write']), scopeTags: '[]', createdAt: now(), updatedAt: now(),
  });
  await insertUser(ADMIN, 'admin');
  await insertUser(ALICE, 'user');
  await insertUser(BOB, 'user');
  await insertUser(OPERATOR, 'viewer', ROLE);
  ctx.tokens.clear();
  ctx.tokens.set('admin', { user: { id: ADMIN, role: 'admin', customRoleId: null }, scopes: null });
  ctx.tokens.set('alice', { user: { id: ALICE, role: 'user', customRoleId: null }, scopes: null });
  ctx.tokens.set('operator', { user: { id: OPERATOR, role: 'viewer', customRoleId: ROLE }, scopes: null });
});

describe('your own sessions', () => {
  it('lists them with device and times, the current one first, and signs out the others', async () => {
    await insertSession(10, ALICE);
    await insertSession(11, ALICE, null);
    await insertSession(12, BOB);
    ctx.currentSessionId = 11;

    const list = await (await ownSessions.GET(request('GET', 'alice', '/api/v1/sessions'))).json();
    expect(list.map((session: { id: number }) => session.id)).toEqual([11, 10]);
    expect(list[0]).toMatchObject({ current: true, device: { label: 'Firefox on Linux', kind: 'desktop' }, location: null });
    expect(list[1]).toHaveProperty('lastSeenAt');
    expect(list[1]).toHaveProperty('signedInAt');

    expect((await ownSession.DELETE(request('DELETE', 'alice', '/api/v1/sessions/12'), params({ id: 12 }))).status).toBe(404);
    const revoked = await (await ownSessions.DELETE(request('DELETE', 'alice', '/api/v1/sessions'))).json();
    expect(revoked).toEqual({ revoked: 1 });
    expect((await ctx.db.select().from(schema.sessions)).map((row) => row.id).sort()).toEqual([11, 12]);
    expect(audited()).toEqual(['sessions_revoked']);
  });

  it('records the last request of a session at most once a minute', async () => {
    await insertSession(20, ALICE);
    const before = (await first(ctx.db.select().from(schema.sessions).where(eq(schema.sessions.id, 20)).limit(1)))!.updatedAt;
    await touchSessionLastSeen(20, before);
    const after = (await first(ctx.db.select().from(schema.sessions).where(eq(schema.sessions.id, 20)).limit(1)))!.updatedAt;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
    await touchSessionLastSeen(20, after);
    expect((await first(ctx.db.select().from(schema.sessions).where(eq(schema.sessions.id, 20)).limit(1)))!.updatedAt).toBe(after);
  });
});

describe('a user\'s sessions', () => {
  it('need users:read to list and users:write to sign out, with the target\'s role held', async () => {
    await insertSession(30, ALICE);
    await insertSession(31, ADMIN);

    expect((await userSessions.GET(request('GET', 'alice', '/api/v1/users/3/sessions'), params({ id: BOB }))).status).toBe(403);
    const listed = await userSessions.GET(request('GET', 'operator', '/api/v1/users/2/sessions'), params({ id: ALICE }));
    expect(listed.status).toBe(200);
    expect((await listed.json())[0]).toMatchObject({ id: 30 });
    expect((await userSessions.GET(request('GET', 'admin', '/api/v1/users/99/sessions'), params({ id: 99 }))).status).toBe(404);

    // A custom role cannot sign out an administrator, whose access it does not hold.
    const refused = await userSessions.DELETE(request('DELETE', 'operator', '/api/v1/users/1/sessions'), params({ id: ADMIN }));
    expect(refused.status).toBe(403);
    expect(await ctx.db.select().from(schema.sessions).where(eq(schema.sessions.userId, ADMIN))).toHaveLength(1);

    const one = await userSession.DELETE(request('DELETE', 'operator', '/api/v1/users/2/sessions/30'), params({ id: ALICE, sessionId: 30 }));
    expect(one.status).toBe(200);
    expect((await userSession.DELETE(request('DELETE', 'operator', '/api/v1/users/2/sessions/31'), params({ id: ALICE, sessionId: 31 }))).status).toBe(404);
    expect(audited()).toEqual(['session_revoked']);

    await insertSession(32, ALICE);
    const all = await (await userSessions.DELETE(request('DELETE', 'admin', '/api/v1/users/2/sessions'), params({ id: ALICE }))).json();
    expect(all).toEqual({ revoked: 1 });
  });

  it('keep the caller\'s own current session when they name themselves', async () => {
    await insertSession(40, ADMIN);
    await insertSession(41, ADMIN);
    ctx.currentSessionId = 41;
    const result = await (await userSessions.DELETE(request('DELETE', 'admin', '/api/v1/users/1/sessions'), params({ id: ADMIN }))).json();
    expect(result).toEqual({ revoked: 1 });
    expect((await ctx.db.select().from(schema.sessions)).map((row) => row.id)).toEqual([41]);
  });
});

describe('passkeys', () => {
  it('lists, renames and removes only the caller\'s own', async () => {
    const mine = await insertPasskey(ALICE, 'Laptop');
    const theirs = await insertPasskey(BOB, 'Key');

    const list = await (await passkeysRoute.GET(request('GET', 'alice', '/api/v1/passkeys'))).json();
    expect(list.passkeys).toEqual([expect.objectContaining({ id: mine, name: 'Laptop', lastUsedAt: null })]);
    expect(JSON.stringify(list)).not.toContain('public-key');
    expect(JSON.stringify(list)).not.toContain('credential-');
    // Alice has no password: she cannot add one.
    expect(list.canAdd).toBe(false);

    expect((await passkeyRoute.PATCH(request('PATCH', 'alice', `/api/v1/passkeys/${theirs}`, { name: 'Mine' }), params({ id: theirs }))).status).toBe(404);
    expect((await passkeyRoute.PATCH(request('PATCH', 'alice', `/api/v1/passkeys/${mine}`, { name: 'Mine', extra: 1 }), params({ id: mine }))).status).toBe(400);
    const renamed = await passkeyRoute.PATCH(request('PATCH', 'alice', `/api/v1/passkeys/${mine}`, { name: 'Work laptop' }), params({ id: mine }));
    expect(await renamed.json()).toMatchObject({ name: 'Work laptop' });

    expect((await passkeyRoute.DELETE(request('DELETE', 'alice', `/api/v1/passkeys/${theirs}`), params({ id: theirs }))).status).toBe(404);
    expect((await passkeyRoute.DELETE(request('DELETE', 'alice', `/api/v1/passkeys/${mine}`), params({ id: mine }))).status).toBe(204);
    expect((await ctx.db.select().from(schema.passkeys)).map((row) => row.id)).toEqual([theirs]);
    expect(audited()).toEqual(['passkey_renamed', 'passkey_removed']);
  });
});

describe('interface preferences', () => {
  it('default to the system theme, UTC and en-US, and save valid changes only', async () => {
    expect(await (await preferencesRoute.GET(request('GET', 'alice', '/api/v1/preferences'))).json())
      .toEqual({
        theme: 'system',
        timeZone: 'UTC',
        numberFormat: 'en-US',
        proxyHostsSort: 'default',
        l4ProxyHostsSort: 'default',
        clientCertificatesSort: 'default',
      });

    expect((await preferencesRoute.PUT(request('PUT', 'alice', '/api/v1/preferences', { timeZone: 'Mars/Base' }))).status).toBe(400);
    expect((await preferencesRoute.PUT(request('PUT', 'alice', '/api/v1/preferences', { colour: 'red' }))).status).toBe(400);
    expect((await preferencesRoute.PUT(request('PUT', 'alice', '/api/v1/preferences', { proxyHostsSort: 'host:sideways' }))).status).toBe(400);
    expect((await preferencesRoute.PUT(request('PUT', 'alice', '/api/v1/preferences'))).status).toBe(400);

    const saved = await (await preferencesRoute.PUT(request('PUT', 'alice', '/api/v1/preferences', {
      timeZone: 'Europe/Rome',
      numberFormat: 'de-DE',
      proxyHostsSort: 'host:asc',
    }))).json();
    expect(saved).toEqual({
      theme: 'system',
      timeZone: 'Europe/Rome',
      numberFormat: 'de-DE',
      proxyHostsSort: 'host:asc',
      l4ProxyHostsSort: 'default',
      clientCertificatesSort: 'default',
    });
    expect(await (await preferencesRoute.GET(request('GET', 'admin', '/api/v1/preferences'))).json()).toMatchObject({ timeZone: 'UTC' });
    expect(audited()).toEqual(['preferences_updated']);

    // The same values again change nothing and are not audited.
    await preferencesRoute.PUT(request('PUT', 'alice', '/api/v1/preferences', { timeZone: 'Europe/Rome' }));
    expect(audited()).toEqual(['preferences_updated']);
  });

  it('falls back to application defaults for corrupt stored sort preferences', async () => {
    await ctx.db.insert(schema.userPreferences).values({
      userId: ALICE,
      theme: 'dark',
      timeZone: 'Europe/Rome',
      numberFormat: 'de-DE',
      proxyHostsSort: 'host:sideways',
      l4ProxyHostsSort: 'magic:asc',
      clientCertificatesSort: 'expires:first',
      updatedAt: now(),
    });

    expect(await (await preferencesRoute.GET(request('GET', 'alice', '/api/v1/preferences'))).json())
      .toEqual({
        theme: 'dark',
        timeZone: 'Europe/Rome',
        numberFormat: 'de-DE',
        proxyHostsSort: 'default',
        l4ProxyHostsSort: 'default',
        clientCertificatesSort: 'default',
      });
  });
});

describe('last sign-in and invited accounts', () => {
  it('shows an account as invited until it signs in or uses an API token', async () => {
    const before = await (await userRoute.GET(request('GET', 'admin', '/api/v1/users/2'), params({ id: ALICE }))).json();
    expect(before).toMatchObject({ lastSignInAt: null, lastSignInMethod: null, invited: true });

    await recordSignIn(ALICE, { method: 'sso', providerId: null });
    const after = await (await userRoute.GET(request('GET', 'admin', '/api/v1/users/2'), params({ id: ALICE }))).json();
    expect(after).toMatchObject({ lastSignInMethod: 'sso', invited: false });
    expect(after.lastSignInAt).not.toBeNull();

    await ctx.db.insert(schema.apiTokens).values({ name: 'ci', tokenHash: 'h'.repeat(64), createdBy: BOB, createdAt: now(), lastUsedAt: now() });
    expect((await (await userRoute.GET(request('GET', 'admin', '/api/v1/users/3'), params({ id: BOB }))).json()).invited).toBe(false);

    await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, OPERATOR));
    expect((await (await userRoute.GET(request('GET', 'admin', '/api/v1/users/4'), params({ id: OPERATOR }))).json()).invited).toBe(false);
  });
});
