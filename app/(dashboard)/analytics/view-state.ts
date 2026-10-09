/**
 * What the analytics page shows, as it lives in the URL: the range, the
 * metric, the grouping, the comparison switch, the filters and the saved
 * view it came from. Pure functions, shared by the page, its tests and the
 * saved views; the server checks every value again (src/lib/analytics).
 *
 * URL parameters (defaults are left out):
 *   range=1h|24h|7d|30d|custom   from, to (Unix seconds) for custom
 *   metric=requests|bytes|visitors|mitigated|errors
 *   group=none|outcome|status|host  (only the groupings the metric allows)
 *   compare=0                     hides the previous period
 *   filter=host:app.example.com   one per filter; a leading "!" excludes,
 *                                 "~path:…" contains, "!~path:…" does not contain
 *   filters=[{"dim","op","value"}] also read: the API's JSON format, as other
 *                                 pages (Security events, Overview) link here
 *   view=12                       the saved view these settings came from
 */
import type { AnalyticsFilter, Dimension, Grouping, Metric, RangePreset } from "@/src/lib/analytics";
import type { AnalyticsSavedView, SavedViewRange } from "@/src/lib/models/analytics-views";
import { parseRowId } from "@/src/lib/row-ids";

export type RangeKey = RangePreset | "custom";

export const RANGE_PRESETS: readonly RangePreset[] = ["1h", "24h", "7d", "30d"];
export const METRICS: readonly Metric[] = ["requests", "bytes", "visitors", "mitigated", "errors"];
export const DIMENSIONS: readonly Dimension[] = [
  "host",
  "path",
  "country",
  "asn",
  "status",
  "method",
  "protocol",
  "ip",
  "user_agent",
  "outcome",
  "waf_rule",
];
export const GROUPINGS: readonly Grouping[] = ["none", "outcome", "status", "host"];
export const OUTCOMES = ["served", "waf", "geo", "access", "auth", "rate_limit"] as const;

/** Longest custom range the API accepts (92 days). */
export const MAX_RANGE_SECONDS = 92 * 86_400;
/** Most filters the API accepts. */
export const MAX_FILTERS = 20;

/** The groupings that make sense for each metric, the default first. */
export const METRIC_GROUPINGS: Record<Metric, readonly Grouping[]> = {
  requests: ["outcome", "status", "host"],
  bytes: ["none", "host"],
  // Distinct addresses do not add up across groups.
  visitors: ["none"],
  mitigated: ["outcome", "host"],
  errors: ["status", "host"],
};

export type ViewState = {
  range: RangeKey;
  /** Custom range only: first and last second (Unix). */
  from: number | null;
  to: number | null;
  metric: Metric;
  /** Null: the metric's default grouping. */
  group: Grouping | null;
  /** Shows the previous period on the chart. */
  compare: boolean;
  filters: AnalyticsFilter[];
  /** The saved view these settings were loaded from. */
  viewId: number | null;
};

export const DEFAULT_VIEW_STATE: ViewState = {
  range: "24h",
  from: null,
  to: null,
  metric: "requests",
  group: null,
  compare: true,
  filters: [],
  viewId: null,
};

function isPreset(value: unknown): value is RangePreset {
  return typeof value === "string" && (RANGE_PRESETS as readonly string[]).includes(value);
}

function isMetric(value: unknown): value is Metric {
  return typeof value === "string" && (METRICS as readonly string[]).includes(value);
}

/** Dimensions a "contains" filter can search (src/lib/analytics/dimensions.ts SEARCHABLE_SQL). */
export const SEARCHABLE_DIMENSIONS: readonly Dimension[] = ["host", "path", "user_agent", "ip"];
/** Longest text a "contains" filter searches for. */
export const MAX_CONTAINS_LENGTH = 256;

export function isSearchableDimension(dim: Dimension): boolean {
  return SEARCHABLE_DIMENSIONS.includes(dim);
}

function isDimension(value: unknown): value is Dimension {
  return typeof value === "string" && (DIMENSIONS as readonly string[]).includes(value);
}

function isGrouping(value: unknown): value is Grouping {
  return typeof value === "string" && (GROUPINGS as readonly string[]).includes(value);
}

/** The grouping the chart uses: the chosen one when the metric allows it, else the metric's default. */
export function effectiveGrouping(state: Pick<ViewState, "metric" | "group">): Grouping {
  const allowed = METRIC_GROUPINGS[state.metric];
  return state.group && allowed.includes(state.group) ? state.group : allowed[0];
}

function unixSeconds(value: string | null): number | null {
  if (value === null || !/^\d{1,12}$/.test(value.trim())) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** A custom range as the API accepts it, or null. */
export function validCustomRange(from: number | null, to: number | null, now = Math.floor(Date.now() / 1000)): boolean {
  return from !== null && to !== null && to > from && to - from <= MAX_RANGE_SECONDS && from <= now;
}

// ── Filters ──────────────────────────────────────────────────────────────

/** "host:app.example.com"; "!host:…" for "is not", "~path:…" for "contains", "!~path:…" for "does not contain". */
export function encodeFilter(filter: AnalyticsFilter): string {
  const prefix = filter.op === "is_not" ? "!" : filter.op === "contains" ? "~" : filter.op === "not_contains" ? "!~" : "";
  return `${prefix}${filter.dim}:${filter.value}`;
}

/** The filter in a `filter` parameter, or null when it is malformed or its value is invalid. */
export function decodeFilter(text: string): AnalyticsFilter | null {
  const op: AnalyticsFilter["op"] = text.startsWith("!~") ? "not_contains" : text.startsWith("~") ? "contains" : text.startsWith("!") ? "is_not" : "is";
  const body = text.slice(op === "not_contains" ? 2 : op === "is" ? 0 : 1);
  const colon = body.indexOf(":");
  if (colon <= 0) return null;
  const dim = body.slice(0, colon);
  const raw = body.slice(colon + 1);
  if (!isDimension(dim)) return null;
  if (op === "contains" || op === "not_contains") {
    const value = raw.trim();
    return value && isSearchableDimension(dim) && value.length <= MAX_CONTAINS_LENGTH ? { dim, op, value } : null;
  }
  const value = normalizeFilterValue(dim, raw);
  if (!value || filterValueError(dim, value)) return null;
  return { dim, op, value };
}

/** A value as the filter stores it: trimmed, country codes and methods in capitals. */
export function normalizeFilterValue(dim: Dimension, value: string): string {
  const trimmed = value.trim();
  if (dim === "country" || dim === "method") return trimmed.toUpperCase();
  if (dim === "status") return trimmed.toLowerCase();
  return trimmed;
}

function isIpAddress(value: string): boolean {
  if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(value)) return true;
  if (!value.includes(":") || !/^[0-9a-fA-F:.]+$/.test(value)) return false;
  try {
    // The URL parser accepts exactly the IPv6 address syntax.
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Why `value` is not a valid filter value for `dim` (the same rules as the
 * API, src/lib/analytics/dimensions.ts), or null when it is.
 */
export function filterValueError(dim: Dimension, value: string): string | null {
  if (!value) return "Enter a value";
  switch (dim) {
    case "host":
      return value.length > 255 ? "A host is at most 255 characters" : null;
    case "path":
      return value.length > 512 ? "A path is at most 512 characters" : null;
    case "user_agent":
      return value.length > 256 ? "A user agent is at most 256 characters" : null;
    case "country":
      return /^([A-Z]{2}|LAN)$/.test(value.toUpperCase()) ? null : "Country must be a two-letter code, LAN or XX";
    case "asn": {
      const match = /^(?:AS)?(\d{1,10})$/i.exec(value);
      return match && Number(match[1]) <= 0xffffffff ? null : "Network must be an AS number such as AS13335";
    }
    case "status":
      return /^[1-5]xx$/i.test(value) || /^\d{1,3}$/.test(value) ? null : "Status must be a code such as 404 or a class such as 5xx";
    case "method":
      return /^[A-Za-z0-9_.!#$%&'*+^`|~-]{1,32}$/.test(value) ? null : "Method must be an HTTP method such as GET";
    case "protocol":
      return /^[A-Za-z0-9./-]{1,16}$/.test(value) ? null : "HTTP version must look like HTTP/2.0";
    case "ip":
      return isIpAddress(value) ? null : "Source IP must be an IPv4 or IPv6 address";
    case "outcome":
      return (OUTCOMES as readonly string[]).includes(value) ? null : `Outcome must be one of ${OUTCOMES.join(", ")}`;
    case "waf_rule":
      return /^\d{1,10}$/.test(value) && Number(value) <= 0xffffffff ? null : "WAF rule must be a rule id such as 942100";
  }
}

/**
 * `filters` with `filter` added: an identical filter is not repeated, and
 * the opposite filter on the same value (is / is not) is replaced.
 */
export function addFilter(filters: readonly AnalyticsFilter[], filter: AnalyticsFilter): AnalyticsFilter[] {
  const kept = filters.filter((f) => !(f.dim === filter.dim && f.value === filter.value));
  if (kept.length >= MAX_FILTERS) return [...filters];
  return [...kept, filter];
}

/**
 * The filters of a `filters` parameter in the API's JSON format
 * ([{ dim, op: "is" | "is_not" | "contains" | "not_contains", value }]); entries off the allow-lists are
 * skipped.
 */
export function decodeFiltersJson(text: string | null): AnalyticsFilter[] {
  if (!text) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: AnalyticsFilter[] = [];
  for (const item of raw.slice(0, MAX_FILTERS * 2)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const { dim, op, value } = item as Record<string, unknown>;
    if (!isDimension(dim) || (typeof value !== "string" && typeof value !== "number")) continue;
    const parsedOp =
      op === undefined || op === null || op === "is"
        ? "is"
        : op === "is_not" || op === "is not" || op === "not"
          ? "is_not"
          : op === "contains" || op === "not_contains"
            ? op
            : null;
    if (!parsedOp) continue;
    if (parsedOp === "contains" || parsedOp === "not_contains") {
      const text = String(value).trim();
      if (text && isSearchableDimension(dim) && text.length <= MAX_CONTAINS_LENGTH) out.push({ dim, op: parsedOp, value: text });
      continue;
    }
    const normalized = normalizeFilterValue(dim, String(value));
    if (!normalized || filterValueError(dim, normalized)) continue;
    out.push({ dim, op: parsedOp, value: normalized });
  }
  return out;
}

// ── URL ──────────────────────────────────────────────────────────────────

type ParamReader = { get(name: string): string | null; getAll(name: string): string[] };

/** The view state in a query string; anything invalid falls back to its default. */
export function parseViewState(params: ParamReader, now = Math.floor(Date.now() / 1000)): ViewState {
  const state: ViewState = { ...DEFAULT_VIEW_STATE, filters: [] };
  const range = params.get("range");
  const from = unixSeconds(params.get("from"));
  const to = unixSeconds(params.get("to"));
  if ((range === "custom" || (range === null && from !== null)) && validCustomRange(from, to, now)) {
    state.range = "custom";
    state.from = from;
    state.to = to;
  } else if (isPreset(range)) {
    state.range = range;
  }
  const metric = params.get("metric");
  if (metric === "bandwidth") state.metric = "bytes";
  else if (isMetric(metric)) state.metric = metric;
  const group = params.get("group");
  if (isGrouping(group) && METRIC_GROUPINGS[state.metric].includes(group)) state.group = group;
  const compare = params.get("compare");
  if (compare === "0" || compare === "false") state.compare = false;
  const filters = [...decodeFiltersJson(params.get("filters")), ...params.getAll("filter").map(decodeFilter)];
  for (const filter of filters) {
    if (filter && state.filters.length < MAX_FILTERS) state.filters = addFilter(state.filters, filter);
  }
  const view = params.get("view");
  const viewId = parseRowId(view);
  if (viewId !== null) state.viewId = viewId;
  return state;
}

/** The query string of a view state, without the defaults. */
export function serializeViewState(state: ViewState): string {
  const params = new URLSearchParams();
  if (state.range === "custom" && state.from !== null && state.to !== null) {
    params.set("range", "custom");
    params.set("from", String(state.from));
    params.set("to", String(state.to));
  } else if (state.range !== DEFAULT_VIEW_STATE.range && state.range !== "custom") {
    params.set("range", state.range);
  }
  if (state.metric !== DEFAULT_VIEW_STATE.metric) params.set("metric", state.metric);
  if (state.group && state.group !== METRIC_GROUPINGS[state.metric][0] && METRIC_GROUPINGS[state.metric].includes(state.group)) {
    params.set("group", state.group);
  }
  if (!state.compare) params.set("compare", "0");
  for (const filter of state.filters) params.append("filter", encodeFilter(filter));
  if (state.viewId !== null) params.set("view", String(state.viewId));
  return params.toString();
}

/** The range parameters of the API (and of the security page link). */
export function rangeParams(state: Pick<ViewState, "range" | "from" | "to">): URLSearchParams {
  const params = new URLSearchParams();
  if (state.range === "custom" && state.from !== null && state.to !== null) {
    params.set("from", String(state.from));
    params.set("to", String(state.to));
  } else {
    params.set("range", state.range === "custom" ? DEFAULT_VIEW_STATE.range : state.range);
  }
  return params;
}

/**
 * A link to the Security events list for the same range and filters
 * (range, from, to and filters in the API's JSON format, then #events).
 */
export function securityEventsHref(state: Pick<ViewState, "range" | "from" | "to" | "filters">): string {
  const params = rangeParams(state);
  if (state.filters.length > 0) params.set("filters", JSON.stringify(state.filters));
  return `/security?${params.toString()}#events`;
}

/** Range and filters: the parameters of /top and /requests. */
export function listParams(state: ViewState): URLSearchParams {
  const params = rangeParams(state);
  if (state.filters.length > 0) params.set("filters", JSON.stringify(state.filters));
  return params;
}

/** Range, filters, metric and grouping: the parameters of /query. */
export function queryParams(state: ViewState): URLSearchParams {
  const params = listParams(state);
  params.set("metric", state.metric);
  params.set("groupBy", effectiveGrouping(state));
  return params;
}

// ── Saved views ──────────────────────────────────────────────────────────

/** The settings of a saved view (the comparison switch is kept as it is). */
export function stateFromSavedView(view: Pick<AnalyticsSavedView, "id" | "range" | "metric" | "groupBy" | "filters">, compare = true): ViewState {
  const range: Pick<ViewState, "range" | "from" | "to"> =
    "preset" in view.range
      ? { range: view.range.preset, from: null, to: null }
      : { range: "custom", from: view.range.from, to: view.range.to };
  const metric = isMetric(view.metric) ? view.metric : "requests";
  const group = view.groupBy && METRIC_GROUPINGS[metric].includes(view.groupBy) ? view.groupBy : null;
  const filters: AnalyticsFilter[] = [];
  for (const filter of view.filters) {
    if (isDimension(filter.dim) && filters.length < MAX_FILTERS) {
      const op = filter.op === "is_not" || filter.op === "contains" || filter.op === "not_contains" ? filter.op : "is";
      if ((op === "contains" || op === "not_contains") && !isSearchableDimension(filter.dim)) continue;
      filters.push({ dim: filter.dim, op, value: filter.value });
    }
  }
  return { ...range, metric, group, compare, filters, viewId: view.id };
}

/** What POST and PATCH /api/v1/analytics/views take for a view state. */
export function savedViewSettings(state: ViewState): { range: SavedViewRange; filters: AnalyticsFilter[]; metric: Metric; groupBy: Grouping | null } {
  const range: SavedViewRange =
    state.range === "custom" && state.from !== null && state.to !== null ? { from: state.from, to: state.to } : { preset: state.range === "custom" ? "24h" : state.range };
  return { range, filters: state.filters, metric: state.metric, groupBy: state.group };
}

/** True when `state` shows what `view` saved. */
export function matchesSavedView(state: ViewState, view: Pick<AnalyticsSavedView, "id" | "range" | "metric" | "groupBy" | "filters">): boolean {
  const saved = stateFromSavedView(view, state.compare);
  return serializeViewState({ ...saved, viewId: null }) === serializeViewState({ ...state, viewId: null });
}
