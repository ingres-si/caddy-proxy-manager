/**
 * The overview page's data (app/(dashboard)/page.tsx), read for one viewer:
 * what needs attention, the traffic of the chosen range with its headline
 * numbers, the busiest hosts, the nodes, the recent changes and, on a fresh
 * install, the setup checklist.
 *
 * Every section answers only to viewers who may read it (the permission is
 * named next to each) and is left out (null) otherwise; each runs with a
 * time limit and falls back to "no data" instead of failing the page. The
 * same data is available through the REST API: /api/v1/overview/attention,
 * /api/v1/analytics/query and /hosts, /api/v1/certificates/overview,
 * /api/v1/audit-log, /api/v1/fleet and /api/v1/setup-checklist.
 */
import { inArray } from "drizzle-orm";
import { appDb } from "./db";
import { configSnapshots } from "./db/schema";
import { can, scopeTagsFor, type Access } from "./permissions";
import { APP_VERSION, formatVersion } from "./app-version";
import { collectAttention, type AttentionView } from "./attention";
import { cachedTrafficSignals } from "./analytics/signals-cache";
import { parseAnalyticsQuery, queryAnalytics } from "./analytics/query";
import { queryHostSummaries, type HostSummary } from "./analytics/hosts";
import { resolveRange } from "./analytics/range";
import { allProxyHostDomains } from "./analytics/service";
import { normalizeDomain } from "./analytics/scope";
import type { TrafficSignals } from "./analytics/signals";
import { listProxyHosts, type ProxyHost } from "./models/proxy-hosts";
import { queryAuditEvents } from "./models/audit";
import { buildCertificateOverview } from "./certificate-overview";
import { getCaddyApplyStatus } from "./caddy-apply-status";
import { getInstanceMode } from "./instance-sync";
import { getSetupChecklist } from "./setup-checklist";
import { listFleetInstances } from "@/ee/fleet/environments";
import type { FleetInstanceView } from "@/ee/fleet/types";
import {
  HOST_BAD_ERROR_RATE,
  HOST_WARN_ERROR_RATE,
  parseOverviewRange,
  type OverviewChange,
  type OverviewData,
  type OverviewFirstRun,
  type OverviewHostRow,
  type OverviewHosts,
  type OverviewNode,
  type OverviewNodes,
  type OverviewPermissions,
  type OverviewRange,
  type OverviewTone,
  type OverviewTraffic,
} from "./overview-shared";

export * from "./overview-shared";

/** Busiest hosts listed. */
export const BUSIEST_HOSTS = 6;
/** Recent changes listed. */
export const RECENT_CHANGES = 6;
/** Replicas listed in the nodes card. */
export const NODES_SHOWN = 5;
/** Time limits of the sections, in ms. */
export const ATTENTION_TIMEOUT_MS = 3_000;
export const SECTION_TIMEOUT_MS = 8_000;
/** How long the certificate column waits for TLS checks that are not cached yet. */
const CERTIFICATE_WAIT_MS = 300;

/** Hosts need at least this many 5xx before their rate colours the dot. */
const HOST_MIN_ERRORS = 10;
/** Days of certificate left under which a host's dot turns amber, and red. */
const CERT_WARN_DAYS = 14;
const CERT_BAD_DAYS = 7;

/** `work()`, or `fallback` when it throws or takes longer than `ms`. */
async function within<T>(work: () => Promise<T>, fallback: T, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function overviewPermissions(access: Access): OverviewPermissions {
  return {
    createProxyHost: can(access, "proxy_hosts:write"),
    readProxyHosts: can(access, "proxy_hosts:read"),
    readAnalytics: can(access, "analytics:read"),
    readSecurity: can(access, "waf:read"),
    readAlerts: can(access, "alerts:read"),
    writeAlerts: can(access, "alerts:write"),
    readAuditLog: can(access, "audit_log:read"),
    readUsers: can(access, "users:read"),
    readSso: can(access, "sso:read"),
    writeSettings: can(access, "settings:write"),
  };
}

// ── Traffic ──────────────────────────────────────────────────────────────

function emptyTraffic(range: OverviewRange, nowSeconds: number, status: OverviewTraffic["status"]): OverviewTraffic {
  const resolved = resolveRange({ range }, nowSeconds);
  const zeros = () => new Array<number>(resolved.buckets).fill(0);
  return {
    status,
    range: { preset: resolved.preset, start: resolved.start, end: resolved.end, step: resolved.step, buckets: resolved.buckets },
    served: zeros(),
    mitigated: zeros(),
    totals: { requests: 0, mitigated: 0, mitigatedShare: 0, errors5xx: 0, errorRate5xx: 0, bytes: 0 },
    previous: null,
    sparklines: { requests: zeros(), mitigated: zeros(), errors5xx: zeros(), bytes: zeros() },
    peakMitigated: null,
    topErrorHost: null,
  };
}

/** Served and mitigated requests per bucket, and the headline numbers, of `range` (analytics:read). */
export async function loadTraffic(range: OverviewRange, nowSeconds: number): Promise<OverviewTraffic> {
  const query = parseAnalyticsQuery({ range, metric: "requests", groupBy: "none" }, nowSeconds);
  const result = await queryAnalytics(query, nowSeconds);
  const series = result.headlineSeries;
  const { headline } = result;
  return {
    status: result.status,
    range: result.range,
    served: series.requests.map((value, i) => Math.max(0, value - (series.mitigated[i] ?? 0))),
    mitigated: series.mitigated.slice(),
    totals: {
      requests: headline.requests.value,
      mitigated: headline.mitigated.value,
      mitigatedShare: headline.mitigated.share,
      errors5xx: headline.errorRate5xx.count,
      errorRate5xx: headline.errorRate5xx.value,
      bytes: headline.bytes.value,
    },
    previous:
      result.previous.available && headline.requests.previous !== null
        ? {
            requests: headline.requests.previous,
            errorRate5xx: headline.errorRate5xx.previous ?? 0,
            bytes: headline.bytes.previous ?? 0,
            mitigated: headline.mitigated.previous ?? 0,
          }
        : null,
    sparklines: { requests: series.requests, mitigated: series.mitigated, errors5xx: series.errors5xx, bytes: series.bytes },
    peakMitigated: result.peakMitigated,
    topErrorHost: null,
  };
}

// ── Busiest hosts ────────────────────────────────────────────────────────

function hostLabel(host: Pick<ProxyHost, "name" | "domains">): string {
  return host.domains[0] ?? host.name;
}

/** Whole days of certificate left per proxy host id (the earliest expiry among the certificates it uses). */
async function certificateDaysByHost(access: Access, now: number): Promise<Map<number, number>> {
  const overview = await buildCertificateOverview(access, { now, waitMs: CERTIFICATE_WAIT_MS });
  const days = new Map<number, number>();
  for (const row of overview.certificates) {
    if (row.daysLeft === null || !row.active) continue;
    for (const user of row.usedBy) {
      if (user.kind !== "proxy_host") continue;
      const known = days.get(user.id);
      if (known === undefined || row.daysLeft < known) days.set(user.id, row.daysLeft);
    }
  }
  return days;
}

/** The dot of a host: disabled, then certificates and errors, worst first. */
export function hostTone(input: {
  enabled: boolean;
  errors5xx: number;
  errorRate5xx: number;
  certificateDaysLeft: number | null;
  burst: { ongoing: boolean } | null;
}): { tone: OverviewTone; label: string } {
  if (!input.enabled) return { tone: "off", label: "Disabled" };
  const days = input.certificateDaysLeft;
  if (days !== null && days < 0) return { tone: "bad", label: "Certificate expired" };
  if (input.burst?.ongoing) return { tone: "bad", label: "Answering with server errors now" };
  if (input.errors5xx >= HOST_MIN_ERRORS && input.errorRate5xx >= HOST_BAD_ERROR_RATE) return { tone: "bad", label: "Many server errors" };
  if (days !== null && days < CERT_BAD_DAYS) return { tone: "bad", label: "Certificate expires within a week" };
  if (input.burst) return { tone: "warn", label: "Had a burst of server errors" };
  if (input.errors5xx >= HOST_MIN_ERRORS && input.errorRate5xx >= HOST_WARN_ERROR_RATE) return { tone: "warn", label: "Some server errors" };
  if (days !== null && days < CERT_WARN_DAYS) return { tone: "warn", label: "Certificate expires within two weeks" };
  return { tone: "ok", label: "No issues" };
}

/**
 * The busiest proxy hosts the viewer sees (analytics:read; the role's tag
 * scope applies), with their traffic in `range` and, for
 * readers of certificates, the days left of their certificate.
 */
export async function loadBusiestHosts(
  access: Access,
  range: OverviewRange,
  now: Date,
  signals: TrafficSignals | null
): Promise<{ hosts: OverviewHosts; topErrorHost: OverviewTraffic["topErrorHost"] }> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const hosts = await listProxyHosts(scopeTagsFor(access, "proxy_hosts"));
  const resolved = resolveRange({ range }, nowSeconds);
  const showCertificates = can(access, "certificates:read");
  const [summaries, certificateDays] = await Promise.all([
    queryHostSummaries({
      range: resolved,
      hosts: hosts.map((host) => ({ id: host.id, domains: host.domains.map(normalizeDomain).filter(Boolean) })),
      allHosts: await allProxyHostDomains(),
    }),
    showCertificates
      ? within(() => certificateDaysByHost(access, now.getTime()), new Map<number, number>(), SECTION_TIMEOUT_MS)
      : Promise.resolve(new Map<number, number>()),
  ]);
  const byId = new Map(hosts.map((host) => [host.id, host]));
  const bursts = new Map<number, { status: number; start: number; ongoing: boolean }>();
  for (const burst of signals?.errorBursts ?? []) {
    if (burst.proxyHostId === null || bursts.has(burst.proxyHostId)) continue;
    bursts.set(burst.proxyHostId, { status: burst.status, start: burst.start, ongoing: burst.ongoing });
  }
  const ranked = summaries.hosts
    .filter((summary) => byId.has(summary.proxyHostId))
    .sort((a, b) => {
      const ha = byId.get(a.proxyHostId)!;
      const hb = byId.get(b.proxyHostId)!;
      return (
        b.requests - a.requests ||
        b.errors5xx - a.errors5xx ||
        Number(hb.enabled) - Number(ha.enabled) ||
        hostLabel(ha).localeCompare(hostLabel(hb))
      );
    });
  const busiest = ranked.slice(0, BUSIEST_HOSTS);
  const max = Math.max(0, ...busiest.map((summary) => summary.requests));
  const readHosts = can(access, "proxy_hosts:read");
  const rows: OverviewHostRow[] = busiest.map((summary: HostSummary) => {
    const host = byId.get(summary.proxyHostId)!;
    const certificateDaysLeft = showCertificates ? certificateDays.get(host.id) ?? null : null;
    const burst = bursts.get(host.id) ?? null;
    const status = hostTone({ enabled: host.enabled, errors5xx: summary.errors5xx, errorRate5xx: summary.errorRate5xx, certificateDaysLeft, burst });
    return {
      id: host.id,
      label: hostLabel(host),
      name: host.name,
      enabled: host.enabled,
      href: readHosts ? `/proxy-hosts/${host.id}` : null,
      requests: summary.requests,
      share: max > 0 ? summary.requests / max : 0,
      errors5xx: summary.errors5xx,
      errorRate5xx: summary.errorRate5xx,
      mitigated: summary.mitigated,
      certificateDaysLeft,
      tone: status.tone,
      toneLabel: status.label,
      burst,
    };
  });
  const worst = summaries.hosts.reduce<HostSummary | null>((top, summary) => (summary.errors5xx > (top?.errors5xx ?? 0) ? summary : top), null);
  const worstHost = worst ? byId.get(worst.proxyHostId) : undefined;
  return {
    hosts: { status: summaries.status, total: hosts.length, rows, certificates: showCertificates },
    topErrorHost: worst && worstHost ? { name: hostLabel(worstHost), count: worst.errors5xx } : null,
  };
}

// ── Nodes ────────────────────────────────────────────────────────────────

/** How a replica is doing, as the master knows it. */
export function replicaNode(instance: FleetInstanceView, appVersion: string = APP_VERSION): OverviewNode {
  const version = instance.drift.reportedVersion;
  const base = {
    key: `instance:${instance.id}`,
    name: instance.name,
    version: version ? formatVersion(version) : null,
    versionDiffers: Boolean(version && appVersion !== "unknown" && version !== appVersion),
  };
  if (instance.pull) {
    if (instance.pull.checkIn === "never") return { ...base, detail: "Pull replica · never checked in", at: null, tone: "off" };
    if (instance.pull.checkIn === "missed") return { ...base, detail: "Pull replica · stopped checking in", at: instance.pull.lastSeenAt, tone: "bad" };
    if (instance.lastSyncError) return { ...base, detail: "Pull replica · last sync failed", at: instance.lastSyncAt, tone: "warn" };
    return { ...base, detail: "Pull replica · checking in", at: instance.pull.lastSeenAt, tone: base.versionDiffers ? "warn" : "ok" };
  }
  if (instance.drift.status === "unreachable") return { ...base, detail: "Replica · unreachable", at: instance.drift.checkedAt, tone: "bad" };
  if (instance.lastSyncError) return { ...base, detail: "Replica · last sync failed", at: instance.lastSyncAt, tone: "warn" };
  if (instance.drift.status === "drifted") return { ...base, detail: "Replica · drifted", at: instance.drift.since, tone: "warn" };
  if (instance.drift.status === "in_sync") return { ...base, detail: "Replica · in sync", at: null, tone: base.versionDiffers ? "warn" : "ok" };
  if (instance.lastSyncAt) return { ...base, detail: "Replica · synced", at: instance.lastSyncAt, tone: base.versionDiffers ? "warn" : "ok" };
  return { ...base, detail: "Replica · not synced yet", at: null, tone: "off" };
}

/** This server and, on a master, its replicas (fleet:read or instances:read). */
export async function loadNodes(access: Access): Promise<OverviewNodes> {
  const mode = await getInstanceMode();
  const apply = await getCaddyApplyStatus();
  const replicas = mode === "master" ? (await listFleetInstances()).filter((instance) => instance.enabled) : [];
  const role = mode === "master" ? `Master · ${replicas.length} ${replicas.length === 1 ? "replica" : "replicas"}` : mode === "slave" ? "Replica · follows its master" : "Standalone";
  const self: OverviewNode = {
    key: "self",
    name: "This server",
    detail: apply && !apply.ok ? `${role} · Caddy apply failed` : role,
    at: null,
    version: APP_VERSION === "unknown" ? null : formatVersion(APP_VERSION),
    versionDiffers: false,
    tone: apply && !apply.ok ? "bad" : "ok",
  };
  const rank: Record<OverviewTone, number> = { bad: 0, warn: 1, off: 2, info: 3, ok: 4 };
  const nodes = replicas.map((instance) => replicaNode(instance)).sort((a, b) => rank[a.tone] - rank[b.tone] || a.name.localeCompare(b.name));
  const link = can(access, "fleet:read")
    ? { label: "Fleet", href: "/fleet" }
    : can(access, "instances:read") && can(access, "settings:read")
      ? { label: "Instance sync", href: "/instances" }
      : null;
  return { mode, nodes: [self, ...nodes.slice(0, NODES_SHOWN)], more: Math.max(0, nodes.length - NODES_SHOWN), link };
}

// ── Recent changes ───────────────────────────────────────────────────────

/** Whether the viewer may roll the configuration back from the overview (History's restore). */
async function mayRollBack(access: Access): Promise<boolean> {
  if (!can(access, "config_history:restore")) return false;
  return (await getInstanceMode()) !== "slave";
}

/** The latest audit events (audit_log:read), with roll-back links where history allows. */
export async function loadRecentChanges(access: Access): Promise<OverviewChange[]> {
  const records = await queryAuditEvents({}, { limit: RECENT_CHANGES, offset: 0 });
  const candidates = records
    .map((record) => record.configChange)
    .filter((change): change is NonNullable<typeof change> => change !== null && change.beforeId !== null && change.afterId !== null && change.afterId !== change.beforeId)
    .map((change) => change.beforeId as number);
  const kept = new Set<number>();
  if (candidates.length > 0 && (await mayRollBack(access))) {
    const rows = await appDb.select({ id: configSnapshots.id }).from(configSnapshots).where(inArray(configSnapshots.id, [...new Set(candidates)]));
    for (const row of rows) kept.add(row.id);
  }
  return records.map((record) => {
    const change = record.configChange;
    const before = change && change.beforeId !== null && change.afterId !== null && change.afterId !== change.beforeId ? change.beforeId : null;
    const who = record.user ? record.user.name || record.user.email || `User ${record.user.id}` : record.userId === null ? null : "A deleted user";
    return {
      id: record.id,
      who,
      summary: record.summary ?? `${record.action} on ${record.entityType}`,
      at: record.createdAt,
      rollbackHref: before !== null && kept.has(before) ? `/history?version=${before}` : null,
    };
  });
}

// ── Setup ────────────────────────────────────────────────────────────────

/** The setup checklist while the install is fresh: settings:read, not complete, not hidden. */
export async function loadFirstRun(access: Access): Promise<OverviewFirstRun | null> {
  if (!can(access, "settings:read")) return null;
  const checklist = await getSetupChecklist();
  if (checklist.complete || checklist.dismissed) return null;
  return { checklist };
}

// ── The page ─────────────────────────────────────────────────────────────

function emptyAttention(now: Date): AttentionView {
  return { generatedAt: now.toISOString(), items: [], truncated: false, counts: { critical: 0, warning: 0, info: 0 }, sources: [], notifying: null };
}

export async function loadOverview(
  access: Access,
  input: { range?: unknown; userName: string; now?: Date }
): Promise<OverviewData> {
  const now = input.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const range = parseOverviewRange(input.range);
  const readAnalytics = can(access, "analytics:read");

  const signals = readAnalytics ? within(() => cachedTrafficSignals(now.getTime()), null, SECTION_TIMEOUT_MS) : Promise.resolve(null);
  const [attention, traffic, busiest, nodes, changes, firstRun] = await Promise.all([
    within(() => collectAttention(access, { now, timeoutMs: ATTENTION_TIMEOUT_MS }), emptyAttention(now), ATTENTION_TIMEOUT_MS + 1_000),
    readAnalytics
      ? within(() => loadTraffic(range, nowSeconds), emptyTraffic(range, nowSeconds, "unavailable"), SECTION_TIMEOUT_MS)
      : Promise.resolve(null),
    readAnalytics
      ? within(
          async () => loadBusiestHosts(access, range, now, await signals),
          { hosts: { status: "unavailable" as const, total: 0, rows: [], certificates: false }, topErrorHost: null },
          SECTION_TIMEOUT_MS
        )
      : Promise.resolve(null),
    can(access, "fleet:read") || can(access, "instances:read") ? within(() => loadNodes(access), null, SECTION_TIMEOUT_MS) : Promise.resolve(null),
    can(access, "audit_log:read") ? within(() => loadRecentChanges(access), [], SECTION_TIMEOUT_MS) : Promise.resolve(null),
    within(() => loadFirstRun(access), null, SECTION_TIMEOUT_MS),
  ]);

  return {
    generatedAt: now.toISOString(),
    range,
    userName: input.userName,
    version: APP_VERSION,
    permissions: overviewPermissions(access),
    firstRun,
    attention,
    traffic: traffic ? { ...traffic, topErrorHost: busiest?.topErrorHost ?? null } : null,
    hosts: busiest?.hosts ?? null,
    nodes,
    changes,
  };
}
