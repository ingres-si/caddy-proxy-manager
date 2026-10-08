/**
 * Everything a proxy host's page shows for one reader: its list row (status,
 * protections, certificate), a summary of each editor section, traffic of
 * the last 24 hours (analytics:read), the error-rate alert threshold that
 * watches it (alerts:read), its upstreams' health from Caddy, and its recent
 * changes with diffs (audit_log:read). The caller has already checked that
 * the reader may see the host.
 */
import { can, type Access } from "./permissions";
import type { ProxyHost } from "./models/proxy-hosts";
import { queryAuditEvents, countAuditEventsMatching } from "./models/audit";
import { queryHostDetail, type HostDetailResult } from "./analytics/hosts";
import { allProxyHostDomains } from "./analytics/service";
import { resolveRange } from "./analytics/range";
import { normalizeDomain } from "./analytics/scope";
import type { AnalyticsStatus } from "./analytics/run";
import { isAnalyticsEnabled } from "./clickhouse/client";
import { getProxyHostHealth, type ProxyHostHealth } from "./upstream-health";
import { loadHostInsights } from "./proxy-host-insights";
import { hostConfigSummaries, type HostConfigSummary } from "./proxy-host-config-summary";
import type { HostListRow } from "./proxy-host-view";
import { auditEventConfigDiff } from "@/ee/config-history/versions";
import { listEnabledRules } from "@/ee/alerting/rules";
import type { ErrorRateParams } from "@/ee/alerting/types";

export type HostTrafficDetail = {
  status: AnalyticsStatus;
  range: { start: number; end: number; step: number; buckets: number };
  totals: HostDetailResult["totals"];
  series: { requests: number[]; errors5xx: number[]; mitigated: number[] };
  topPaths: HostDetailResult["topPaths"];
  statusCodes: HostDetailResult["statusCodes"];
};

export type HostChangeField = { path: string; before?: unknown; after?: unknown; secret?: boolean };

export type HostChangeEntry = {
  id: number;
  action: string;
  summary: string;
  /** Who made it; null for the system. */
  actor: string | null;
  createdAt: string;
  /** The fields it changed, from the configuration history; null when history has no versions for it. */
  fields: HostChangeField[] | null;
  /** Changed fields not listed. */
  moreFields: number;
  /** The version before the change, to roll back to; null without one or without config_history:restore. */
  rollbackVersionId: number | null;
};

export type HostDetail = {
  row: HostListRow;
  config: HostConfigSummary[];
  /** null when the reader may not read analytics. */
  traffic: HostTrafficDetail | null;
  /** The lowest per-host error-rate alert threshold covering the host, in percent. */
  errorRateAlert: { thresholdPercent: number; ruleName: string } | null;
  health: ProxyHostHealth;
  /** null when the reader may not read the audit log. */
  changes: { total: number; entries: HostChangeEntry[] } | null;
};

const CHANGES_SHOWN = 5;
const CHANGES_WITH_DIFFS = 3;
const FIELDS_SHOWN = 8;

async function loadTraffic(access: Access, host: ProxyHost, now: number): Promise<HostTrafficDetail | null> {
  if (!can(access, "analytics:read")) return null;
  const range = resolveRange({ range: "24h" }, Math.floor(now / 1000));
  if (!isAnalyticsEnabled()) {
    const zeros = new Array<number>(range.buckets).fill(0);
    return {
      status: "disabled",
      range: { start: range.start, end: range.end, step: range.step, buckets: range.buckets },
      totals: { requests: 0, errors5xx: 0, errorRate5xx: 0, mitigated: 0, bytes: 0, clients: 0 },
      series: { requests: zeros, errors5xx: zeros, mitigated: zeros },
      topPaths: [],
      statusCodes: [],
    };
  }
  const detail = await queryHostDetail({
    range,
    host: { id: host.id, domains: host.domains.map(normalizeDomain).filter(Boolean) },
    allHosts: await allProxyHostDomains(),
  });
  return {
    status: detail.status,
    range: { start: detail.range.start, end: detail.range.end, step: detail.range.step, buckets: detail.range.buckets },
    totals: detail.totals,
    series: { requests: detail.series.requests, errors5xx: detail.series.errors5xx, mitigated: detail.series.mitigated },
    topPaths: detail.topPaths,
    statusCodes: detail.statusCodes,
  };
}

async function loadErrorRateAlert(access: Access, hostId: number): Promise<HostDetail["errorRateAlert"]> {
  if (!can(access, "alerts:read")) return null;
  try {
    let best: HostDetail["errorRateAlert"] = null;
    for (const rule of await listEnabledRules()) {
      if (rule.type !== "error_rate") continue;
      const params = rule.params as ErrorRateParams;
      if (!params.perHost) continue;
      if (rule.scope.type === "hosts" && !rule.scope.proxyHostIds.includes(hostId)) continue;
      if (!best || params.thresholdPercent < best.thresholdPercent) best = { thresholdPercent: params.thresholdPercent, ruleName: rule.name };
    }
    return best;
  } catch {
    return null;
  }
}

function actorName(user: { name: string | null; email: string | null } | null, userId: number | null): string | null {
  if (user) return user.name || user.email || `User #${userId}`;
  return userId !== null ? `Deleted user #${userId}` : null;
}

/** A host's recent changes from the audit log, the latest with their diffs; null without audit_log:read. */
export async function loadHostChanges(
  access: Access,
  entityType: "proxy_host" | "l4_proxy_host",
  hostId: number
): Promise<HostDetail["changes"]> {
  if (!can(access, "audit_log:read")) return null;
  const filter = { entityType, entityId: hostId };
  const [events, total] = await Promise.all([queryAuditEvents(filter, { limit: CHANGES_SHOWN, offset: 0 }), countAuditEventsMatching(filter)]);
  const canRollBack = can(access, "config_history:restore");
  const entries = await Promise.all(
    events.map(async (event, index): Promise<HostChangeEntry> => {
      let fields: HostChangeField[] | null = null;
      let moreFields = 0;
      const change = event.configChange;
      if (index < CHANGES_WITH_DIFFS && change && change.beforeId !== null && change.afterId !== null) {
        try {
          const diff = await auditEventConfigDiff({
            action: event.action,
            entityType: event.entityType,
            entityId: event.entityId,
            configBeforeId: change.beforeId,
            configAfterId: change.afterId,
          });
          if (diff?.available) {
            const all = diff.groups.flatMap((group) =>
              group.fields.map((field) => ({
                path: field.path,
                before: field.beforeLabel ?? field.before,
                after: field.afterLabel ?? field.after,
                ...(field.secret ? { secret: true } : {}),
              }))
            );
            fields = all.slice(0, FIELDS_SHOWN);
            moreFields = Math.max(0, all.length - FIELDS_SHOWN);
          }
        } catch {
          // The versions could not be read: the entry shows without its diff.
        }
      }
      return {
        id: event.id,
        action: event.action,
        summary: event.summary ?? `${event.action} on ${event.entityType}`,
        actor: actorName(event.user, event.userId),
        createdAt: event.createdAt,
        fields,
        moreFields,
        rollbackVersionId: canRollBack && change && change.beforeId !== null && !change.pending ? change.beforeId : null,
      };
    })
  );
  return { total, entries };
}

export async function loadHostDetail(
  access: Access,
  host: ProxyHost,
  options: { accessListNames?: ReadonlyMap<number, string>; now?: number } = {}
): Promise<HostDetail> {
  const now = options.now ?? Date.now();
  const [insights, traffic, errorRateAlert, health, changes] = await Promise.all([
    loadHostInsights(access, [host], { accessListNames: options.accessListNames, now }),
    loadTraffic(access, host, now).catch((): HostTrafficDetail | null => null),
    loadErrorRateAlert(access, host.id),
    getProxyHostHealth(host),
    loadHostChanges(access, "proxy_host", host.id).catch(() => ({ total: 0, entries: [] })),
  ]);
  const row = insights.rows[0];
  const input = insights.inputs.get(host.id)!;
  return {
    row,
    config: hostConfigSummaries(host, input, row.certificate),
    traffic,
    errorRateAlert,
    health,
    changes,
  };
}
