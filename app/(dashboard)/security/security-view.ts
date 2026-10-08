/**
 * Pure helpers of the Security events page, safe on the server and in the
 * browser: the sources and their colours, event wording, the page's URL
 * state, links to the analytics page, and "copy as curl".
 */

// ── Sources ─────────────────────────────────────────────────────────────

/** What stopped a request: the WAF, or a geo, access, sign-in or rate limit rule (src/lib/analytics/outcome.ts). */
export const SECURITY_SOURCES = ["waf", "geo", "access", "auth", "rate_limit"] as const;
export type SecuritySourceKey = (typeof SECURITY_SOURCES)[number];

export function isSecuritySource(value: unknown): value is SecuritySourceKey {
  return typeof value === "string" && (SECURITY_SOURCES as readonly string[]).includes(value);
}

export const SOURCE_LABELS: Record<SecuritySourceKey, string> = {
  waf: "WAF",
  geo: "Geo rules",
  access: "Access lists",
  auth: "Sign-in",
  rate_limit: "Rate limiting",
};

/** Short labels for the source filter. */
export const SOURCE_FILTER_LABELS: Record<SecuritySourceKey, string> = {
  waf: "WAF",
  geo: "Geo",
  access: "Access",
  auth: "Sign-in",
  rate_limit: "Rate limit",
};

/**
 * The orange family of "stopped" traffic, darkest first: the WAF, then geo
 * and access rules, then sign-in and rate limiting. Geo and sign-in are
 * mixes of their neighbours, so five sources stay apart in both themes.
 */
export const SOURCE_COLORS: Record<SecuritySourceKey, string> = {
  waf: "var(--waf)",
  geo: "color-mix(in srgb, var(--waf) 45%, var(--access))",
  access: "var(--access)",
  auth: "color-mix(in srgb, var(--access) 45%, var(--rl))",
  rate_limit: "var(--rl)",
};

// ── Events ──────────────────────────────────────────────────────────────

export type SecurityEventLike = {
  kind: SecuritySourceKey;
  blocked: boolean;
  status: number;
  country: string;
  ruleId: number | null;
  message: string | null;
};

/** The Action column: what happened to the request. */
export function eventActionLabel(event: Pick<SecurityEventLike, "kind" | "blocked">): string {
  switch (event.kind) {
    case "waf":
      return event.blocked ? "Blocked by WAF" : "Logged by WAF";
    case "geo":
      return "Geo rule";
    case "access":
      return "Access rule";
    case "auth":
      return "Sign-in required";
    case "rate_limit":
      return "Rate limited";
  }
}

/** True for a country code GeoIP knows (not LAN, not XX). */
function knownCountry(country: string): boolean {
  return /^[A-Z]{2}$/.test(country) && country !== "XX";
}

/** The Reason column of a request stopped by a rule other than the WAF (WAF events show their rule). */
export function eventReason(event: SecurityEventLike): string {
  switch (event.kind) {
    case "waf":
      return event.message ?? (event.ruleId !== null ? `Rule ${event.ruleId}` : "WAF rule");
    case "geo":
      return knownCountry(event.country) ? `Country, continent or network rule (${event.country})` : "Country, continent or network rule";
    case "access":
      return event.status === 401 ? "Access list: no valid user name and password" : "Address rule: the address is blocked";
    case "auth":
      return "Sent to sign-in (forward authentication)";
    case "rate_limit":
      return "Rate limit reached";
  }
}

/** "Why it was stopped" for the kinds other than the WAF, in a sentence or two. */
export function eventExplanation(event: SecurityEventLike & { ip: string }): string {
  const status = event.status > 0 ? ` Caddy answered ${event.status}.` : "";
  switch (event.kind) {
    case "waf":
      return event.blocked
        ? "The WAF blocked the request. Its audit record says which rules matched."
        : "The WAF matched the request in detection-only mode: it was logged and reached the upstream.";
    case "geo":
      return (
        (knownCountry(event.country)
          ? `${event.ip} is in ${event.country}. A country, continent or network (AS number) rule blocks it`
          : `A country, continent or network (AS number) rule blocks ${event.ip}, or its country is unknown and blocking fails closed`) +
        ", in the global geoblocking settings or the host's own." +
        status
      );
    case "access":
      return event.status === 401
        ? `The host is protected by an access list with user names and passwords, and the request had none or a wrong one.${status}`
        : `${event.ip} is listed in an address rule (a blocked address or network), so the request never reached the upstream.${status}`;
    case "auth":
      return "The host requires sign-in (forward authentication). The visitor was sent to the sign-in page; the request did not reach the upstream.";
    case "rate_limit":
      return `The client sent more requests than a rate limit rule allows, so Caddy answered 429 Too Many Requests instead of passing it on.`;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const pad2 = (n: number) => String(n).padStart(2, "0");

/** "3 Oct 11:35:58" in UTC. */
export function eventTime(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** "3 min ago", "5 h ago", "2 d ago", against `now` (Unix seconds). */
export function relativeTime(ts: number, now: number): string {
  const seconds = Math.max(0, now - ts);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

// ── OWASP CRS rule families ─────────────────────────────────────────────

const CRS_CATEGORIES: readonly { from: number; to: number; name: string }[] = [
  { from: 911000, to: 911999, name: "Method" },
  { from: 913000, to: 913999, name: "Scanner" },
  { from: 920000, to: 920999, name: "Protocol" },
  { from: 921000, to: 921999, name: "Protocol attack" },
  { from: 922000, to: 922999, name: "Multipart" },
  { from: 930000, to: 930999, name: "File access" },
  { from: 931000, to: 931999, name: "Remote file" },
  { from: 932000, to: 932999, name: "Remote code" },
  { from: 933000, to: 933999, name: "PHP" },
  { from: 934000, to: 934999, name: "Generic attack" },
  { from: 941000, to: 941999, name: "XSS" },
  { from: 942000, to: 942999, name: "SQL injection" },
  { from: 943000, to: 943999, name: "Session fixation" },
  { from: 944000, to: 944999, name: "Java" },
  { from: 949000, to: 949999, name: "Anomaly score" },
  { from: 950000, to: 959999, name: "Data leakage" },
];

/** A short category for a Core Rule Set rule id, or null for custom rules. */
export function ruleCategory(ruleId: number): string | null {
  return CRS_CATEGORIES.find((entry) => ruleId >= entry.from && ruleId <= entry.to)?.name ?? null;
}

// ── URL state ───────────────────────────────────────────────────────────

export type SecurityFilterDim = "host" | "waf_rule" | "ip" | "path" | "country";
export const SECURITY_FILTER_DIMS: readonly SecurityFilterDim[] = ["host", "waf_rule", "ip", "path", "country"];

export type SecurityFilter = { dim: string; op: "is" | "is_not"; value: string };

/** What the page's URL holds. Absent values are the defaults (last 7 days, every source, no filters, page 1). */
export type SecurityQuery = {
  range: string | null;
  from: number | null;
  to: number | null;
  kind: string | null;
  filters: readonly SecurityFilter[];
  page: number;
};

export const DEFAULT_QUERY: SecurityQuery = { range: null, from: null, to: null, kind: null, filters: [], page: 1 };

/**
 * Filters from the URL's JSON, leniently: anything that is not an array of
 * {dim, op, value} strings is dropped, and op reads as the analytics
 * parser reads it (filters.ts). The server validates them again before any
 * query runs; this only decides which chips to show.
 */
export function readFilters(raw: string | null | undefined): SecurityFilter[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: SecurityFilter[] = [];
  for (const item of parsed.slice(0, 20)) {
    if (!item || typeof item !== "object") continue;
    const { dim, op, value } = item as Record<string, unknown>;
    if (typeof dim !== "string" || (typeof value !== "string" && typeof value !== "number")) continue;
    out.push({ dim: dim.slice(0, 32), op: op === "is_not" || op === "is not" || op === "not" ? "is_not" : "is", value: String(value).slice(0, 512) });
  }
  return out;
}

/** The page URL for `query` changed by `changes`; the page goes back to 1 unless `changes` sets it. */
export function securityHref(query: SecurityQuery, changes: Partial<SecurityQuery> = {}, hash = ""): string {
  const next: SecurityQuery = { ...query, page: 1, ...changes };
  const params = new URLSearchParams();
  if (next.range === "custom" && next.from !== null && next.to !== null) {
    params.set("range", "custom");
    params.set("from", String(next.from));
    params.set("to", String(next.to));
  } else if (next.range && next.range !== "custom") {
    params.set("range", next.range);
  }
  if (next.kind) params.set("kind", next.kind);
  if (next.filters.length > 0) params.set("filters", JSON.stringify(next.filters.map(({ dim, op, value }) => ({ dim, op, value }))));
  if (next.page > 1) params.set("page", String(next.page));
  const search = params.toString();
  return `/security${search ? `?${search}` : ""}${hash}`;
}

/** The query with one more filter (an identical one is not added twice). */
export function withFilter(query: SecurityQuery, filter: SecurityFilter): SecurityFilter[] {
  const exists = query.filters.some((f) => f.dim === filter.dim && f.op === filter.op && f.value === filter.value);
  return exists ? [...query.filters] : [...query.filters, filter];
}

/**
 * A link to the analytics page for the same range, with analytics filters
 * (the format of /api/v1/analytics, src/lib/analytics/filters.ts).
 */
export function analyticsHref(query: Pick<SecurityQuery, "range" | "from" | "to">, filters: readonly SecurityFilter[] = []): string {
  const params = new URLSearchParams();
  if (query.range === "custom" && query.from !== null && query.to !== null) {
    params.set("range", "custom");
    params.set("from", String(query.from));
    params.set("to", String(query.to));
  } else {
    params.set("range", query.range ?? "7d");
  }
  if (filters.length > 0) params.set("filters", JSON.stringify(filters));
  return `/analytics?${params.toString()}`;
}

// ── Copy as curl ────────────────────────────────────────────────────────

/** A shell word in single quotes; a quote inside is closed, escaped and reopened. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Control characters (newlines included) would split or hide parts of the command; they become spaces. */
function oneLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, " ");
}

/** Headers curl sets itself, or that only describe the hop from the client. */
const SKIPPED_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-connection",
  "proxy-authorization",
]);

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const METHOD = /^[A-Za-z]{1,16}$/;

export type CurlRequest = {
  method: string | null;
  host: string;
  /** The path with its query string. */
  uri: string;
  headers?: Record<string, readonly string[]> | null;
};

/**
 * A curl command that repeats the request (over HTTPS, as the WAF saw it
 * behind Caddy's TLS). Request data is attacker-controlled: every value is
 * single-quoted with control characters removed, and header names that are
 * not HTTP tokens are left out. Stored credential values were redacted when
 * the event was ingested.
 */
export function curlCommand(request: CurlRequest): string {
  const method = request.method && METHOD.test(request.method) ? request.method.toUpperCase() : "GET";
  const host = oneLine(request.host).trim();
  const uri = oneLine(request.uri || "/");
  const url = `https://${host}${uri.startsWith("/") ? uri : `/${uri}`}`;
  const parts = ["curl"];
  if (method !== "GET") parts.push("-X", method);
  parts.push(shellQuote(url));
  for (const [name, values] of Object.entries(request.headers ?? {})) {
    if (!HEADER_NAME.test(name) || SKIPPED_HEADERS.has(name.toLowerCase())) continue;
    for (const value of values) parts.push("-H", shellQuote(`${name}: ${oneLine(value)}`));
  }
  return parts.join(" ");
}

const CONTROL_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/** C0 and C1 control characters, DEL, and U+FFFD (bytes that were not UTF-8). */
function isInvisible(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0xfffd;
}

/**
 * Request data as text that shows what is there: control characters (the
 * CR/LF of a header injection, a NUL) as escapes such as \r\n and \x00, and
 * U+FFFD as �, instead of boxes.
 */
export function visibleText(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (!isInvisible(code)) out += char;
    else if (CONTROL_ESCAPES[char]) out += CONTROL_ESCAPES[char];
    else if (code === 0xfffd) out += "\\ufffd";
    else out += `\\x${code.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/**
 * A Coraza "Matched Data: <data> found within <VARIABLE>: <value>" message,
 * split: what matched (kept exactly, so a CR/LF that matched is not trimmed
 * away), where, and the whole value it was in. Anything else is `data`.
 */
export function splitMatchedData(message: string): { data: string; variable: string | null; value: string | null } {
  const body = message.replace(/^\s*Matched Data: ?/, "");
  const match = body.match(/^([\s\S]*?) found within ([A-Z_]+(?::[^\s:]*)?): ([\s\S]*)$/);
  if (!match) return { data: body, variable: null, value: null };
  return { data: match[1], variable: match[2], value: match[3] };
}
