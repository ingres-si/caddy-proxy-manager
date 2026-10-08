/**
 * WAF rule exclusions as records: the start-up copy of the legacy
 * excluded_rule_ids lists (idempotent), the lists kept as a mirror of the
 * whole-scope records, writes through those lists (settings and proxy host
 * APIs), undo when Caddy refuses a change, cleanup with the host, and the
 * table in configuration restore and instance sync.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => {
  const { mkdirSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const dir = join(tmpdir(), `waf-exclusions-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  process.env.L4_PORTS_DIR = dir;
  return { db: null as unknown as TestDb, tmpDir: dir };
});

vi.mock('../../src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});

import { rmSync } from 'node:fs';
import * as schema from '../../src/lib/db/schema';
import { getSetting, saveWafSettings, setSetting } from '../../src/lib/settings';
import { createProxyHost, deleteProxyHost, getProxyHost, updateProxyHost } from '../../src/lib/models/proxy-hosts';
import {
  createWafExclusion,
  createWafExclusions,
  deleteWafExclusion,
  importLegacyWafExclusionsNow,
  LEGACY_EXCLUSION_REASON,
  listWafExclusions,
  updateWafExclusion,
  WafApplyError,
} from '../../src/lib/models/waf-exclusions';
import { readCurrentConfigContent, writeConfigContent } from '../../src/lib/config-content';
import { applySyncPayload, buildSyncPayload, type SyncPayload } from '../../src/lib/instance-sync';
import { isValidSyncPayload, normalizeSyncPayload } from '../../src/lib/instance-sync-validation';
import { canonicalSyncContent } from '../../src/lib/instance-sync-fingerprint';
import { logAuditEvent } from '../../src/lib/audit';
import { first } from '@/src/lib/db/ops';

afterAll(() => {
  rmSync(ctx.tmpDir, { recursive: true, force: true });
});

const now = () => new Date().toISOString();

async function insertHost(name: string, domains: string[], meta: Record<string, unknown> | null = null): Promise<number> {
  const [row] = await ctx.db
    .insert(schema.proxyHosts)
    .values({
      name,
      domains: JSON.stringify(domains),
      upstreams: JSON.stringify(['backend:8080']),
      sslForced: false,
      hstsEnabled: false,
      hstsSubdomains: false,
      allowWebsocket: false,
      preserveHostHeader: false,
      skipHttpsHostnameValidation: false,
      meta: meta ? JSON.stringify(meta) : null,
      enabled: true,
      createdAt: now(),
      updatedAt: now(),
    })
    .returning();
  return row.id;
}

async function hostMeta(id: number): Promise<Record<string, unknown> | null> {
  const row = await first(ctx.db.select({ meta: schema.proxyHosts.meta }).from(schema.proxyHosts).where(eq(schema.proxyHosts.id, id)).limit(1));
  return row?.meta ? JSON.parse(row.meta) : null;
}

async function rows() {
  return await ctx.db.select().from(schema.wafRuleExclusions);
}

const BASE_WAF = { enabled: true, mode: 'On' as const, load_owasp_crs: true, custom_directives: '' };

let userId: number;

beforeEach(async () => {
  await ctx.db.delete(schema.wafRuleExclusions);
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.settings);
  await ctx.db.delete(schema.users);
  const [user] = await ctx.db
    .insert(schema.users)
    .values({ email: 'admin@example.com', name: 'Admin', username: 'admin', role: 'admin', status: 'active', createdAt: now(), updatedAt: now() })
    .returning();
  userId = user.id;
  vi.mocked(logAuditEvent).mockClear();
});

describe('importing the legacy lists', () => {
  it('copies every listed id into a record once, and only once', async () => {
    await setSetting('waf', { ...BASE_WAF, excluded_rule_ids: [913100, 913100, -1, 'x', 949110] });
    const app = await insertHost('App', ['app.example.com'], { waf: { enabled: true, waf_mode: 'merge', excluded_rule_ids: [941100, 942100] } });
    await insertHost('Plain', ['plain.example.com']);

    expect(await importLegacyWafExclusionsNow()).toBe(4);
    expect((await rows()).map((row) => [row.proxyHostId, row.ruleId, row.path, row.variable, row.reason, row.createdBy])).toEqual([
      [null, 913100, null, null, LEGACY_EXCLUSION_REASON, null],
      [null, 949110, null, null, LEGACY_EXCLUSION_REASON, null],
      [app, 941100, null, null, LEGACY_EXCLUSION_REASON, null],
      [app, 942100, null, null, LEGACY_EXCLUSION_REASON, null],
    ]);
    expect(await importLegacyWafExclusionsNow()).toBe(0);
    expect(await rows()).toHaveLength(4);
    // The lists stay as they were.
    expect((await getSetting<{ excluded_rule_ids: unknown[] }>('waf'))!.excluded_rule_ids).toEqual([913100, 913100, -1, 'x', 949110]);
    expect(((await hostMeta(app))!.waf as { excluded_rule_ids: number[] }).excluded_rule_ids).toEqual([941100, 942100]);
  });

  it('adds nothing when there are no lists', async () => {
    await insertHost('Plain', ['plain.example.com'], { waf: { enabled: true } });
    expect(await importLegacyWafExclusionsNow()).toBe(0);
  });
});

describe('records and their mirror', () => {
  it('mirrors a whole-host exclusion into the host meta without turning the WAF on', async () => {
    const id = await insertHost('App', ['app.example.com']);
    const exclusion = await createWafExclusion({ ruleId: 920420, proxyHostId: id, reason: 'OTel exporters' }, userId);
    expect(exclusion).toMatchObject({
      ruleId: 920420,
      scope: 'host',
      proxyHostId: id,
      host: { id, name: 'App', domains: ['app.example.com'] },
      pathMatch: null,
      reason: 'OTel exporters',
      createdBy: { id: userId, name: 'admin' },
    });
    expect(await hostMeta(id)).toEqual({ waf: { excluded_rule_ids: [920420] } });
    expect((await getProxyHost(id))!.waf).toEqual({ excluded_rule_ids: [920420] });
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'create', entityType: 'waf_exclusion', entityId: exclusion.id, userId }));

    await deleteWafExclusion(exclusion.id, userId);
    expect(await hostMeta(id)).toBeNull();
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'delete', entityType: 'waf_exclusion' }));
  });

  it('keeps path and variable exclusions out of the lists', async () => {
    const id = await insertHost('Wiki', ['wiki.example.com'], { waf: { enabled: true, waf_mode: 'merge' } });
    await createWafExclusion({ ruleId: 942100, proxyHostId: id, path: '/wiki/', variable: 'args:content', reason: 'Runbooks quote SQL' }, userId);
    expect(await hostMeta(id)).toEqual({ waf: { enabled: true, waf_mode: 'merge' } });
    expect((await listWafExclusions({ proxyHostId: id }))[0]).toMatchObject({ path: '/wiki/', pathMatch: 'prefix', variable: 'ARGS:content' });
  });

  it('mirrors global exclusions into the waf setting only when it exists', async () => {
    await createWafExclusion({ ruleId: 913100, reason: 'Scanner checks' }, userId);
    expect(await getSetting('waf')).toBeNull();
    await setSetting('waf', BASE_WAF);
    await createWafExclusion({ ruleId: 920350, reason: 'Numeric host header' }, userId);
    expect((await getSetting<{ excluded_rule_ids: number[] }>('waf'))!.excluded_rule_ids).toEqual([913100, 920350]);
  });

  it('refuses duplicates, unknown hosts and rules that decide blocking', async () => {
    const id = await insertHost('App', ['app.example.com']);
    await createWafExclusion({ ruleId: 942100, proxyHostId: id, path: '/a', reason: 'x' }, userId);
    await expect(createWafExclusion({ ruleId: 942100, proxyHostId: id, path: '/a', pathMatch: 'exact' }, userId)).rejects.toMatchObject({ status: 409 });
    await expect(createWafExclusion({ ruleId: 942100, proxyHostId: 9999 }, userId)).rejects.toMatchObject({ status: 404 });
    await expect(createWafExclusion({ ruleId: 949110 }, userId)).rejects.toMatchObject({ status: 400 });
    await expect(createWafExclusion({ ruleId: 942100, reason: 'a\nb' }, userId)).rejects.toMatchObject({ status: 400 });
    await expect(createWafExclusion({ ruleId: 942100, proxyHostId: '1' }, userId)).rejects.toMatchObject({ status: 400 });
    // A different path is a different exclusion.
    await expect(createWafExclusion({ ruleId: 942100, proxyHostId: id, path: '/b' }, userId)).resolves.toMatchObject({ path: '/b' });
  });

  it('changes the path, variable and reason but never the rule or scope', async () => {
    const id = await insertHost('App', ['app.example.com']);
    const exclusion = await createWafExclusion({ ruleId: 942100, proxyHostId: id, reason: 'x' }, userId);
    const changed = await updateWafExclusion(exclusion.id, { path: '/search', variable: 'ARGS:q', reason: 'Search box' }, userId);
    expect(changed).toMatchObject({ path: '/search', pathMatch: 'exact', variable: 'ARGS:q', reason: 'Search box' });
    // No longer whole-host: it leaves the list.
    expect(await hostMeta(id)).toBeNull();
    await expect(updateWafExclusion(exclusion.id, { ruleId: 1 }, userId)).rejects.toMatchObject({ status: 400 });
    await expect(updateWafExclusion(exclusion.id, { variable: 'TX:score' }, userId)).rejects.toMatchObject({ status: 400 });
    await expect(updateWafExclusion(424242, { reason: 'x' }, userId)).rejects.toMatchObject({ status: 404 });
  });

  it('undoes a change Caddy refuses, and records nothing in the audit log', async () => {
    const id = await insertHost('App', ['app.example.com']);
    const refuse = vi.fn().mockRejectedValueOnce(new Error('Caddy rejected the configuration')).mockResolvedValue(undefined);
    await expect(createWafExclusion({ ruleId: 942100, proxyHostId: id }, userId, { apply: refuse })).rejects.toBeInstanceOf(WafApplyError);
    expect(await rows()).toEqual([]);
    expect(await hostMeta(id)).toBeNull();
    expect(refuse).toHaveBeenCalledTimes(2);
    expect(logAuditEvent).not.toHaveBeenCalled();

    const kept = await createWafExclusion({ ruleId: 942100, proxyHostId: id }, userId);
    await expect(deleteWafExclusion(kept.id, userId, { apply: vi.fn().mockRejectedValue(new Error('down')) })).rejects.toBeInstanceOf(WafApplyError);
    expect(await rows()).toHaveLength(1);
    expect(await hostMeta(id)).toEqual({ waf: { excluded_rule_ids: [942100] } });
  });
});

describe('several exclusions at once', () => {
  it('adds them all with one apply and an audit event each', async () => {
    const id = await insertHost('Langfuse', ['langfuse.example.com']);
    const apply = vi.fn().mockResolvedValue(undefined);
    const created = await createWafExclusions(
      [
        { ruleId: 921150, proxyHostId: id, path: '/api/public/otel/v1/traces', pathMatch: 'exact', variable: 'ARGS_NAMES', reason: 'OTel traces' },
        { ruleId: 932235, proxyHostId: id, path: '/api/public/otel/v1/traces', pathMatch: 'exact', reason: 'OTel traces' },
      ],
      userId,
      { apply }
    );
    expect(created.map((exclusion) => [exclusion.ruleId, exclusion.variable])).toEqual([[921150, 'ARGS_NAMES'], [932235, null]]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(2);
    expect(vi.mocked(logAuditEvent).mock.calls.map(([event]) => event.entityType)).toEqual(['waf_exclusion', 'waf_exclusion']);
  });

  it('adds none when one of them is refused or Caddy refuses them', async () => {
    const id = await insertHost('App', ['app.example.com']);
    await createWafExclusion({ ruleId: 942100, proxyHostId: id, path: '/a', reason: 'x' }, userId);
    await expect(
      createWafExclusions([{ ruleId: 942200, proxyHostId: id, path: '/a' }, { ruleId: 942100, proxyHostId: id, path: '/a' }], userId)
    ).rejects.toMatchObject({ status: 409 });
    await expect(createWafExclusions([{ ruleId: 942200 }, { ruleId: 942200 }], userId)).rejects.toMatchObject({ status: 400 });
    await expect(createWafExclusions([{ ruleId: 942200 }, { ruleId: 949110 }], userId)).rejects.toMatchObject({ status: 400 });
    await expect(createWafExclusions([], userId)).rejects.toMatchObject({ status: 400 });
    await expect(createWafExclusions(Array.from({ length: 51 }, (_, i) => ({ ruleId: 942000 + i })), userId)).rejects.toMatchObject({ status: 400 });
    expect(await rows()).toHaveLength(1);

    vi.mocked(logAuditEvent).mockClear();
    const refuse = vi.fn().mockRejectedValueOnce(new Error('Caddy rejected the configuration')).mockResolvedValue(undefined);
    await expect(createWafExclusions([{ ruleId: 942200, proxyHostId: id }, { ruleId: 942300, proxyHostId: id }], userId, { apply: refuse })).rejects.toBeInstanceOf(
      WafApplyError
    );
    expect(await rows()).toHaveLength(1);
    expect(await hostMeta(id)).toBeNull();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });
});

describe('writes through the legacy lists', () => {
  it('replaces the global whole-scope records with a list and keeps them without one', async () => {
    await setSetting('waf', BASE_WAF);
    await createWafExclusion({ ruleId: 942100, path: '/api/', reason: 'API' }, userId);
    await saveWafSettings({ ...BASE_WAF, excluded_rule_ids: [913100, 920350] }, { actorUserId: userId });
    expect((await rows()).map((row) => [row.ruleId, row.path, row.createdBy])).toEqual([
      [942100, '/api/', userId],
      [913100, null, userId],
      [920350, null, userId],
    ]);

    await saveWafSettings({ ...BASE_WAF, excluded_rule_ids: [920350] });
    expect((await rows()).map((row) => row.ruleId)).toEqual([942100, 920350]);

    // A save without the list (the settings page) keeps the records and writes the list back.
    await saveWafSettings({ ...BASE_WAF, mode: 'DetectionOnly', paranoia_level: 2, inbound_anomaly_threshold: 5 });
    expect((await rows()).map((row) => row.ruleId)).toEqual([942100, 920350]);
    expect(await getSetting('waf')).toEqual({ ...BASE_WAF, mode: 'DetectionOnly', paranoia_level: 2, excluded_rule_ids: [920350] });
  });

  it('keeps a host list and its records in step through the proxy host model', async () => {
    const host = await createProxyHost(
      { name: 'App', domains: ['app.example.com'], upstreams: ['backend:8080'], waf: { enabled: true, waf_mode: 'merge', excluded_rule_ids: [941100, 942100] } },
      userId
    );
    expect((await rows()).map((row) => [row.proxyHostId, row.ruleId])).toEqual([[host.id, 941100], [host.id, 942100]]);

    await createWafExclusion({ ruleId: 930130, proxyHostId: host.id, path: '/.well-known/', reason: 'x' }, userId);
    await updateProxyHost(host.id, { waf: { enabled: true, waf_mode: 'merge', excluded_rule_ids: [942100, 913100] } }, userId);
    expect((await rows()).map((row) => row.ruleId).sort()).toEqual([913100, 930130, 942100]);

    // Turning the WAF off from the host form sends no list: the exclusions stay and the list is written back.
    await updateProxyHost(host.id, { waf: { enabled: false, waf_mode: 'merge' } }, userId);
    expect(await rows()).toHaveLength(3);
    expect((await getProxyHost(host.id))!.waf).toEqual({ enabled: false, waf_mode: 'merge', excluded_rule_ids: [913100, 942100] });

    await deleteProxyHost(host.id, userId);
    expect(await rows()).toEqual([]);
  });

  it('accepts DetectionOnly as a host mode and refuses unknown modes', async () => {
    const host = await createProxyHost({ name: 'App', domains: ['app.example.com'], upstreams: ['backend:8080'] }, userId);
    await updateProxyHost(host.id, { waf: { enabled: true, mode: 'DetectionOnly' } }, userId);
    expect((await getProxyHost(host.id))!.waf).toMatchObject({ mode: 'DetectionOnly' });
    await expect(updateProxyHost(host.id, { waf: { enabled: true, mode: 'Block' as never } }, userId)).rejects.toThrow(/waf.mode must be/);
    await expect(updateProxyHost(host.id, { waf: { enabled: true, excluded_rule_ids: [0] } }, userId)).rejects.toThrow(/excluded_rule_ids/);
  });
});

describe('configuration restore and instance sync', () => {
  it('gives exclusions of content without records (older snapshots) their records', async () => {
    const id = await insertHost('App', ['app.example.com'], { waf: { enabled: true, excluded_rule_ids: [941100] } });
    await setSetting('waf', { ...BASE_WAF, excluded_rule_ids: [913100] });
    const content = await readCurrentConfigContent();
    expect(content.tables.wafRuleExclusions).toEqual([]);
    await ctx.db.transaction(async (tx) => await writeConfigContent(tx as never, content, 'restore'));
    expect((await rows()).map((row) => [row.proxyHostId, row.ruleId])).toEqual([[null, 913100], [id, 941100]]);
  });

  it('restores records with the content and drops those of hosts it does not have', async () => {
    const id = await insertHost('App', ['app.example.com']);
    await createWafExclusion({ ruleId: 942100, proxyHostId: id, variable: 'ARGS:q', reason: 'Search' }, userId);
    await createWafExclusion({ ruleId: 913100, reason: 'Global' }, userId);
    const content = await readCurrentConfigContent();
    expect(content.tables.wafRuleExclusions).toHaveLength(2);
    const withoutHost = { ...content, tables: { ...content.tables, proxyHosts: [] } };
    await ctx.db.transaction(async (tx) => await writeConfigContent(tx as never, withoutHost, 'restore'));
    expect((await rows()).map((row) => row.ruleId)).toEqual([913100]);
  });

  it('sends records without attribution and replaces them on the slave', async () => {
    const id = await insertHost('App', ['app.example.com']);
    await createWafExclusion({ ruleId: 942100, proxyHostId: id, path: '/a', reason: 'x' }, userId);
    const payload = await buildSyncPayload();
    expect(payload.data.wafRuleExclusions).toEqual([expect.objectContaining({ ruleId: 942100, proxyHostId: id, path: '/a', createdBy: null })]);
    expect(isValidSyncPayload(payload)).toBe(true);

    await ctx.db.delete(schema.wafRuleExclusions);
    await ctx.db.insert(schema.wafRuleExclusions).values({ ruleId: 1, reason: '', createdAt: now(), updatedAt: now() });
    await applySyncPayload(payload);
    expect((await rows()).map((row) => [row.ruleId, row.createdBy])).toEqual([[942100, null]]);

    // A payload from an older master has no records: the slave keeps none.
    const { wafRuleExclusions: _ignored, ...olderData } = payload.data;
    void _ignored;
    await applySyncPayload({ ...payload, data: olderData } as SyncPayload);
    expect(await rows()).toEqual([]);
  });

  it('validates synced records and keeps fingerprints of payloads without them unchanged', async () => {
    const payload = await buildSyncPayload();
    expect(isValidSyncPayload({ ...payload, data: { ...payload.data, wafRuleExclusions: [{ id: 1, ruleId: '942100' }] } })).toBe(false);
    const { wafRuleExclusions: _ignored, ...olderData } = payload.data;
    void _ignored;
    expect(canonicalSyncContent({ settings: payload.settings, data: olderData })).toBe(
      canonicalSyncContent({ settings: payload.settings, data: { ...olderData, wafRuleExclusions: [] } })
    );
    expect(normalizeSyncPayload({ ...payload, data: olderData } as SyncPayload).data.wafRuleExclusions).toEqual([]);
  });
});
