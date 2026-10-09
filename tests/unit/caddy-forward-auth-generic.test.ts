/**
 * Generic Forward Auth provider (Authelia etc.) — issue #188.
 *
 * Covers the generated Caddy config for the split browser vs API pattern:
 *  - Browser requests (Accept: text/html, no X-Requested-With) keep the auth
 *    server's redirect flow (portal login).
 *  - API clients / WebSocket handshakes get 3xx→401 conversion when apiSplit
 *    is enabled.
 *  - Requests carrying an api-bypass header skip forward auth entirely.
 *  - Identity headers copied from the auth response (Remote-*, ...) are
 *    stripped from inbound requests on EVERY route that proxies to the
 *    upstream — protected or not — so they cannot be spoofed (same class of
 *    fix as the X-CPM-* stripping, SECURITY-AUDIT H1).
 *
 * Also covers model-layer behavior: provider preset defaults, header-name
 * validation, and the one-provider-per-host conflict rule.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});

// Keep the real buildCaddyDocument (pure config builder) but stub the network
// apply so createProxyHost doesn't try to reach a live Caddy admin API.
vi.mock('../../src/lib/caddy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/caddy')>();
  return { ...actual, applyCaddyConfig: vi.fn().mockResolvedValue({ ok: true }) };
});

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { createProxyHost, updateProxyHost, getProxyHost } from '../../src/lib/models/proxy-hosts';
import { ApiValidationError } from '../../src/lib/api-errors';
import { buildCaddyDocument } from '../../src/lib/caddy';
import * as schema from '../../src/lib/db/schema';

const UPSTREAM = '10.0.0.5:8080';
const DIAL = 'authelia:9091';
const ENDPOINT = '/api/authz/forward-auth';
const COPY_HEADERS = ['Remote-User', 'Remote-Groups', 'Remote-Email', 'Remote-Name', 'Remote-IP'];

// ── config-document helpers ─────────────────────────────────────────────

interface Route {
  match?: Array<Record<string, unknown>>;
  handle?: Array<Record<string, unknown>>;
  terminal?: boolean;
}

/** Recursively collect every route object anywhere in the config document. */
function collectRoutes(node: unknown, out: Route[] = []): Route[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRoutes(item, out);
  } else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.match) && Array.isArray(obj.handle)) out.push(obj as Route);
    for (const v of Object.values(obj)) collectRoutes(v, out);
  }
  return out;
}

function isForwardAuthProxy(h: unknown): boolean {
  const handler = h as Record<string, unknown>;
  if (handler?.handler !== 'reverse_proxy') return false;
  const rewrite = handler.rewrite as { uri?: string } | undefined;
  return rewrite?.uri === ENDPOINT;
}

function isUpstreamProxy(h: unknown): boolean {
  const handler = h as Record<string, unknown>;
  if (handler?.handler !== 'reverse_proxy') return false;
  const ups = (handler.upstreams as Array<{ dial?: string }> | undefined) ?? [];
  return ups.some((u) => u.dial === UPSTREAM);
}

function isStrip(h: unknown): boolean {
  const handler = h as Record<string, unknown>;
  if (handler?.handler !== 'headers') return false;
  const del = (handler.request as { delete?: string[] } | undefined)?.delete;
  return Array.isArray(del) && COPY_HEADERS.every((name) => del.includes(name));
}

function hasRedirectTo401(h: unknown): boolean {
  const handler = h as Record<string, unknown>;
  if (handler?.handler !== 'reverse_proxy') return false;
  const hr = handler.handle_response as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(hr)) return false;
  return hr.some((entry) => {
    const match = entry.match as { status_code?: number[] } | undefined;
    if (!match?.status_code?.includes(302)) return false;
    const routes = entry.routes as Array<{ handle?: Array<Record<string, unknown>> }> | undefined;
    return (routes ?? []).some((r) =>
      (r.handle ?? []).some((sub) => sub.handler === 'static_response' && sub.status_code === 401)
    );
  });
}

function copiesRemoteUser(h: unknown): boolean {
  const handler = h as Record<string, unknown>;
  if (handler?.handler !== 'reverse_proxy') return false;
  const hr = handler.handle_response as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(hr)) return false;
  return hr.some((entry) =>
    ((entry.routes as Array<{ handle?: Array<Record<string, unknown>> }> | undefined) ?? []).some((r) =>
      (r.handle ?? []).some((sub) => {
        if (sub.handler !== 'headers') return false;
        const set = (sub.request as { set?: Record<string, unknown> } | undefined)?.set;
        return Boolean(set?.['Remote-User']);
      })
    )
  );
}

function routeHost(route: Route): string[] {
  return ((matchSets(route)[0]?.host as string[] | undefined) ?? []);
}

function servesHost(route: Route, host: string): boolean {
  return routeHost(route).some((name) => name === host);
}

function matchSets(route: Route): Array<Record<string, unknown>> {
  return (route.match ?? []) as Array<Record<string, unknown>>;
}

beforeEach(async () => {
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.users).catch(() => {});
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    provider: 'credentials',
    subject: 'admin',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

describe('generic forward auth: full-site split browser vs API', () => {
  it('emits a browser catch-all (Accept matcher, redirect flow) and an API catch-all (3xx→401)', async () => {
    await createProxyHost(
      {
        name: 'fa-split',
        domains: ['app.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: {
          enabled: true,
          provider: 'authelia',
          authUpstream: 'http://authelia:9091',
          authEndpoint: ENDPOINT,
          copyHeaders: COPY_HEADERS,
          apiSplit: true,
        },
      },
      1
    );

    const doc = await buildCaddyDocument();
    const routes = collectRoutes(doc).filter((r) => servesHost(r, 'app.example.com'));

    const browserRoutes = routes.filter((r) => {
      const m = matchSets(r)[0];
      const header = m?.header as Record<string, string[]> | undefined;
      return Boolean(header?.Accept);
    });
    expect(browserRoutes.length).toBeGreaterThan(0);
    const browserMatch = matchSets(browserRoutes[0])[0];
    expect((browserMatch.header as Record<string, string[]>).Accept).toContain('*text/html*');
    expect(Array.isArray(browserMatch.not)).toBe(true);
    // Browser branch keeps the redirect flow: no 3xx→401 conversion.
    expect(browserRoutes[0].handle!.some(hasRedirectTo401)).toBe(false);
    expect(browserRoutes[0].handle!.some(isForwardAuthProxy)).toBe(true);
    expect(browserRoutes[0].handle!.some(copiesRemoteUser)).toBe(true);

    // API catch-all: host-only match, carries the 401 conversion.
    const apiCatchAll = routes.find((r) => {
      const m = matchSets(r)[0];
      return !m?.header && !m?.path && r.handle!.some(hasRedirectTo401);
    });
    expect(apiCatchAll).toBeDefined();
    expect(apiCatchAll!.handle!.some(isForwardAuthProxy)).toBe(true);

    // Both auth handlers dial the auth server.
    for (const route of [...browserRoutes, apiCatchAll!]) {
      const fa = route.handle!.find(isForwardAuthProxy) as Record<string, unknown>;
      const ups = fa.upstreams as Array<{ dial: string }>;
      expect(ups[0].dial).toBe(DIAL);
    }
  });

  it('without apiSplit, a single unified catch-all with the redirect flow is emitted', async () => {
    await createProxyHost(
      {
        name: 'fa-unified',
        domains: ['unified.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: {
          enabled: true,
          provider: 'authelia',
          authUpstream: 'http://authelia:9091',
          authEndpoint: ENDPOINT,
          copyHeaders: COPY_HEADERS,
        },
      },
      1
    );

    const doc = await buildCaddyDocument();
    const routes = collectRoutes(doc).filter((r) =>
      r.handle!.some(isForwardAuthProxy) || r.handle!.some(isUpstreamProxy)
    );
    // No Accept header matcher anywhere on this host.
    for (const r of routes) {
      const m = matchSets(r)[0];
      expect(m?.header).toBeUndefined();
    }
    // Exactly one FA-carrying route (the catch-all), without 401 conversion.
    const faRoutes = routes.filter((r) => r.handle!.some(isForwardAuthProxy));
    expect(faRoutes.length).toBe(1);
    expect(faRoutes[0].handle!.some(hasRedirectTo401)).toBe(false);
  });

  it('strips spoofable identity headers from EVERY route that proxies upstream', async () => {
    await createProxyHost(
      {
        name: 'fa-strip',
        domains: ['strip.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: {
          enabled: true,
          provider: 'authelia',
          authUpstream: 'http://authelia:9091',
          authEndpoint: ENDPOINT,
          copyHeaders: COPY_HEADERS,
          apiSplit: true,
          excludedPaths: ['/public/*'],
          apiBypassHeaders: ['X-Api-Key'],
        },
      },
      1
    );

    const doc = await buildCaddyDocument();
    const handleArrays: unknown[][] = [];
    (function walk(node: unknown) {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
      } else if (node && typeof node === 'object') {
        const obj = node as Record<string, unknown>;
        if (Array.isArray(obj.handle)) handleArrays.push(obj.handle as unknown[]);
        for (const v of Object.values(obj)) walk(v);
      }
    })(doc);

    const upstreamRoutes = handleArrays.filter((arr) => arr.some(isUpstreamProxy));
    expect(upstreamRoutes.length).toBeGreaterThan(0);
    for (const arr of upstreamRoutes) {
      const stripIdx = arr.findIndex(isStrip);
      const proxyIdx = arr.findIndex(isUpstreamProxy);
      expect(stripIdx).toBeGreaterThanOrEqual(0);
      expect(stripIdx).toBeLessThan(proxyIdx);
    }
  });
});

describe('generic forward auth: path modes', () => {
  it('excluded paths bypass auth; everything else is protected', async () => {
    await createProxyHost(
      {
        name: 'fa-excluded',
        domains: ['excl.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: {
          enabled: true,
          provider: 'authelia',
          authUpstream: 'http://authelia:9091',
          authEndpoint: ENDPOINT,
          copyHeaders: COPY_HEADERS,
          apiSplit: true,
          excludedPaths: ['/share/*'],
        },
      },
      1
    );

    const doc = await buildCaddyDocument();
    const routes = collectRoutes(doc).filter((r) => servesHost(r, 'excl.example.com'));

    const excludedRoute = routes.find((r) => (matchSets(r)[0]?.path as string[] | undefined)?.includes('/share/*'));
    expect(excludedRoute).toBeDefined();
    expect(excludedRoute!.handle!.some(isForwardAuthProxy)).toBe(false);
    expect(excludedRoute!.handle!.some(isUpstreamProxy)).toBe(true);

    // Protected catch-alls still exist with FA.
    const faCatchAll = routes.find((r) => !matchSets(r)[0]?.path && r.handle!.some(isForwardAuthProxy));
    expect(faCatchAll).toBeDefined();
  });

  it('protected paths get auth (browser + API pair); the catch-all stays unprotected', async () => {
    await createProxyHost(
      {
        name: 'fa-protected',
        domains: ['prot.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: {
          enabled: true,
          provider: 'authelia',
          authUpstream: 'http://authelia:9091',
          authEndpoint: ENDPOINT,
          copyHeaders: COPY_HEADERS,
          apiSplit: true,
          protectedPaths: ['/secret/*'],
        },
      },
      1
    );

    const doc = await buildCaddyDocument();
    const routes = collectRoutes(doc).filter((r) => servesHost(r, 'prot.example.com'));

    const protectedRoutes = routes.filter((r) => (matchSets(r)[0]?.path as string[] | undefined)?.includes('/secret/*'));
    expect(protectedRoutes.length).toBe(2);
    const browserVariant = protectedRoutes.find((r) => Boolean(matchSets(r)[0]?.header));
    const apiVariant = protectedRoutes.find((r) => !matchSets(r)[0]?.header);
    expect(browserVariant).toBeDefined();
    expect(apiVariant).toBeDefined();
    expect(browserVariant!.handle!.some(isForwardAuthProxy)).toBe(true);
    expect(browserVariant!.handle!.some(hasRedirectTo401)).toBe(false);
    expect(apiVariant!.handle!.some(hasRedirectTo401)).toBe(true);

    const unprotectedCatchAll = routes.find(
      (r) => !matchSets(r)[0]?.path && !matchSets(r)[0]?.header && !r.handle!.some(isForwardAuthProxy) && r.handle!.some(isUpstreamProxy)
    );
    expect(unprotectedCatchAll).toBeDefined();
  });

  it('bypass-header routes skip forward auth and come before the auth routes', async () => {
    await createProxyHost(
      {
        name: 'fa-bypass',
        domains: ['bypass.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: {
          enabled: true,
          provider: 'authelia',
          authUpstream: 'http://authelia:9091',
          authEndpoint: ENDPOINT,
          copyHeaders: COPY_HEADERS,
          apiSplit: true,
          apiBypassHeaders: ['X-Api-Key'],
        },
      },
      1
    );

    const doc = await buildCaddyDocument();
    const routes = collectRoutes(doc).filter((r) => servesHost(r, 'bypass.example.com'));

    const bypassRoute = routes.find((r) => {
      const header = matchSets(r)[0]?.header as Record<string, string[]> | undefined;
      return Boolean(header?.['X-Api-Key']);
    });
    expect(bypassRoute).toBeDefined();
    expect(bypassRoute!.handle!.some(isForwardAuthProxy)).toBe(false);
    expect(bypassRoute!.handle!.some(isUpstreamProxy)).toBe(true);

    // The bypass route appears before any forward-auth route in the route list.
    const faIdx = routes.findIndex((r) => r.handle!.some(isForwardAuthProxy));
    const bypassIdx = routes.indexOf(bypassRoute!);
    expect(bypassIdx).toBeGreaterThanOrEqual(0);
    expect(faIdx).toBeGreaterThan(bypassIdx);
  });
});

describe('generic forward auth: model behavior', () => {
  it('applies Authelia preset defaults on round-trip', async () => {
    await createProxyHost(
      {
        name: 'fa-defaults',
        domains: ['defaults.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: { enabled: true, authUpstream: 'http://authelia:9091' },
      },
      1
    );

    const host = await getProxyHost((await ctx.db.select().from(schema.proxyHosts))[0].id);
    expect(host?.forwardAuth).not.toBeNull();
    expect(host!.forwardAuth!.provider).toBe('authelia');
    expect(host!.forwardAuth!.authEndpoint).toBe(ENDPOINT);
    expect(host!.forwardAuth!.copyHeaders).toEqual(COPY_HEADERS);
    expect(host!.forwardAuth!.apiSplit).toBe(false);
    expect(host!.forwardAuth!.apiBypassHeaders).toEqual([]);
  });

  it('rejects invalid header names and strips placeholders from the endpoint', async () => {
    await createProxyHost(
      {
        name: 'fa-sanitize',
        domains: ['sanitize.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: {
          enabled: true,
          provider: 'custom',
          authUpstream: 'http://fa:9000',
          authEndpoint: '/verify{http.request.host}',
          copyHeaders: ['Remote-User', 'Bad Header Name!'],
          apiBypassHeaders: ['X-Api-Key', 'Also Bad'],
        },
      },
      1
    );

    const host = await getProxyHost((await ctx.db.select().from(schema.proxyHosts))[0].id);
    expect(host!.forwardAuth!.authEndpoint).toBe('/verify');
    expect(host!.forwardAuth!.copyHeaders).toEqual(['Remote-User']);
    expect(host!.forwardAuth!.apiBypassHeaders).toEqual(['X-Api-Key']);
  });

  it('rejects enabling two forward-auth providers at once on create', async () => {
    await expect(
      createProxyHost(
        {
          name: 'fa-conflict',
          domains: ['conflict.example.com'],
          upstreams: [UPSTREAM],
          forwardAuth: { enabled: true, authUpstream: 'http://authelia:9091' },
          ingressiForwardAuth: { enabled: true },
        },
        1
      )
    ).rejects.toBeInstanceOf(ApiValidationError);
  });

  it('rejects enabling generic forward auth on a host that already uses Authentik', async () => {
    const host = await createProxyHost(
      {
        name: 'fa-authentik',
        domains: ['ak.example.com'],
        upstreams: [UPSTREAM],
        authentik: {
          enabled: true,
          outpostDomain: 'outpost.example.com',
          outpostUpstream: 'http://outpost:9000',
        },
      },
      1
    );

    await expect(
      updateProxyHost(
        host.id,
        { forwardAuth: { enabled: true, authUpstream: 'http://authelia:9091' } },
        1
      )
    ).rejects.toBeInstanceOf(ApiValidationError);
  });

  it('unrelated updates still succeed on a legacy host with a pre-existing conflict', async () => {
    const host = await createProxyHost(
      {
        name: 'fa-legacy',
        domains: ['legacy.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: { enabled: true, authUpstream: 'http://authelia:9091' },
      },
      1
    );
    // Simulate a legacy row that somehow carries both providers.
    const [row] = await ctx.db.select().from(schema.proxyHosts);
    const meta = JSON.parse(row.meta ?? '{}');
    meta.cpm_forward_auth = { enabled: true };
    await ctx.db.update(schema.proxyHosts).set({ meta: JSON.stringify(meta) });

    const updated = await updateProxyHost(host.id, { name: 'fa-legacy-renamed' }, 1);
    expect(updated.name).toBe('fa-legacy-renamed');
  });

  it('rejects an invalid auth upstream URL (fail closed, not fail open)', async () => {
    await expect(
      createProxyHost(
        {
          name: 'fa-badurl',
          domains: ['badurl.example.com'],
          upstreams: [UPSTREAM],
          forwardAuth: {
            enabled: true,
            provider: 'custom',
            authUpstream: 'not-a-url',
            authEndpoint: ENDPOINT,
          },
        },
        1
      )
    ).rejects.toBeInstanceOf(ApiValidationError);

    // A non-http(s) scheme is rejected too.
    await expect(
      createProxyHost(
        {
          name: 'fa-badurl2',
          domains: ['badurl2.example.com'],
          upstreams: [UPSTREAM],
          forwardAuth: {
            enabled: true,
            provider: 'custom',
            authUpstream: 'ftp://authelia:9091',
            authEndpoint: ENDPOINT,
          },
        },
        1
      )
    ).rejects.toBeInstanceOf(ApiValidationError);
  });

  it('rejects enabling the custom provider without an auth endpoint', async () => {
    await expect(
      createProxyHost(
        {
          name: 'fa-noendpoint',
          domains: ['noendpoint.example.com'],
          upstreams: [UPSTREAM],
          forwardAuth: {
            enabled: true,
            provider: 'custom',
            authUpstream: 'http://fa:9000',
          },
        },
        1
      )
    ).rejects.toBeInstanceOf(ApiValidationError);
  });
});
