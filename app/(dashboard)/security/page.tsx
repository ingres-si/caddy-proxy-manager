export const dynamic = "force-dynamic";

import { cdnAddresses } from "@/src/lib/cdn-ranges";
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { ApiValidationError } from "@/src/lib/api-errors";
import { isAnalyticsEnabled } from "@/src/lib/clickhouse/client";
import { getRateLimitSettings, getWafSettings } from "@/src/lib/settings";
import { listProxyHosts } from "@/src/lib/models/proxy-hosts";
import { getBlockedSourcesList, type AccessList } from "@/src/lib/models/access-lists";
import { countWafExclusionsByScope } from "@/src/lib/models/waf-exclusions";
import { wafHostView } from "@/src/lib/waf-hosts";
import { OWASP_CRS_VERSION, resolveWafTuning } from "@/src/lib/waf-tuning";
import { resolveEffectiveRateLimitRules } from "@/src/lib/caddy-rate-limit";
import { buildAddressRuleList, inAddressRules } from "@/src/lib/analytics/address-rules";
import { resolveRange, type ResolvedRange } from "@/src/lib/analytics/range";
import { MAX_REQUEST_OFFSET } from "@/src/lib/analytics/requests";
import {
  parseEventKinds,
  parseSecurityEventFilters,
  querySecurityEvents,
  querySecurityHosts,
  querySecurityRules,
  querySecuritySeries,
  querySecuritySources,
  type SecurityEventKind,
} from "@/src/lib/analytics/security";
import type { AnalyticsFilter } from "@/src/lib/analytics/filters";
import type { AnalyticsStatus } from "@/src/lib/analytics/run";
import { allProxyHostDomains } from "@/src/lib/analytics/service";
import { proxyHostForName } from "@/src/lib/analytics/scope";
import { formatBucketTime } from "@/components/ui/chart-format";
import { getAiSettingsView } from "@/ee/ai/settings";
import { listOpenSuggestions } from "@/ee/ai/waf-tuning";
import SecurityClient from "./SecurityClient";
import type { SecurityPageData, SecurityRange } from "./security-types";
import { SECURITY_SOURCES, isSecuritySource, readFilters, ruleCategory, type SecurityQuery, type SecuritySourceKey } from "./security-view";

export const metadata = { title: "Security events" };

const PER_PAGE = 50;
const MAX_PAGE = Math.floor(MAX_REQUEST_OFFSET / PER_PAGE) + 1;
const TOP_LIMIT = 8;

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const PRESET_LABELS: Record<string, { label: string; previous: string }> = {
  "1h": { label: "last hour", previous: "the hour before" },
  "24h": { label: "last 24 hours", previous: "the 24 hours before" },
  "7d": { label: "last 7 days", previous: "the week before" },
  "30d": { label: "last 30 days", previous: "the 30 days before" },
};

function rangeView(range: ResolvedRange): SecurityRange {
  const preset = PRESET_LABELS[range.preset];
  const custom = `${formatBucketTime(range.start * 1000, range.step, true)} to ${formatBucketTime(range.end * 1000, range.step, true)} UTC`;
  return {
    preset: range.preset,
    start: range.start,
    end: range.end,
    step: range.step,
    buckets: range.buckets,
    label: preset?.label ?? custom,
    previousLabel: preset?.previous ?? "the period before",
  };
}

/** The worst status of the queries: disabled, then unavailable, then ok. */
function combinedStatus(statuses: AnalyticsStatus[]): AnalyticsStatus {
  if (statuses.includes("disabled")) return "disabled";
  if (statuses.includes("unavailable")) return "unavailable";
  return "ok";
}

/** The addresses among `ips` that an unexpired deny entry of the Blocked sources list covers. */
function blockedAddresses(list: AccessList | null, ips: readonly string[]): string[] {
  if (!list) return [];
  const values = list.rules.filter((rule) => rule.action === "deny" && rule.kind === "ip" && !rule.expired).flatMap((rule) => rule.values);
  if (values.length === 0) return [];
  const blockList = buildAddressRuleList([{ block_ips: values }]);
  return [...new Set(ips)].filter((ip) => inAddressRules(blockList, ip));
}

/**
 * Security events: what the WAF, geo rules, access lists, sign-in and rate
 * limits stopped over a range, the rules and addresses behind it, and every
 * event with why it was stopped. Reading needs waf:read; adding an exclusion
 * needs waf:write and blocking an address access_lists:write (each checked
 * again by its server action).
 */
export default async function SecurityEventsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { access } = await requirePermission("waf:read");
  const params = await searchParams;
  const now = Math.floor(Date.now() / 1000);

  // The URL is user input: an invalid range or filter is reported and left out, never an error page.
  let range: ResolvedRange;
  let rangeError: string | null = null;
  try {
    range = resolveRange({ range: first(params.range), from: first(params.from), to: first(params.to) }, now, "7d");
  } catch (error) {
    if (!(error instanceof ApiValidationError)) throw error;
    rangeError = error.message;
    range = resolveRange({}, now, "7d");
  }

  let kinds: SecurityEventKind[] = [...SECURITY_SOURCES];
  let filters: AnalyticsFilter[] = [];
  let filterError: string | null = null;
  try {
    kinds = parseEventKinds(first(params.kind));
  } catch (error) {
    if (!(error instanceof ApiValidationError)) throw error;
    filterError = error.message;
  }
  try {
    filters = parseSecurityEventFilters(first(params.filters));
  } catch (error) {
    if (!(error instanceof ApiValidationError)) throw error;
    filterError = error.message;
  }
  const page = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(first(params.page) ?? "1", 10) || 1));

  const allDomains = await allProxyHostDomains();
  const canReadAccessLists = can(access, "access_lists:read");

  const [series, rules, sources, hosts, events, wafSettings, proxyHosts, exclusionCounts, rateLimit, blockedList, suggestions, ai] =
    await Promise.all([
      querySecuritySeries({ range }, now),
      querySecurityRules({ range, limit: TOP_LIMIT }),
      querySecuritySources({ range, limit: TOP_LIMIT }),
      querySecurityHosts({ range, limit: 3 }, allDomains),
      querySecurityEvents({ range, kinds, filters, limit: PER_PAGE + 1, offset: (page - 1) * PER_PAGE }),
      getWafSettings(),
      listProxyHosts(),
      countWafExclusionsByScope(),
      getRateLimitSettings(),
      canReadAccessLists ? getBlockedSourcesList().catch(() => null) : Promise.resolve(null),
      listOpenSuggestions(),
      getAiSettingsView(),
    ]);

  // Rule set: what the WAF settings add up to on the enabled hosts.
  const tuning = resolveWafTuning(wafSettings);
  const views = proxyHosts.filter((host) => host.enabled).map((host) => wafHostView(host, wafSettings, exclusionCounts.get(host.id) ?? 0));
  const using = views.filter((view) => view.effectiveMode !== "off");

  const bySource = Object.fromEntries(SECURITY_SOURCES.map((key) => [key, 0])) as Record<SecuritySourceKey, number>;
  const chartSeries: SecurityPageData["series"] = [];
  for (const entry of series.series) {
    if (!isSecuritySource(entry.key)) continue;
    bySource[entry.key] = entry.total;
    chartSeries.push({ key: entry.key, values: entry.values });
  }

  const eventList = events.events.slice(0, PER_PAGE);
  const shownIps = [...sources.sources.map((source) => source.ip), ...eventList.map((event) => event.ip)];
  const custom = !rangeError && range.preset === "custom";

  const query: SecurityQuery = {
    range: rangeError ? null : first(params.range) || (custom ? "custom" : null),
    from: custom ? Number(first(params.from)) : null,
    to: custom ? Number(first(params.to)) : null,
    kind: first(params.kind) || null,
    filters: readFilters(first(params.filters)),
    page,
  };

  const blockDisabledReason = !can(access, "access_lists:write") ? "Blocking an address needs the access_lists:write permission." : null;

  const data: SecurityPageData = {
    now,
    query,
    range: rangeView(range),
    rangeError,
    status: combinedStatus([series.status, rules.status, sources.status, hosts.status, events.status]),
    ruleSet: {
      crsLoaded: using.length > 0 ? using.some((view) => view.loadOwaspCrs) : Boolean(wafSettings?.load_owasp_crs),
      crsVersion: OWASP_CRS_VERSION,
      paranoiaLevel: tuning.paranoiaLevel,
      inboundThreshold: tuning.inboundThreshold,
      blocking: views.filter((view) => view.effectiveMode === "block").length,
      detecting: views.filter((view) => view.effectiveMode === "detection_only").length,
      hosts: views.length,
      exclusions: [...exclusionCounts.values()].reduce((sum, count) => sum + count, 0),
    },
    summary: {
      mitigated: series.totals.mitigated,
      requests: series.totals.requests,
      share: series.totals.share,
      previousMitigated: series.totals.previousMitigated,
      bySource,
    },
    series: chartSeries,
    peak: series.peak,
    rules: {
      matched: rules.totals.rulesMatched,
      events: rules.totals.events,
      list: rules.rules.map((rule) => ({
        ...rule,
        category: ruleCategory(rule.ruleId),
        // Matched on one host only: the exclusion dialog opens limited to it.
        exclusionHostId: rule.hostCount === 1 && rule.hosts[0] ? proxyHostForName(rule.hosts[0].host, allDomains) : null,
      })),
    },
    sources: { total: sources.totals.addresses, list: sources.sources },
    hosts: { total: hosts.totals.events, list: hosts.hosts },
    events: {
      list: eventList,
      page,
      perPage: PER_PAGE,
      hasMore: events.events.length > PER_PAGE && page < MAX_PAGE,
      filterError,
    },
    blockedIps: blockedAddresses(blockedList, shownIps),
    cdnIps: cdnAddresses(shownIps),
    exclusionHosts: proxyHosts.map((host) => ({ id: host.id, name: host.name, domains: host.domains })),
    eventHostIds: Object.fromEntries(
      [...new Set(eventList.filter((event) => event.kind === "waf").map((event) => event.host))].flatMap((name) => {
        const id = proxyHostForName(name, allDomains);
        return id === null ? [] : [[name, id] as const];
      })
    ),
    rateLimitInUse:
      bySource.rate_limit > 0 || proxyHosts.some((host) => host.enabled && resolveEffectiveRateLimitRules(rateLimit, host.rateLimit).length > 0),
    permissions: {
      canWriteWaf: can(access, "waf:write"),
      blockDisabledReason,
      canReadAnalytics: can(access, "analytics:read"),
      canReadSettings: can(access, "settings:read"),
    },
    tuning: {
      suggestions,
      analyticsEnabled: isAnalyticsEnabled(),
      aiConfigured: ai.configured,
    },
  };

  return <SecurityClient data={data} />;
}
