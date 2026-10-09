// SPDX-License-Identifier: Elastic-2.0
/**
 * Plain-language questions: running a validated query (schema.ts) through
 * the analytics query layer (src/lib/analytics), under a scope:
 *
 *  - totals and series: queryAnalytics (one metric over the range, with the
 *    previous period);
 *  - a dimension ranked: queryTopDimensions with the metric expressed as
 *    filters (mitigated: outcome is not served; errors: status 4xx or 5xx),
 *    and for a comparison the same values counted in the previous period;
 *  - bytes by host: queryAnalytics grouped by host.
 *
 * Every SQL fragment comes from the analytics allow-lists and every value is
 * a bound parameter; nothing here builds SQL. Host tags only resolve to
 * proxy hosts the scope offers (the asker's visible hosts, or every host for
 * a compliance report).
 */
import { ApiValidationError } from "@/src/lib/api-errors";
import { getRetentionDays } from "@/src/lib/clickhouse/client";
import { queryAnalytics, OUTCOME_LABELS } from "@/src/lib/analytics/query";
import { queryTopDimensions, MAX_TOP_LIMIT, type TopRow } from "@/src/lib/analytics/top";
import { DIMENSION_SPECS, OTHER_HOSTS, type Dimension } from "@/src/lib/analytics/dimensions";
import type { AnalyticsFilter } from "@/src/lib/analytics/filters";
import { MAX_RANGE_SECONDS, previousPeriod, resolveRange, retentionStart, type ResolvedRange } from "@/src/lib/analytics/range";
import { normalizeDomain, proxyHostForName, type ProxyHostDomains } from "@/src/lib/analytics/scope";
import { queryDistinctHostsAll } from "@/src/lib/clickhouse/client";
import { formatInstant } from "./describe";
import type { QuestionQuery, QuestionRange, QuestionResult, QuestionResultRow } from "./types";

const DAY = 86_400;
/** queryAnalytics groups at most this many hosts by name. */
const MAX_GROUPED_HOSTS = 10;

export type TaggableHost = { id: number; domains: readonly string[]; tags: readonly string[] };

export type QuestionScope = {
  /** Proxy hosts whose tags a question may name. */
  taggableHosts: readonly TaggableHost[];
  /** Every proxy host, to attribute a stored host name to the host that serves it (as Caddy routes). */
  allHosts: readonly ProxyHostDomains[];
  /** Stored host names seen in ClickHouse; read only when a question names host tags. */
  seenHosts: () => Promise<string[]>;
  /** How a missing tag is explained: "you can see" for an asker, nothing for a report. */
  audience: "asker" | "report";
};

/** Every stored host name seen in ClickHouse; none when it is unavailable. */
export async function seenHosts(): Promise<string[]> {
  try {
    return await queryDistinctHostsAll();
  } catch {
    return [];
  }
}

export type QuestionRun =
  | {
      kind: "result";
      result: QuestionResult;
      range: ResolvedRange;
      /** Stored host names the host tags matched (within the scope), or null without tags. */
      tagHosts: string[] | null;
    }
  | { kind: "clarify"; message: string };

// ── Range ─────────────────────────────────────────────────────────────

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function toSeconds(text: string, endOfDay: boolean): number {
  const isDate = DATE_ONLY.test(text);
  const ms = Date.parse(isDate ? `${text}T00:00:00.000Z` : text);
  if (!Number.isFinite(ms)) throw new ApiValidationError("the date is not valid");
  return Math.floor(ms / 1000) + (isDate && endOfDay ? DAY : 0);
}

/**
 * The analytics range of a question: a preset ending now, or calendar dates
 * in UTC (a bare end date includes that day) capped at now. Throws
 * ApiValidationError for a period that has not started, ends before it
 * starts or covers more than 92 days.
 */
export function resolveQuestionRange(range: QuestionRange, now: number): ResolvedRange {
  if ("preset" in range) return resolveRange({ range: range.preset }, now);
  // The last N minutes, ending now (minute buckets, so it starts at the minute).
  if ("minutes" in range) return resolveRange({ from: now - range.minutes * 60, to: now }, now);
  const from = toSeconds(range.from, false);
  const to = Math.min(range.to === "now" ? now : toSeconds(range.to, true), now);
  if (from >= now) throw new ApiValidationError("the period has not started yet");
  if (to <= from) throw new ApiValidationError("the period ends before it starts");
  if (to - from > MAX_RANGE_SECONDS) throw new ApiValidationError(`a question can cover at most ${MAX_RANGE_SECONDS / DAY} days`);
  return resolveRange({ from, to }, now);
}

/**
 * A range of exactly `start` to `end` (a report's period, which follows its
 * time zone rather than the analytics buckets): the largest step from one
 * hour down that divides it, so the previous period's buckets line up.
 */
export function exactRange(start: number, end: number): ResolvedRange {
  const length = end - start;
  if (length <= 0) throw new ApiValidationError("the period ends before it starts");
  if (length > MAX_RANGE_SECONDS) throw new ApiValidationError(`a question can cover at most ${MAX_RANGE_SECONDS / DAY} days`);
  const step = [3600, 1800, 900, 300, 60].find((candidate) => length % candidate === 0) ?? length;
  return { preset: "custom", start, end, step, buckets: length / step };
}

// ── Host tags ─────────────────────────────────────────────────────────

/**
 * The stored host names of the proxy hosts that carry one of `tags`, among
 * the scope's taggable hosts: their exact domains, and every name seen in
 * ClickHouse that Caddy would route to one of them (a wildcard host does not
 * get the names another host serves exactly).
 */
export async function resolveTagHosts(
  tags: readonly string[],
  scope: QuestionScope
): Promise<{ ok: true; names: string[] } | { ok: false; message: string }> {
  const missing = tags.filter((tag) => !scope.taggableHosts.some((host) => host.tags.includes(tag)));
  if (missing.length > 0) {
    const known = [...new Set(scope.taggableHosts.flatMap((host) => host.tags))].sort().slice(0, 20);
    const who = scope.audience === "asker" ? "No proxy host you can see is" : "No proxy host is";
    return {
      ok: false,
      message:
        `${who} tagged ${missing.map((tag) => `"${tag}"`).join(" or ")}. ` +
        (known.length > 0 ? `Tags you can use: ${known.join(", ")}.` : "No proxy host has a tag yet: name the hosts instead."),
    };
  }
  const tagged = scope.taggableHosts.filter((host) => host.tags.some((tag) => tags.includes(tag)));
  const ids = new Set(tagged.map((host) => host.id));
  const names = new Set<string>();
  for (const host of tagged) {
    for (const raw of host.domains) {
      const domain = normalizeDomain(raw);
      if (domain && !domain.startsWith("*.") && proxyHostForName(domain, scope.allHosts) === host.id) names.add(domain);
    }
  }
  for (const stored of await scope.seenHosts()) {
    const owner = proxyHostForName(stored, scope.allHosts);
    if (owner !== null && ids.has(owner)) names.add(stored);
  }
  return { ok: true, names: [...names].sort() };
}

// ── Metric as filters (ranked dimensions) ─────────────────────────────

function isErrorStatus(value: string): boolean {
  if (/^[45]xx$/.test(value)) return true;
  return /^\d{1,3}$/.test(value) && Number(value) >= 400;
}

/**
 * The filters that count `metric` with queryTopDimensions (which counts
 * requests): mitigated adds "outcome is not served", errors keeps only the
 * status filters of 400 and above (or adds 4xx and 5xx). `impossible` when
 * the status filters exclude every error.
 */
export function metricFilters(metric: QuestionQuery["metric"], filters: readonly AnalyticsFilter[]): { filters: AnalyticsFilter[]; impossible: boolean } {
  if (metric === "mitigated") return { filters: [...filters, { dim: "outcome", op: "is_not", value: "served" }], impossible: false };
  if (metric !== "errors") return { filters: [...filters], impossible: false };
  const statusIs = filters.filter((filter) => filter.dim === "status" && filter.op === "is");
  const others = filters.filter((filter) => !(filter.dim === "status" && filter.op === "is"));
  if (statusIs.length === 0) {
    return {
      filters: [...others, { dim: "status", op: "is", value: "4xx" }, { dim: "status", op: "is", value: "5xx" }],
      impossible: false,
    };
  }
  const kept = statusIs.filter((filter) => isErrorStatus(filter.value));
  return { filters: [...others, ...kept], impossible: kept.length === 0 };
}

function filterableValue(dim: Dimension, value: string): boolean {
  if (!value) return false;
  try {
    DIMENSION_SPECS[dim].compare(value);
    return true;
  } catch {
    return false;
  }
}

function rowLabel(dim: Dimension, row: TopRow): string | null {
  if (dim === "outcome") return OUTCOME_LABELS[row.value as keyof typeof OUTCOME_LABELS] ?? null;
  if (dim === "ip") return [row.country, row.asOrg].filter(Boolean).join(" · ") || null;
  return row.label ?? null;
}

// ── Running ───────────────────────────────────────────────────────────

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

function change(current: number, previous: number | null): number | null {
  return previous === null || previous === 0 ? null : current / previous - 1;
}

/**
 * Runs `query` in `scope`. `period` (Unix seconds, end exclusive) replaces
 * the query's own range: a compliance report re-runs a saved question for
 * the report's period. Returns a clarification instead of a result when the
 * period cannot be shown or a host tag names nothing in scope.
 */
export async function runQuestionQuery(
  query: QuestionQuery,
  scope: QuestionScope,
  options: { now: number; period?: { start: number; end: number } }
): Promise<QuestionRun> {
  const { now } = options;
  let range: ResolvedRange;
  try {
    range = options.period ? exactRange(options.period.start, Math.min(options.period.end, now)) : resolveQuestionRange(query.range, now);
  } catch (error) {
    if (error instanceof ApiValidationError) return { kind: "clarify", message: `That period cannot be answered: ${error.message}.` };
    throw error;
  }

  // Host tags limit the query to the stored host names of the tagged hosts.
  let tagHosts: string[] | null = null;
  if (query.hostTags.length > 0) {
    const resolved = await resolveTagHosts(query.hostTags, scope);
    if (!resolved.ok) return { kind: "clarify", message: resolved.message };
    tagHosts = resolved.names;
  }

  const filters: AnalyticsFilter[] = query.filters.map((filter) => ({ dim: filter.dim, op: filter.op, value: filter.value }));
  const comparing = query.comparison === "previous_period";
  const prev = previousPeriod(range, now);
  const notes: string[] = [];
  const oldest = retentionStart(now);
  if (range.start < oldest) notes.push(`Analytics keep ${getRetentionDays()} days: nothing before ${formatInstant(oldest)} is left.`);
  if (tagHosts !== null && tagHosts.length === 0) notes.push(`No traffic was recorded for the hosts tagged ${query.hostTags.join(" or ")}.`);

  const base: Omit<QuestionResult, "status" | "kind" | "total" | "previousTotal" | "change" | "rows" | "distinct" | "series" | "peak"> = {
    metric: query.metric,
    breakdown: query.breakdown,
    unit: query.metric === "bytes" ? "bytes" : "count",
    range: { start: range.start, end: range.end, step: range.step, buckets: range.buckets },
    previous: comparing ? { start: prev.start, end: prev.end, available: prev.available } : null,
    scope: query.hostTags.length > 0 ? { hostTags: query.hostTags, hostNames: tagHosts?.length ?? 0 } : null,
    notes,
  };

  // One total, or the metric over time.
  if (query.breakdown === "none" || query.breakdown === "time") {
    const data = await queryAnalytics({ range, filters, metric: query.metric, groupBy: "none", topHosts: 4 }, now, tagHosts);
    const previousValues = data.previous.available ? data.previous.totals : null;
    const total = query.metric === "visitors" ? data.headline.visitors.value : sum(data.totals);
    const previousTotal =
      comparing && previousValues
        ? query.metric === "visitors"
          ? (data.headline.visitors.previous ?? 0)
          : sum(previousValues)
        : null;
    if (query.metric === "visitors" && query.breakdown === "time") {
      notes.push("Each interval counts its own distinct addresses; they do not add up to the total.");
    }
    return {
      kind: "result",
      range,
      tagHosts,
      result: {
        ...base,
        status: data.status,
        kind: query.breakdown === "time" ? "series" : "total",
        total,
        previousTotal,
        change: change(total, previousTotal),
        rows: [],
        distinct: null,
        series: { values: data.totals, previous: comparing ? previousValues : null },
        peak: data.peak ? { ts: data.peak.ts, value: data.peak.value } : null,
      },
    };
  }

  // Bytes by host: the analytics chart grouped by host.
  if (query.metric === "bytes") {
    const limit = Math.min(query.limit, MAX_GROUPED_HOSTS);
    if (query.limit > MAX_GROUPED_HOSTS) notes.push(`Bytes by host lists at most ${MAX_GROUPED_HOSTS} hosts.`);
    const data = await queryAnalytics({ range, filters, metric: "bytes", groupBy: "host", topHosts: limit }, now, tagHosts);
    const total = sum(data.totals);
    const previousByKey = new Map(data.previous.available ? data.previous.series.map((series) => [series.key, series.total]) : []);
    const withPrevious = comparing && data.previous.available;
    const rows: QuestionResultRow[] = data.series
      .filter((series) => series.key !== OTHER_HOSTS)
      .map((series) => {
        const previous = withPrevious ? (previousByKey.get(series.key) ?? 0) : null;
        return { value: series.key, label: null, count: series.total, share: total > 0 ? series.total / total : 0, previous, change: change(series.total, previous) };
      });
    const other = data.series.find((series) => series.key === OTHER_HOSTS);
    if (other && other.total > 0) notes.push(`The other hosts sent ${Math.round(other.total).toLocaleString("en-US")} bytes.`);
    const previousTotal = withPrevious && data.previous.available ? sum(data.previous.totals) : null;
    return {
      kind: "result",
      range,
      tagHosts,
      result: {
        ...base,
        status: data.status,
        kind: "breakdown",
        total,
        previousTotal,
        change: change(total, previousTotal),
        rows,
        distinct: null,
        series: null,
        peak: null,
      },
    };
  }

  // A dimension ranked by requests, mitigated requests or error responses.
  const dim = query.breakdown as Dimension;
  const counted = metricFilters(query.metric, filters);
  if (counted.impossible) {
    notes.push("Error responses have a status of 400 or higher, and the status filter leaves none.");
    return {
      kind: "result",
      range,
      tagHosts,
      result: { ...base, status: "ok", kind: "breakdown", total: 0, previousTotal: comparing ? 0 : null, change: null, rows: [], distinct: 0, series: null, peak: null },
    };
  }
  const current = await queryTopDimensions({ range, filters: counted.filters, dimensions: [dim], limit: query.limit }, tagHosts);
  const top = current.dimensions[0];
  let rows: QuestionResultRow[] = (top?.rows ?? []).map((row) => ({
    value: row.value,
    label: rowLabel(dim, row),
    count: row.count,
    share: row.share,
    previous: null,
    change: null,
  }));
  let previousTotal: number | null = null;
  if (comparing && prev.available && current.status === "ok") {
    const previousRange: ResolvedRange = { ...range, start: prev.start, end: prev.end };
    const totals = await queryTopDimensions({ range: previousRange, filters: counted.filters, dimensions: [dim], limit: 1 }, tagHosts);
    previousTotal = totals.total;
    if (rows.length > 0) {
      // Count exactly the values listed now. Several "is" filters on one
      // dimension match any of them; when the query already has some, they
      // already narrow it to a few values.
      const ownValues = counted.filters.some((filter) => filter.dim === dim && filter.op === "is");
      const listed = ownValues ? [] : rows.map((row) => row.value).filter((value) => filterableValue(dim, value));
      const counts = await queryTopDimensions(
        {
          range: previousRange,
          filters: [...counted.filters, ...listed.map((value): AnalyticsFilter => ({ dim, op: "is", value }))],
          dimensions: [dim],
          limit: ownValues ? MAX_TOP_LIMIT : Math.max(1, listed.length),
        },
        tagHosts
      );
      const byValue = new Map((counts.dimensions[0]?.rows ?? []).map((row) => [row.value, row.count]));
      rows = rows.map((row) => {
        const previous = ownValues || listed.includes(row.value) ? (byValue.get(row.value) ?? 0) : null;
        return { ...row, previous, change: change(row.count, previous) };
      });
    }
  }
  return {
    kind: "result",
    range,
    tagHosts,
    result: {
      ...base,
      status: current.status,
      kind: "breakdown",
      total: current.total,
      previousTotal,
      change: change(current.total, previousTotal),
      rows,
      distinct: top?.distinct ?? null,
      series: null,
      peak: null,
    },
  };
}
