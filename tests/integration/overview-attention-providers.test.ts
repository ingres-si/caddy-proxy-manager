/**
 * The sign-in source of the overview's "Needs attention"
 * (src/lib/attention/identity-provider.ts): what each issue becomes and the
 * permissions it answers for; and that traffic signals, which only feed the
 * overview's cards now (src/lib/analytics/signals-cache.ts), are no source.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import type { TrafficSignals } from '../../src/lib/analytics/signals';
import type { IdentityHealth } from '../../src/lib/identity-health';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  signals: null as unknown as TrafficSignals,
  identity: { directories: [], issues: [] } as IdentityHealth,
}));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('../../src/lib/analytics/signals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/analytics/signals')>()),
  getTrafficSignals: vi.fn(async () => ctx.signals),
}));
vi.mock('../../src/lib/identity-health', () => ({
  getIdentityHealth: vi.fn(() => ctx.identity),
}));

import { builtInAccess, type Access, type Permission } from '../../src/lib/permissions';
import { collectAttention } from '../../src/lib/attention';
import type { AttentionItem } from '../../src/lib/attention/types';
import { getTrafficSignals } from '../../src/lib/analytics/signals';
import { cachedTrafficSignals, clearTrafficSignalsCache } from '../../src/lib/analytics/signals-cache';
import { first } from '@/src/lib/db/ops';

const NOW = Math.floor(Date.parse('2026-10-03T11:36:00.000Z') / 1000);
const stamp = () => new Date().toISOString();
let adminId: number;
let memberId: number;
let mailHostId: number;

async function user(email: string, role: string): Promise<number> {
  return (await first(ctx.db.insert(schema.users).values({ email, name: email.split('@')[0], role, status: 'active', createdAt: stamp(), updatedAt: stamp() }).returning()))!.id;
}

function custom(permissions: Permission[], scopeTags: string[] = []): Access {
  return { ...builtInAccess(memberId, 'viewer'), customRole: { id: 1, name: 'Custom' }, permissions: new Set(permissions), scopeTags };
}

function signals(overrides: Partial<TrafficSignals> = {}): TrafficSignals {
  return {
    status: 'ok',
    generatedAt: NOW,
    errorBursts: [
      { host: 'mail.example.com', proxyHostId: mailHostId, count: 143, requests: 1200, start: NOW - 9000, end: NOW - 8926, ongoing: false, status: 501, method: 'POST', path: '/Microsoft-Server-ActiveSync' },
      { host: 'api.example.com', proxyHostId: null, count: 40, requests: 100, start: NOW - 240, end: NOW - 30, ongoing: true, status: 502, method: 'GET', path: '/' },
    ],
    mitigationSpikes: [
      { host: 'mail.example.com', proxyHostId: mailHostId, count: 600, baseline: 20, factor: 30, topOutcome: 'waf' },
      { host: 'shop.example.com', proxyHostId: null, count: 120, baseline: 0, factor: null, topOutcome: 'geo' },
    ],
    blockedConcentrations: [
      {
        host: 'example.com', proxyHostId: null, path: '/portal', outcome: 'geo', count: 826, shareOfHost: 0.9,
        countries: [{ country: 'HK', count: 300 }, { country: 'IN', count: 200 }, { country: 'AU', count: 100 }, { country: 'KR', count: 100 }, { country: 'XX', count: 6 }],
        wafRuleId: null,
      },
      { host: 'example.com', proxyHostId: null, path: '/api', outcome: 'waf', count: 100, shareOfHost: 0.1, countries: [{ country: 'LAN', count: 100 }], wafRuleId: 920450 },
    ],
    ...overrides,
  };
}

async function items(access: Access, source: string): Promise<AttentionItem[]> {
  const view = await collectAttention(access, { now: new Date(NOW * 1000) });
  return view.items.filter((item) => item.source === source);
}

beforeEach(async () => {
  ctx.db = createTestDb();
  vi.clearAllMocks();
  clearTrafficSignalsCache();
  adminId = await user('admin@example.com', 'admin');
  memberId = await user('member@example.com', 'viewer');
  mailHostId = (await first(ctx.db
    .insert(schema.proxyHosts)
    .values({ name: 'Mail', domains: '["mail.example.com"]', upstreams: '[]', tags: '[]', createdAt: stamp(), updatedAt: stamp() })
    .returning()))!.id;
  ctx.signals = signals();
  ctx.identity = { directories: [], issues: [] };
});

describe('traffic signals', () => {
  it('are not a source of Needs attention: server errors are alerts of the built-in Error rate rule', async () => {
    const view = await collectAttention(builtInAccess(adminId, 'admin'), { now: new Date(NOW * 1000) });
    expect(view.sources.map((source) => source.id)).not.toContain('traffic');
    expect(getTrafficSignals).not.toHaveBeenCalled();
  });

  it('are reused for 30 seconds by the overview', async () => {
    await cachedTrafficSignals(1_000_000);
    await cachedTrafficSignals(1_010_000);
    expect(getTrafficSignals).toHaveBeenCalledTimes(1);
    await cachedTrafficSignals(1_031_000);
    expect(getTrafficSignals).toHaveBeenCalledTimes(2);
  });
});

describe('sign-in health', () => {
  beforeEach(() => {
    ctx.identity = {
      directories: [],
      issues: [
        {
          kind: 'directory_failing', severity: 'critical', directoryId: 4, name: 'Corp LDAP', failingSince: '2026-10-03T09:00:00.000Z',
          consecutiveFailures: 3, lastError: 'Service account bind: invalid credentials (LDAP result 49)', message: 'm',
        },
        { kind: 'mfa_overdue', severity: 'warning', accounts: 2, message: 'm' },
      ],
    };
  });

  it('reports failing directories and accounts locked out by the MFA policy', async () => {
    const list = await items(builtInAccess(adminId, 'admin'), 'identity');
    expect(list).toEqual([
      expect.objectContaining({
        id: 'directory:4',
        severity: 'critical',
        title: 'People cannot sign in through the directory "Corp LDAP"',
        detail:
          'Service account bind: invalid credentials (LDAP result 49) (the last 3 checks in a row, failing since 2026-10-03 09:00 UTC). Accounts from other sign-in methods are not affected.',
        actions: [{ label: 'Open directories', route: '/ldap' }],
      }),
      expect.objectContaining({
        id: 'mfa_overdue',
        severity: 'warning',
        title: '2 accounts are locked out until they set up multi-factor authentication',
        actions: [{ label: 'Review accounts', route: '/users' }],
      }),
    ]);
  });

  it('shows each issue only to readers of what it is about', async () => {
    expect((await items(custom(['users:read']), 'identity')).map((item) => item.id)).toEqual(['mfa_overdue']);
    expect((await items(custom(['ldap:read']), 'identity')).map((item) => item.id)).toEqual(['directory:4']);
    expect((await collectAttention(builtInAccess(memberId, 'viewer'))).sources.map((source) => source.id)).not.toContain('identity');
  });
});
