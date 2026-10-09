// SPDX-License-Identifier: Elastic-2.0
/**
 * Plain-language questions: a validated query in words ("Mitigated requests
 * by country, 26 Sep–3 Oct 2026 (UTC), hosts tagged shop"), the link that
 * opens it on the Analytics page, and the summary the dashboard writes from
 * the numbers when the model does not. Pure functions, safe on the server
 * and the client.
 */
import { formatBytes, formatPercent } from "@/components/ui/chart-format";
import {
  QUESTION_DIMENSION_LABELS,
  QUESTION_METRIC_LABELS,
  REQUEST_DETAIL_DIMENSIONS,
  type QuestionDimension,
  type QuestionFilter,
  type QuestionMetric,
  type QuestionQuery,
  type QuestionRange,
  type QuestionResult,
} from "./types";

/** Most filters the Analytics page takes in its URL. */
const ANALYTICS_PAGE_MAX_FILTERS = 20;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const pad2 = (n: number) => String(n).padStart(2, "0");

export const OUTCOME_WORDS: Record<string, string> = {
  served: "served",
  waf: "blocked by the WAF",
  geo: "stopped by geo rules",
  access: "stopped by access rules",
  auth: "asked to sign in",
  rate_limit: "rate limited",
};

/** Metric nouns in sentences ("12,345 mitigated requests"). */
const METRIC_NOUN: Record<QuestionMetric, string> = {
  requests: "requests",
  mitigated: "mitigated requests",
  errors: "error responses",
  bytes: "bytes sent",
  visitors: "unique client addresses",
};

function day(seconds: number): { d: number; m: string; y: number } {
  const date = new Date(seconds * 1000);
  return { d: date.getUTCDate(), m: MONTHS[date.getUTCMonth()], y: date.getUTCFullYear() };
}

function clock(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

/** "3 Oct 2026 14:00 UTC" */
export function formatInstant(seconds: number): string {
  const a = day(seconds);
  return `${a.d} ${a.m} ${a.y} ${clock(seconds)} UTC`;
}

/**
 * A period (Unix seconds, end exclusive) in words, in UTC: "26 Sep–3 Oct 2026"
 * for whole days, "3 Oct 2026, 09:00–10:00 UTC" within a day, otherwise
 * "2 Oct 10:00–3 Oct 10:00 UTC".
 */
export function formatPeriod(start: number, end: number): string {
  const last = Math.max(start, end - 1);
  const a = day(start);
  const b = day(last);
  const wholeDays = start % 86_400 === 0 && end % 86_400 === 0;
  if (wholeDays) {
    if (a.d === b.d && a.m === b.m && a.y === b.y) return `${a.d} ${a.m} ${a.y}`;
    if (a.y !== b.y) return `${a.d} ${a.m} ${a.y}–${b.d} ${b.m} ${b.y}`;
    return `${a.d} ${a.m}–${b.d} ${b.m} ${b.y}`;
  }
  const endClock = end % 86_400 === 0 ? "24:00" : clock(end);
  if (a.d === b.d && a.m === b.m && a.y === b.y) return `${a.d} ${a.m} ${a.y}, ${clock(start)}–${endClock} UTC`;
  return `${a.d} ${a.m} ${clock(start)}–${b.d} ${b.m} ${b.y} ${clock(end)} UTC`;
}

function filterValueWords(filter: QuestionFilter, redact: boolean): string {
  if (redact && REQUEST_DETAIL_DIMENSIONS.includes(filter.dim)) return "[hidden]";
  if (filter.dim === "outcome") return OUTCOME_WORDS[filter.value] ?? filter.value;
  if (filter.dim === "asn") return `AS${filter.value}`;
  return filter.value;
}

/** "status is 5xx", "country is not CN" */
export function describeFilter(filter: QuestionFilter, redact = false): string {
  const label = QUESTION_DIMENSION_LABELS[filter.dim];
  return `${label} ${filter.op === "is_not" ? "is not" : "is"} ${filterValueWords(filter, redact)}`;
}

/** The filters in words, values of one dimension and operator joined with "or". */
export function describeFilters(filters: readonly QuestionFilter[], redact = false): string[] {
  const groups = new Map<string, QuestionFilter[]>();
  for (const filter of filters) {
    const key = `${filter.dim}:${filter.op}`;
    groups.set(key, [...(groups.get(key) ?? []), filter]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0];
    const label = QUESTION_DIMENSION_LABELS[first.dim];
    const values = group.map((filter) => filterValueWords(filter, redact));
    return first.op === "is_not" ? `${label} is not ${values.join(" or ")}` : `${label} is ${values.join(" or ")}`;
  });
}

/** The measure and breakdown: "Mitigated requests by country", "Requests over time". */
export function describeMeasure(query: Pick<QuestionQuery, "metric" | "breakdown" | "limit">): string {
  const measure = QUESTION_METRIC_LABELS[query.metric];
  if (query.breakdown === "none") return measure;
  if (query.breakdown === "time") return `${measure} over time`;
  return `${measure} by ${QUESTION_DIMENSION_LABELS[query.breakdown as QuestionDimension]} (top ${query.limit})`;
}

const PRESET_WORDS: Record<string, string> = {
  "1h": "the last hour",
  "24h": "the last 24 hours",
  "7d": "the last 7 days",
  "30d": "the last 30 days",
};

/** "the last 3 minutes", "the last hour", "the last 6 hours". */
function minutesWords(minutes: number): string {
  if (minutes === 1) return "the last minute";
  if (minutes % 60 === 0) return minutes === 60 ? "the last hour" : `the last ${minutes / 60} hours`;
  return `the last ${minutes} minutes`;
}

/**
 * A question's own range in words, without resolving it ("the last 7 days",
 * "26 Sep–3 Oct 2026", "29 Sep 2026 to now"): how a saved question reads.
 */
export function describeRange(range: QuestionRange): string {
  if ("preset" in range) return PRESET_WORDS[range.preset] ?? range.preset;
  if ("minutes" in range) return minutesWords(range.minutes);
  const from = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(range.from) ? `${range.from}T00:00:00Z` : range.from) / 1000;
  if (!Number.isFinite(from)) return `${range.from} to ${range.to}`;
  if (range.to === "now") {
    const start = day(from);
    return from % 86_400 === 0 ? `${start.d} ${start.m} ${start.y} to now` : `${formatInstant(from)} to now`;
  }
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(range.to);
  const to = Date.parse(dateOnly ? `${range.to}T00:00:00Z` : range.to) / 1000 + (dateOnly ? 86_400 : 0);
  return Number.isFinite(from) && Number.isFinite(to) ? formatPeriod(from, to) : `${range.from} to ${range.to}`;
}

/**
 * The query in words, as the answer shows it under the question:
 * "Mitigated requests by country (top 10), 26 Sep–3 Oct 2026, hosts tagged
 * shop, status is 5xx, compared with the 7 days before". `period` is the
 * resolved period, or the range already in words (a saved question). With
 * `redact`, filter values of client addresses, user agents and paths are
 * hidden.
 */
export function describeQuery(
  query: QuestionQuery,
  period: { start: number; end: number } | string,
  options: { redact?: boolean } = {}
): string {
  const parts = [describeMeasure(query), typeof period === "string" ? period : formatPeriod(period.start, period.end)];
  if (query.hostTags.length > 0) parts.push(`hosts tagged ${query.hostTags.join(" or ")}`);
  parts.push(...describeFilters(query.filters, options.redact ?? false));
  if (query.comparison === "previous_period") {
    parts.push(typeof period === "string" ? "compared with the period before" : `compared with the ${durationWords(period.end - period.start)} before`);
  }
  return parts.join(", ");
}

/** "7 days", "24 hours", "1 hour", "3 days and 4 hours" */
export function durationWords(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.round((seconds % 86_400) / 3600);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (days === 0) return plural(Math.max(1, hours), "hour");
  if (days === 1 && hours === 0) return "24 hours";
  return hours === 0 ? plural(days, "day") : `${plural(days, "day")} and ${plural(hours, "hour")}`;
}

// ── Link to the Analytics page ────────────────────────────────────────

/** The chart grouping the Analytics page offers for a metric and breakdown, or null for its default. */
function groupingFor(metric: QuestionMetric, breakdown: QuestionQuery["breakdown"]): string | null {
  const allowed: Record<QuestionMetric, readonly string[]> = {
    requests: ["outcome", "status", "host"],
    bytes: ["none", "host"],
    visitors: ["none"],
    mitigated: ["outcome", "host"],
    errors: ["status", "host"],
  };
  return allowed[metric].includes(breakdown) && breakdown !== allowed[metric][0] ? breakdown : null;
}

/**
 * The Analytics page for the query: the same period, metric, grouping (when
 * the page has it) and filters. Host tags become host filters for the stored
 * host names they matched (`tagHosts`), intersected with the query's own host
 * filters; null when they do not fit in the page's filter limit.
 */
export function analyticsHrefFor(
  query: QuestionQuery,
  period: { start: number; end: number; preset: string },
  tagHosts: readonly string[] | null
): { href: string; complete: boolean } {
  const params = new URLSearchParams();
  if (period.preset !== "custom") params.set("range", period.preset);
  else {
    params.set("range", "custom");
    params.set("from", String(period.start));
    params.set("to", String(period.end));
  }
  if (query.metric !== "requests") params.set("metric", query.metric);
  const group = groupingFor(query.metric, query.breakdown);
  if (group) params.set("group", group);
  let filters = query.filters.map((filter) => ({ dim: filter.dim, op: filter.op, value: filter.value }));
  let complete = true;
  if (tagHosts !== null) {
    const ownHosts = filters.filter((filter) => filter.dim === "host" && filter.op === "is").map((filter) => filter.value);
    const hosts = ownHosts.length > 0 ? tagHosts.filter((host) => ownHosts.includes(host)) : [...tagHosts];
    filters = filters.filter((filter) => !(filter.dim === "host" && filter.op === "is"));
    if (hosts.length > 0 && hosts.length + filters.length <= ANALYTICS_PAGE_MAX_FILTERS) {
      filters = [...hosts.map((value) => ({ dim: "host" as const, op: "is" as const, value })), ...filters];
    } else {
      complete = false;
    }
  }
  if (filters.length > 0) params.set("filters", JSON.stringify(filters));
  return { href: `/analytics?${params.toString()}`, complete };
}

// ── The dashboard's own summary ───────────────────────────────────────

function amount(metric: QuestionMetric, value: number): string {
  return metric === "bytes" ? formatBytes(value) : Math.round(value).toLocaleString("en-US");
}

function changeWords(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? "up from none in the previous period" : "none in the previous period either";
  const ratio = current / previous - 1;
  if (Math.abs(ratio) < 0.005) return "about the same as in the previous period";
  return `${formatPercent(Math.abs(ratio))} ${ratio > 0 ? "more" : "less"} than in the previous period`;
}

function rowName(row: { value: string; label: string | null }, breakdown: string): string {
  if (breakdown === "outcome") return OUTCOME_WORDS[row.value] ? `${row.value} (${OUTCOME_WORDS[row.value]})` : row.value;
  if (breakdown === "asn") return row.label ? `AS${row.value} (${row.label})` : `AS${row.value}`;
  if (breakdown === "waf_rule") return row.label ? `rule ${row.value} (${row.label})` : `rule ${row.value}`;
  return row.value || "(empty)";
}

/**
 * Two or three sentences from the result's numbers only, for when no model
 * writes the summary (turned off, failed, or a scheduled report).
 */
export function computedSummary(result: QuestionResult, periodText: string): string {
  const noun = METRIC_NOUN[result.metric];
  if (result.status === "disabled") return "Traffic analytics is not configured, so there is no traffic data to answer from.";
  if (result.status === "unavailable") return "ClickHouse did not answer, so the numbers could not be read. Try again later.";
  const sentences: string[] = [];
  if (result.kind === "breakdown") {
    const [first, ...rest] = result.rows;
    if (!first || result.total === 0) return `No ${noun} in ${periodText}.`;
    sentences.push(
      `${rowName(first, result.breakdown)} had the most ${noun} in ${periodText}: ${amount(result.metric, first.count)} of ${amount(result.metric, result.total)} (${formatPercent(first.share)}).`
    );
    if (rest.length > 0) {
      sentences.push(`Next: ${rest.slice(0, 2).map((row) => `${rowName(row, result.breakdown)} with ${amount(result.metric, row.count)} (${formatPercent(row.share)})`).join(", ")}.`);
    }
  } else {
    sentences.push(`${amount(result.metric, result.total)} ${noun} in ${periodText}.`.replace(/^./, (c) => c.toUpperCase()));
    if (result.kind === "series" && result.peak && result.metric !== "visitors") {
      sentences.push(`The busiest interval started ${formatInstant(result.peak.ts)}, with ${amount(result.metric, result.peak.value)}.`);
    }
  }
  if (result.previous) {
    if (!result.previous.available) sentences.push("The previous period is older than the analytics keep, so there is nothing to compare with.");
    else if (result.previousTotal !== null) sentences.push(`That is ${changeWords(result.total, result.previousTotal)} (${amount(result.metric, result.previousTotal)}).`);
  }
  return sentences.join(" ");
}
