/**
 * How the analytics page names and colours things: outcomes, status
 * classes, series, dimensions, metrics and ranges, plus the CSV export.
 * Pure functions, safe on the server and the client.
 */
import type { Dimension, Grouping, Metric, TopDimension } from "@/src/lib/analytics";
import { formatBytes, formatCompact, formatDayUtc, type GoodDirection } from "@/components/ui/chart-format";
import { OUTCOMES, type RangeKey } from "./view-state";

// ── Outcomes and status classes ──────────────────────────────────────────

/** Series colour of each outcome. */
export const OUTCOME_COLOR: Record<string, string> = {
  served: "var(--served)",
  waf: "var(--waf)",
  geo: "var(--brand)",
  access: "var(--access)",
  auth: "var(--served2)",
  rate_limit: "var(--rl)",
};

/** What happened to one request, in the request log. */
export const OUTCOME_LOG_LABEL: Record<string, string> = {
  served: "Served",
  waf: "Blocked by WAF",
  geo: "Geo rule",
  access: "Access rule",
  auth: "Sign-in required",
  rate_limit: "Rate limited",
};

export const STATUS_CLASS_COLOR: Record<string, string> = {
  "2xx": "var(--served)",
  "3xx": "var(--served2)",
  "4xx": "var(--err4)",
  "5xx": "var(--err5)",
  other: "var(--soft)",
};

/** The colour of a status code's class. */
export function statusColor(status: string | number): string {
  const first = String(status).trim()[0];
  return STATUS_CLASS_COLOR[`${first}xx`] ?? STATUS_CLASS_COLOR.other;
}

/** Hosts of the "group by host" chart, busiest first; the rest share the last colour. */
const HOST_COLORS = ["var(--served)", "var(--served2)", "var(--brand)", "var(--access)", "var(--rl)", "var(--waf)"];
const OTHER_HOSTS = "__other__";

/** The colour of series `key` (at `index`) under `group` for `metric`. */
export function seriesColor(group: Grouping, metric: Metric, key: string, index: number): string {
  if (group === "outcome") return OUTCOME_COLOR[key] ?? "var(--soft)";
  if (group === "status") return STATUS_CLASS_COLOR[key] ?? "var(--soft)";
  if (group === "host") return key === OTHER_HOSTS ? "var(--err4)" : HOST_COLORS[index % HOST_COLORS.length];
  return METRIC_INFO[metric].color;
}

/** The label of series `label` under `group`: the single series of "none" is named after the metric. */
export function seriesLabel(group: Grouping, metric: Metric, label: string): string {
  return group === "none" ? METRIC_INFO[metric].series : label;
}

// ── Metrics ──────────────────────────────────────────────────────────────

export type MetricInfo = {
  /** KPI tile label. */
  label: string;
  /** Name of the single series when nothing groups it. */
  series: string;
  color: string;
  /** Which change of the headline number is good. */
  good: GoodDirection;
  /** Formats one value of the metric. */
  format: (value: number) => string;
};

export const METRIC_INFO: Record<Metric, MetricInfo> = {
  requests: { label: "Requests", series: "Requests", color: "var(--served)", good: null, format: formatCompact },
  bytes: { label: "Bandwidth", series: "Bytes sent", color: "var(--served2)", good: null, format: formatBytes },
  visitors: { label: "Unique addresses", series: "Unique addresses", color: "var(--brand)", good: null, format: formatCompact },
  mitigated: { label: "Mitigated", series: "Mitigated", color: "var(--waf)", good: "down", format: formatCompact },
  errors: { label: "5xx error rate", series: "Error responses", color: "var(--err5)", good: "down", format: formatCompact },
};

const GROUP_TITLE: Record<Grouping, string> = { none: "", outcome: "outcome", status: "status class", host: "host" };

/** The chart's heading for a metric and grouping. */
export function chartTitle(metric: Metric, group: Grouping): string {
  if (metric === "visitors") return "Unique addresses";
  if (metric === "bytes") return group === "host" ? "Bytes sent by host" : "Bytes sent";
  if (metric === "mitigated") return group === "host" ? "Mitigated requests by host" : "Mitigated requests by source";
  if (metric === "errors") return `Error responses by ${GROUP_TITLE[group === "none" ? "status" : group]}`;
  return group === "none" ? "Requests" : `Requests by ${GROUP_TITLE[group]}`;
}

/** The label of a grouping button for a metric. */
export function groupingLabel(group: Grouping, metric: Metric): string {
  if (group === "none") return "Total";
  if (group === "outcome") return metric === "mitigated" ? "Source" : "Outcome";
  if (group === "status") return "Status";
  return "Host";
}

// ── Ranges ───────────────────────────────────────────────────────────────

/** "24 hours": the range as in "vs previous 24 hours". */
export function rangeNoun(range: RangeKey): string {
  switch (range) {
    case "1h":
      return "hour";
    case "24h":
      return "24 hours";
    case "7d":
      return "7 days";
    case "30d":
      return "30 days";
    default:
      return "period";
  }
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "3 Oct 14:30" in UTC. */
export function formatDateTimeShortUtc(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${formatDayUtc(seconds * 1000)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** "14:30" in UTC. */
export function formatClockUtc(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** A request's time in the log: "11:36:02", with the day when the range spans more than a day. */
export function formatLogTime(seconds: number, withDay: boolean): string {
  const d = new Date(seconds * 1000);
  const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  return withDay ? `${formatDayUtc(seconds * 1000)} ${time}` : time;
}

/** A Unix time as the value of an <input type="datetime-local"> holding UTC. */
export function toDateTimeInput(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 16);
}

/** The Unix time of an <input type="datetime-local"> value read as UTC, or null. */
export function fromDateTimeInput(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}:00Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** A bucket width in words: "minute", "30 minutes", "3 hours", "day". */
export function formatStep(seconds: number): string {
  if (seconds >= 86_400 && seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return days === 1 ? "day" : `${days} days`;
  }
  if (seconds >= 3600 && seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? "hour" : `${hours} hours`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? "minute" : `${minutes} minutes`;
}

// ── Dimensions ───────────────────────────────────────────────────────────

export const DIMENSION_LABEL: Record<Dimension, string> = {
  host: "Host",
  path: "Path",
  country: "Country",
  asn: "Source network (ASN)",
  status: "Status code",
  method: "Method",
  protocol: "HTTP version",
  ip: "Source IP",
  user_agent: "User agent",
  outcome: "Outcome",
  waf_rule: "WAF rule",
};

export const DIMENSION_PLACEHOLDER: Record<Dimension, string> = {
  host: "app.example.com",
  path: "/login",
  country: "DE",
  asn: "AS13335",
  status: "404 or 5xx",
  method: "POST",
  protocol: "HTTP/2.0",
  ip: "203.0.113.7",
  user_agent: "curl 8.5.0",
  outcome: "waf",
  waf_rule: "942100",
};

let regionNames: Intl.DisplayNames | null | undefined;

/** "Germany" for DE; "Private network" for LAN, "Unknown" for XX. */
export function countryName(code: string): string {
  if (code === "LAN") return "Private network";
  if (code === "XX" || !code) return "Unknown";
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** "AS13335", or "Unknown network" for 0. */
export function asnLabel(value: string): string {
  return value === "0" || value === "" ? "Unknown network" : `AS${value}`;
}

const MAX_SUGGESTIONS = 50;

/**
 * Values offered while typing a filter: the top values of the current view,
 * the configured host names for hosts, the outcomes and the status classes.
 */
export function filterSuggestions(top: readonly TopDimension[] | null, configuredHosts: readonly string[]): Partial<Record<Dimension, string[]>> {
  const out: Partial<Record<Dimension, string[]>> = {};
  for (const dimension of top ?? []) {
    out[dimension.dimension] = dimension.rows
      .filter((row) => row.value !== "" && !(dimension.dimension === "asn" && row.value === "0"))
      .map((row) => (dimension.dimension === "asn" ? `AS${row.value}` : row.value));
  }
  const unique = (values: readonly string[]) => [...new Set(values)].slice(0, MAX_SUGGESTIONS);
  out.host = unique([...(out.host ?? []), ...configuredHosts]);
  out.status = unique([...(out.status ?? []), "2xx", "3xx", "4xx", "5xx"]);
  out.outcome = [...OUTCOMES];
  return out;
}

// ── CSV ──────────────────────────────────────────────────────────────────

/**
 * One CSV field. Labels come from request data (host names), so text a
 * spreadsheet would run as a formula (starting with = + - @, tab or
 * carriage return) gets a leading apostrophe.
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The chart's data as CSV: one row per bucket with its start time (UTC),
 * each series, the total and, when there is one, the previous period's total.
 */
export function chartCsv(input: {
  buckets: readonly number[];
  series: readonly { label: string; values: readonly number[] }[];
  previous?: readonly (number | null)[] | null;
}): string {
  const header = ["Time (UTC)", ...input.series.map((s) => s.label), "Total"];
  if (input.previous) header.push("Previous period");
  const lines = [header.map(csvCell).join(",")];
  input.buckets.forEach((ms, i) => {
    const values = input.series.map((s) => s.values[i] ?? 0);
    const row: (string | number | null)[] = [new Date(ms).toISOString(), ...values, values.reduce((a, b) => a + b, 0)];
    if (input.previous) row.push(input.previous[i] ?? null);
    lines.push(row.map(csvCell).join(","));
  });
  return `${lines.join("\r\n")}\r\n`;
}

/** A run of identical requests in the request log: the newest, how many, and when the run started. */
export type RequestRun<T> = { row: T; count: number; firstTs: number };

/** Requests within this many seconds of each other with nothing else differing are one run. */
const RUN_GAP_SECONDS = 60;

/**
 * The request log with runs of identical requests (same outcome, method,
 * host, path, status, source, user agent and WAF rule, each within a minute
 * of the next) folded into one row with a count. Newest first, as given.
 */
export function collapseRequestRuns<
  T extends { ts: number; outcome: string; method: string; host: string; path: string; status: number; ip: string; userAgent: string; wafRuleId: number }
>(rows: readonly T[]): RequestRun<T>[] {
  const runs: RequestRun<T>[] = [];
  for (const row of rows) {
    const last = runs[runs.length - 1];
    const same =
      last &&
      last.row.outcome === row.outcome &&
      last.row.method === row.method &&
      last.row.host === row.host &&
      last.row.path === row.path &&
      last.row.status === row.status &&
      last.row.ip === row.ip &&
      last.row.userAgent === row.userAgent &&
      last.row.wafRuleId === row.wafRuleId &&
      Math.abs(last.firstTs - row.ts) <= RUN_GAP_SECONDS;
    if (same) {
      last.count += 1;
      last.firstTs = Math.min(last.firstTs, row.ts);
    } else {
      runs.push({ row, count: 1, firstTs: row.ts });
    }
  }
  return runs;
}
