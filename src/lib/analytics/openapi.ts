/**
 * OpenAPI paths and schemas of /api/v1/analytics, spread into
 * app/api/v1/openapi.json/route.ts. Enumerations come from the allow-lists
 * the query layer enforces, so the document cannot drift from them.
 */
import { DIMENSIONS, GROUPINGS, METRICS } from "./dimensions";
import { FILTER_OPS, MAX_FILTERS } from "./filters";
import { OUTCOMES } from "./outcome";
import { MAX_RANGE_SECONDS, RANGE_PRESETS } from "./range";
import { MAX_REQUEST_LIMIT, MAX_REQUEST_OFFSET } from "./requests";
import { SECURITY_EVENT_FILTER_DIMENSIONS, SECURITY_EVENT_KINDS } from "./security";
import { MAX_TOP_LIMIT } from "./top";

const TAG = "Analytics";

export const ANALYTICS_OPENAPI_TAG = {
  name: TAG,
  description:
    "Traffic analytics from ClickHouse: queries over a range with filters, top values, the request log, per-host summaries, " +
    "security events, traffic signals and saved views. Permission analytics:read. When analytics is off or ClickHouse cannot answer, a query " +
    'still answers 200 with empty data and status "disabled" or "unavailable". Analytics are kept for the retention ' +
    "window (CLICKHOUSE_RETENTION_DAYS, 30 days by default).",
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });
const errors = (...codes: string[]) => {
  const map: Record<string, unknown> = {
    "400": { $ref: "#/components/responses/BadRequest" },
    "401": { $ref: "#/components/responses/Unauthorized" },
    "403": { $ref: "#/components/responses/Forbidden" },
    "404": { $ref: "#/components/responses/NotFound" },
    "409": { $ref: "#/components/responses/Conflict" },
  };
  return Object.fromEntries(codes.map((code) => [code, map[code]]));
};
const numbers = { type: "array", items: { type: "number" } };
const nullableNumber = { type: ["number", "null"] };

// ── Parameters ───────────────────────────────────────────────────────────

const rangeParams = (fallback: string) => [
  {
    name: "range",
    in: "query",
    schema: { type: "string", enum: [...Object.keys(RANGE_PRESETS), "custom"], default: fallback },
    description:
      "A preset ending now (1h: 1-minute buckets, 24h: 30 minutes, 7d: 3 hours, 30d: 1 day), or custom with from and to. " +
      "Buckets are aligned to their step in UTC; the last one holds now.",
  },
  {
    name: "from",
    in: "query",
    schema: { type: "integer", minimum: 0 },
    description: `Custom range start, Unix seconds. With to; at most ${MAX_RANGE_SECONDS / 86_400} days. The step keeps the range at about 60 buckets.`,
  },
  { name: "to", in: "query", schema: { type: "integer", minimum: 0 }, description: "Custom range end, Unix seconds." },
];

const filtersParam = {
  name: "filters",
  in: "query",
  schema: { type: "string" },
  example: '[{"dim":"host","op":"is","value":"app.example.com"},{"dim":"status","op":"is","value":"5xx"}]',
  description:
    `JSON array of at most ${MAX_FILTERS} filters (schema AnalyticsFilter). Several "is" and "contains" filters on one dimension ` +
    'match any of them; "is_not" and "not_contains" filters exclude each; filters on different dimensions all apply.',
};

const limitParam = (fallback: number, max: number) => ({
  name: "limit",
  in: "query",
  schema: { type: "integer", minimum: 1, maximum: max, default: fallback },
});
const offsetParam = { name: "offset", in: "query", schema: { type: "integer", minimum: 0, maximum: MAX_REQUEST_OFFSET, default: 0 } };

// ── Paths ────────────────────────────────────────────────────────────────

const read = (summary: string, operationId: string, description: string, parameters: unknown[], schema: string, codes = ["400", "401", "403"]) => ({
  get: {
    tags: [TAG],
    summary,
    operationId,
    description: `Permission analytics:read. ${description}`,
    parameters,
    responses: { "200": { description: summary, content: json(ref(schema)) }, ...errors(...codes) },
  },
});

export const ANALYTICS_OPENAPI_PATHS = {
  "/api/v1/analytics/query": read(
    "Query traffic over a range",
    "queryAnalytics",
    "One metric split into buckets and grouped, the same for the previous period, the five headline numbers with their " +
      "change, and the peak bucket. The previous period is the same length right before the range; when any of it is " +
      'older than the retention window, `previous` is {"available": false, "reason": "retention"} (a 30-day range with ' +
      "the default 30-day retention never has one).",
    [
      ...rangeParams("24h"),
      filtersParam,
      {
        name: "metric",
        in: "query",
        schema: { type: "string", enum: [...METRICS], default: "requests" },
        description:
          "requests, bytes (bytes sent), visitors (distinct client addresses, approximate), mitigated (every outcome but served), " +
          "errors (responses with status 400 or more).",
      },
      {
        name: "groupBy",
        in: "query",
        schema: { type: "string", enum: [...GROUPINGS] },
        description: "Default: outcome for requests and mitigated, status for errors, none for bytes and visitors. host shows the busiest topHosts hosts and the rest as __other__.",
      },
      { name: "topHosts", in: "query", schema: { type: "integer", minimum: 1, maximum: 10, default: 4 } },
    ],
    "AnalyticsQueryResult"
  ),
  "/api/v1/analytics/top": read(
    "Top values of each dimension",
    "getAnalyticsTopDimensions",
    "For each dimension, its busiest values for the range and filters, with each row's request count, share of all " +
      "matching requests and share of its requests that were mitigated. Country LAN is a private address, XX an unknown one.",
    [
      ...rangeParams("24h"),
      filtersParam,
      {
        name: "dimensions",
        in: "query",
        schema: { type: "string" },
        description: `Comma-separated, from ${DIMENSIONS.join(", ")}. Default: all.`,
      },
      limitParam(6, MAX_TOP_LIMIT),
    ],
    "AnalyticsTopResult"
  ),
  "/api/v1/analytics/values": read(
    "Search the values of the dimensions",
    "searchAnalyticsValues",
    "For host, path, ip and user_agent, the values containing q (any case) within the range and filters, most requested " +
      "first: what to filter by when only part of a name or path is known. Filter by one with op is, or by the text with op contains.",
    [...rangeParams("24h"), filtersParam, { name: "q", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 256 } }, limitParam(5, 8)],
    "AnalyticsValueSearchResult"
  ),
  "/api/v1/analytics/requests": read(
    "List the latest matching requests",
    "listAnalyticsRequests",
    "The request log: newest first, every logged request (nothing is sampled). Paths come without their query string.",
    [...rangeParams("24h"), filtersParam, limitParam(50, MAX_REQUEST_LIMIT), offsetParam],
    "AnalyticsRequestLog"
  ),
  "/api/v1/analytics/hosts": read(
    "Summarise traffic per proxy host",
    "getAnalyticsHostSummaries",
    "Requests, 5xx responses, mitigated requests, bytes sent and a sparkline (about 24 points) for each proxy host the " +
      "caller's role reaches (a tag-scoped role gets its tagged hosts only). A host's traffic is that of " +
      "the Host names its domains serve: equal to a domain, or one label under a wildcard domain, port and case ignored.",
    [
      ...rangeParams("24h"),
      { name: "ids", in: "query", schema: { type: "string" }, description: "Comma-separated proxy host ids to limit the list to." },
    ],
    "AnalyticsHostSummaries"
  ),
  "/api/v1/analytics/hosts/{id}": read(
    "Summarise one proxy host's traffic",
    "getAnalyticsHostDetail",
    "Requests, 5xx responses and mitigated requests per bucket, distinct clients, bytes sent, the busiest paths with " +
      "their most frequent status codes, and every status code. A host outside the caller's scope answers 404 like a missing one.",
    [{ $ref: "#/components/parameters/IdPath" }, ...rangeParams("24h")],
    "AnalyticsHostDetail",
    ["400", "401", "403", "404"]
  ),
  "/api/v1/analytics/security/series": read(
    "Count mitigated requests by source over time",
    "getAnalyticsSecuritySeries",
    "Mitigated requests per bucket for each source (waf, geo, access, auth, rate_limit), their total against all requests " +
      "and against the previous period, and the peak bucket.",
    rangeParams("7d"),
    "AnalyticsSecuritySeries"
  ),
  "/api/v1/analytics/security/rules": read(
    "List the WAF rules that matched most",
    "listAnalyticsSecurityRules",
    "From the WAF events (detection-only matches included): each rule's events, blocks, distinct sources, busiest hosts " +
      "and paths, and a sparkline.",
    [...rangeParams("7d"), limitParam(6, MAX_TOP_LIMIT)],
    "AnalyticsSecurityRules"
  ),
  "/api/v1/analytics/security/sources": read(
    "List the source addresses mitigated most",
    "listAnalyticsSecuritySources",
    "Addresses ranked by WAF events plus requests stopped by geo, access, sign-in and rate limit rules, with country, " +
      "network and the WAF rules they triggered.",
    [...rangeParams("7d"), limitParam(6, MAX_TOP_LIMIT)],
    "AnalyticsSecuritySources"
  ),
  "/api/v1/analytics/security/hosts": read(
    "List the hosts mitigated most",
    "listAnalyticsSecurityHosts",
    "Host names (port and case ignored) ranked by WAF events plus requests stopped by geo, access, sign-in and rate limit " +
      "rules, with the proxy host serving each name, and the total of all events.",
    [...rangeParams("7d"), limitParam(6, MAX_TOP_LIMIT)],
    "AnalyticsSecurityHosts"
  ),
  "/api/v1/analytics/security/events": read(
    "List security events",
    "listAnalyticsSecurityEvents",
    "WAF events and requests stopped by the other rules, newest first. A WAF event's eventId is its id for " +
      "GET /api/v1/waf/events/{id}/explain (permission waf:read), which also reads its raw Coraza audit record.",
    [
      ...rangeParams("7d"),
      {
        name: "kind",
        in: "query",
        schema: { type: "string" },
        description: `Comma-separated, from ${SECURITY_EVENT_KINDS.join(", ")}. Default: all.`,
      },
      {
        ...filtersParam,
        example: '[{"dim":"host","op":"is","value":"app.example.com"},{"dim":"waf_rule","op":"is","value":"930130"}]',
        description:
          `JSON array of filters (schema AnalyticsFilter) on ${SECURITY_EVENT_FILTER_DIMENSIONS.join(", ")}. A host matches ` +
          "port and case ignored; a waf_rule filter leaves out the requests the other rules stopped.",
      },
      limitParam(50, MAX_REQUEST_LIMIT),
      offsetParam,
    ],
    "AnalyticsSecurityEvents"
  ),
  "/api/v1/analytics/signals": read(
    "Get traffic signals that need attention",
    "getAnalyticsSignals",
    "For the overview: 5xx bursts per host in the last 24 hours (at least 10 5xx responses and 10% of the host's requests " +
      "in a run of minutes), mitigation spikes (at least 50 mitigated requests in 24 hours and three times the host's daily " +
      "average over the 7 days before), and blocked-traffic concentrations (at least 50 mitigated requests to one host and " +
      "path with one outcome in 24 hours). At most five of each.",
    [],
    "AnalyticsSignals",
    ["401", "403"]
  ),
  "/api/v1/analytics/views": {
    get: {
      tags: [TAG],
      summary: "List saved analytics views",
      operationId: "listAnalyticsViews",
      description: "Permission analytics:read. The caller's views and the views others shared.",
      responses: { "200": { description: "Views", content: json({ type: "array", items: ref("AnalyticsView") }) }, ...errors("401", "403") },
    },
    post: {
      tags: [TAG],
      summary: "Save an analytics view",
      operationId: "createAnalyticsView",
      description: "Permission analytics:read. At most 100 views per user (409 beyond). Recorded in the audit log.",
      requestBody: { required: true, content: json(ref("AnalyticsViewInput")) },
      responses: { "201": { description: "Saved", content: json(ref("AnalyticsView")) }, ...errors("400", "401", "403", "409") },
    },
  },
  "/api/v1/analytics/views/{id}": {
    get: {
      tags: [TAG],
      summary: "Get a saved analytics view",
      operationId: "getAnalyticsView",
      description: "Permission analytics:read. A view the caller cannot see answers 404 like a missing one.",
      parameters: [{ $ref: "#/components/parameters/IdPath" }],
      responses: { "200": { description: "View", content: json(ref("AnalyticsView")) }, ...errors("400", "401", "403", "404") },
    },
    patch: {
      tags: [TAG],
      summary: "Change a saved analytics view",
      operationId: "updateAnalyticsView",
      description: "Permission analytics:read. Only the user who saved the view (403 for a shared view of someone else). Recorded in the audit log.",
      parameters: [{ $ref: "#/components/parameters/IdPath" }],
      requestBody: { required: true, content: json(ref("AnalyticsViewUpdate")) },
      responses: { "200": { description: "Changed", content: json(ref("AnalyticsView")) }, ...errors("400", "401", "403", "404") },
    },
    delete: {
      tags: [TAG],
      summary: "Delete a saved analytics view",
      operationId: "deleteAnalyticsView",
      description: "Permission analytics:read. The user who saved the view, or an administrator for a shared view. Recorded in the audit log.",
      parameters: [{ $ref: "#/components/parameters/IdPath" }],
      responses: { "200": { $ref: "#/components/responses/Ok" }, ...errors("400", "401", "403", "404") },
    },
  },
};

// ── Schemas ──────────────────────────────────────────────────────────────

const status = ref("AnalyticsStatus");
const rangeOut = {
  type: "object",
  properties: {
    preset: { type: "string", enum: [...Object.keys(RANGE_PRESETS), "custom"] },
    start: { type: "integer", description: "First bucket's start, Unix seconds" },
    end: { type: "integer", description: "Last bucket's end (exclusive), Unix seconds" },
    step: { type: "integer", description: "Seconds per bucket" },
    buckets: { type: "integer" },
  },
  required: ["preset", "start", "end", "step", "buckets"],
};
const peak = {
  type: ["object", "null"],
  properties: { index: { type: "integer" }, ts: { type: "integer" }, value: { type: "number" } },
  required: ["index", "ts", "value"],
};
const viewRange = {
  oneOf: [
    { type: "string", enum: Object.keys(RANGE_PRESETS) },
    { type: "object", properties: { preset: { type: "string", enum: Object.keys(RANGE_PRESETS) } }, required: ["preset"], additionalProperties: false },
    {
      type: "object",
      properties: { from: { type: "integer", minimum: 0 }, to: { type: "integer", minimum: 0 } },
      required: ["from", "to"],
      additionalProperties: false,
    },
  ],
};
const outcome = { type: "string", enum: [...OUTCOMES] };

export const ANALYTICS_OPENAPI_SCHEMAS = {
  AnalyticsStatus: {
    type: "string",
    enum: ["ok", "disabled", "unavailable"],
    description: "ok: from ClickHouse. disabled: analytics is not configured. unavailable: ClickHouse did not answer; the data is empty.",
  },
  AnalyticsOutcome: {
    ...outcome,
    description:
      "What happened to a request. served; waf (the WAF blocked it); geo (a country, continent or AS number rule); access " +
      "(an address rule or basic authentication refused it); auth (a forward-auth sign-in redirect); rate_limit (the rate " +
      "limiter refused it). Every outcome but served counts as mitigated.",
  },
  AnalyticsFilter: {
    type: "object",
    additionalProperties: false,
    properties: {
      dim: { type: "string", enum: [...DIMENSIONS] },
      op: { type: "string", enum: [...FILTER_OPS], default: "is" },
      value: {
        type: "string",
        description:
          "host: as logged. path: without the query string. country: two-letter code, LAN or XX. asn: 13335 or AS13335. " +
          "status: a code (404) or a class (5xx). ip: one address. user_agent: a family such as \"Chrome · Windows\". " +
          "outcome: an AnalyticsOutcome. waf_rule: a rule id. With contains or not_contains: part of the text, any case, " +
          "on host, path, user_agent and ip only (at most 256 characters).",
      },
    },
    required: ["dim", "value"],
  },
  AnalyticsSeries: {
    type: "object",
    properties: { key: { type: "string" }, label: { type: "string" }, values: numbers, total: { type: "number" } },
    required: ["key", "label", "values", "total"],
  },
  AnalyticsHeadline: {
    type: "object",
    properties: {
      value: { type: "number" },
      previous: { ...nullableNumber, description: "Null without a previous period" },
      delta: { ...nullableNumber, description: "Relative change (0.25 = +25%); null without a previous period or when it was 0" },
    },
    required: ["value", "previous", "delta"],
  },
  AnalyticsQueryResult: {
    type: "object",
    properties: {
      status,
      range: rangeOut,
      metric: { type: "string", enum: [...METRICS] },
      groupBy: { type: "string", enum: [...GROUPINGS] },
      filters: { type: "array", items: ref("AnalyticsFilter") },
      series: { type: "array", items: ref("AnalyticsSeries") },
      totals: { ...numbers, description: "Sum of the series per bucket" },
      previous: {
        oneOf: [
          {
            type: "object",
            properties: {
              available: { type: "boolean", enum: [true] },
              start: { type: "integer" },
              end: { type: "integer" },
              series: { type: "array", items: ref("AnalyticsSeries") },
              totals: numbers,
            },
            required: ["available", "start", "end", "series", "totals"],
          },
          {
            type: "object",
            properties: {
              available: { type: "boolean", enum: [false] },
              reason: { type: "string", enum: ["retention"] },
              start: { type: "integer" },
              end: { type: "integer" },
            },
            required: ["available", "reason", "start", "end"],
          },
        ],
      },
      headline: {
        type: "object",
        properties: {
          requests: ref("AnalyticsHeadline"),
          bytes: ref("AnalyticsHeadline"),
          visitors: ref("AnalyticsHeadline"),
          mitigated: { allOf: [ref("AnalyticsHeadline"), { type: "object", properties: { share: { type: "number" } }, required: ["share"] }] },
          errorRate5xx: {
            allOf: [
              ref("AnalyticsHeadline"),
              { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
            ],
            description: "value is 5xx responses over requests (0 to 1)",
          },
        },
        required: ["requests", "bytes", "visitors", "mitigated", "errorRate5xx"],
      },
      headlineSeries: {
        type: "object",
        properties: { requests: numbers, bytes: numbers, visitors: numbers, mitigated: numbers, errors5xx: numbers },
        required: ["requests", "bytes", "visitors", "mitigated", "errors5xx"],
      },
      peak,
      peakMitigated: peak,
      retention: {
        type: "object",
        properties: { days: { type: "integer" }, start: { type: "integer", description: "Unix seconds before which data may be gone" } },
        required: ["days", "start"],
      },
    },
    required: ["status", "range", "metric", "groupBy", "filters", "series", "totals", "previous", "headline", "headlineSeries", "peak", "peakMitigated", "retention"],
  },
  AnalyticsTopRow: {
    type: "object",
    properties: {
      value: { type: "string" },
      count: { type: "integer" },
      share: { type: "number" },
      mitigated: { type: "integer" },
      mitigatedShare: { type: "number" },
      label: { type: ["string", "null"], description: "asn: the network's organisation. waf_rule: the rule's message." },
      country: { type: "string", description: "ip rows" },
      asn: { type: "integer", description: "ip rows" },
      asOrg: { type: "string", description: "ip rows" },
    },
    required: ["value", "count", "share", "mitigated", "mitigatedShare"],
  },
  AnalyticsValueSearchResult: {
    type: "object",
    properties: {
      status,
      query: { type: "string" },
      dimensions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            dimension: { type: "string", enum: ["host", "path", "ip", "user_agent"] },
            label: { type: "string" },
            values: { type: "array", items: { type: "object", properties: { value: { type: "string" }, count: { type: "integer" } }, required: ["value", "count"] } },
          },
          required: ["dimension", "label", "values"],
        },
      },
    },
    required: ["status", "query", "dimensions"],
  },
  AnalyticsTopResult: {
    type: "object",
    properties: {
      status,
      total: { type: "integer" },
      dimensions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            dimension: { type: "string", enum: [...DIMENSIONS] },
            label: { type: "string" },
            rows: { type: "array", items: ref("AnalyticsTopRow") },
            distinct: { type: "integer" },
            classes: {
              type: "array",
              description: "status only",
              items: {
                type: "object",
                properties: { class: { type: "string" }, count: { type: "integer" }, share: { type: "number" } },
                required: ["class", "count", "share"],
              },
            },
          },
          required: ["dimension", "label", "rows", "distinct"],
        },
      },
    },
    required: ["status", "total", "dimensions"],
  },
  AnalyticsRequestLog: {
    type: "object",
    properties: {
      status,
      limit: { type: "integer" },
      offset: { type: "integer" },
      requests: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ts: { type: "integer" },
            outcome,
            method: { type: "string" },
            host: { type: "string" },
            path: { type: "string" },
            status: { type: "integer" },
            country: { type: "string" },
            asn: { type: "integer" },
            asOrg: { type: "string" },
            ip: { type: "string" },
            userAgent: { type: "string", description: "User-agent family" },
            durationMs: { type: "integer" },
            bytes: { type: "integer" },
            wafRuleId: { type: "integer", description: "0 unless the WAF blocked it" },
          },
          required: ["ts", "outcome", "method", "host", "path", "status", "country", "asn", "asOrg", "ip", "userAgent", "durationMs", "bytes", "wafRuleId"],
        },
      },
    },
    required: ["status", "limit", "offset", "requests"],
  },
  AnalyticsHostSummaries: {
    type: "object",
    properties: {
      status,
      range: { type: "object", properties: { preset: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } }, required: ["preset", "start", "end"] },
      sparklineStep: { type: "integer" },
      hosts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            proxyHostId: { type: "integer" },
            requests: { type: "integer" },
            errors5xx: { type: "integer" },
            errorRate5xx: { type: "number" },
            mitigated: { type: "integer" },
            bytes: { type: "integer" },
            sparkline: numbers,
          },
          required: ["proxyHostId", "requests", "errors5xx", "errorRate5xx", "mitigated", "bytes", "sparkline"],
        },
      },
    },
    required: ["status", "range", "sparklineStep", "hosts"],
  },
  AnalyticsHostDetail: {
    type: "object",
    properties: {
      status,
      proxyHostId: { type: "integer" },
      range: rangeOut,
      totals: {
        type: "object",
        properties: {
          requests: { type: "integer" },
          errors5xx: { type: "integer" },
          errorRate5xx: { type: "number" },
          mitigated: { type: "integer" },
          bytes: { type: "integer" },
          clients: { type: "integer" },
        },
        required: ["requests", "errors5xx", "errorRate5xx", "mitigated", "bytes", "clients"],
      },
      series: {
        type: "object",
        properties: { requests: numbers, errors5xx: numbers, mitigated: numbers, bytes: numbers },
        required: ["requests", "errors5xx", "mitigated", "bytes"],
      },
      topPaths: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            count: { type: "integer" },
            mitigated: { type: "integer" },
            statuses: {
              type: "array",
              items: { type: "object", properties: { status: { type: "integer" }, count: { type: "integer" } }, required: ["status", "count"] },
            },
          },
          required: ["path", "count", "mitigated", "statuses"],
        },
      },
      statusCodes: {
        type: "array",
        items: {
          type: "object",
          properties: { status: { type: "integer" }, count: { type: "integer" }, share: { type: "number" } },
          required: ["status", "count", "share"],
        },
      },
    },
    required: ["status", "proxyHostId", "range", "totals", "series", "topPaths", "statusCodes"],
  },
  AnalyticsSecuritySeries: {
    type: "object",
    properties: {
      status,
      range: rangeOut,
      series: { type: "array", items: ref("AnalyticsSeries") },
      totals: {
        type: "object",
        properties: {
          mitigated: { type: "integer" },
          requests: { type: "integer" },
          share: { type: "number" },
          previousMitigated: { type: ["integer", "null"] },
          delta: nullableNumber,
        },
        required: ["mitigated", "requests", "share", "previousMitigated", "delta"],
      },
      peak: {
        type: ["object", "null"],
        properties: {
          index: { type: "integer" },
          ts: { type: "integer" },
          value: { type: "integer" },
          bySource: { type: "object", additionalProperties: { type: "integer" } },
          top: {
            type: ["object", "null"],
            description: "The busiest source address, host and WAF rule of the peak bucket (WAF events and other mitigated requests).",
            properties: {
              addresses: { type: "integer" },
              source: {
                type: ["object", "null"],
                properties: { ip: { type: "string" }, country: { type: "string" }, count: { type: "integer" } },
                required: ["ip", "country", "count"],
              },
              host: {
                type: ["object", "null"],
                properties: { name: { type: "string" }, count: { type: "integer" } },
                required: ["name", "count"],
              },
              rule: {
                type: ["object", "null"],
                properties: { ruleId: { type: "integer" }, message: { type: ["string", "null"] }, count: { type: "integer" } },
                required: ["ruleId", "message", "count"],
              },
            },
            required: ["addresses", "source", "host", "rule"],
          },
        },
        required: ["index", "ts", "value", "bySource", "top"],
      },
    },
    required: ["status", "range", "series", "totals", "peak"],
  },
  AnalyticsSecurityRules: {
    type: "object",
    properties: {
      status,
      sparklineStep: { type: "integer" },
      totals: { type: "object", properties: { events: { type: "integer" }, rulesMatched: { type: "integer" } }, required: ["events", "rulesMatched"] },
      rules: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ruleId: { type: "integer" },
            message: { type: ["string", "null"] },
            severity: { type: ["string", "null"] },
            events: { type: "integer" },
            blocked: { type: "integer" },
            sources: { type: "integer" },
            hostCount: { type: "integer" },
            pathCount: { type: "integer" },
            hosts: { type: "array", items: { type: "object", properties: { host: { type: "string" }, count: { type: "integer" } }, required: ["host", "count"] } },
            paths: { type: "array", items: { type: "object", properties: { path: { type: "string" }, count: { type: "integer" } }, required: ["path", "count"] } },
            sparkline: numbers,
          },
          required: ["ruleId", "message", "severity", "events", "blocked", "sources", "hostCount", "pathCount", "hosts", "paths", "sparkline"],
        },
      },
    },
    required: ["status", "sparklineStep", "totals", "rules"],
  },
  AnalyticsSecuritySources: {
    type: "object",
    properties: {
      status,
      totals: { type: "object", properties: { addresses: { type: "integer" } }, required: ["addresses"] },
      sources: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ip: { type: "string" },
            country: { type: "string" },
            asn: { type: "integer" },
            asOrg: { type: "string" },
            wafEvents: { type: "integer" },
            wafBlocked: { type: "integer" },
            otherMitigated: { type: "integer" },
            rules: { type: "array", items: { type: "integer" } },
            hosts: { type: "integer" },
            lastSeen: { type: "integer" },
          },
          required: ["ip", "country", "asn", "asOrg", "wafEvents", "wafBlocked", "otherMitigated", "rules", "hosts", "lastSeen"],
        },
      },
    },
    required: ["status", "totals", "sources"],
  },
  AnalyticsSecurityHosts: {
    type: "object",
    properties: {
      status,
      totals: { type: "object", properties: { events: { type: "integer" } }, required: ["events"] },
      hosts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            host: { type: "string" },
            events: { type: "integer" },
            wafEvents: { type: "integer" },
            otherMitigated: { type: "integer" },
            proxyHostId: { type: ["integer", "null"] },
          },
          required: ["host", "events", "wafEvents", "otherMitigated", "proxyHostId"],
        },
      },
    },
    required: ["status", "totals", "hosts"],
  },
  AnalyticsSecurityEvents: {
    type: "object",
    properties: {
      status,
      limit: { type: "integer" },
      offset: { type: "integer" },
      events: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ts: { type: "integer" },
            kind: { type: "string", enum: [...SECURITY_EVENT_KINDS] },
            eventId: { type: ["string", "null"], description: "WAF events: the id for GET /api/v1/waf/events/{id}/explain" },
            blocked: { type: "boolean", description: "False for a WAF match in detection-only mode" },
            host: { type: "string" },
            method: { type: "string" },
            path: { type: "string" },
            ip: { type: "string" },
            country: { type: "string" },
            ruleId: { type: ["integer", "null"] },
            message: { type: ["string", "null"] },
            severity: { type: ["string", "null"] },
            status: { type: "integer", description: "0 for WAF events" },
          },
          required: ["ts", "kind", "eventId", "blocked", "host", "method", "path", "ip", "country", "ruleId", "message", "severity", "status"],
        },
      },
    },
    required: ["status", "limit", "offset", "events"],
  },
  AnalyticsSignals: {
    type: "object",
    properties: {
      status,
      generatedAt: { type: "integer" },
      errorBursts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            host: { type: "string" },
            proxyHostId: { type: ["integer", "null"] },
            count: { type: "integer" },
            requests: { type: "integer" },
            start: { type: "integer" },
            end: { type: "integer" },
            ongoing: { type: "boolean" },
            status: { type: "integer" },
            method: { type: "string" },
            path: { type: "string" },
          },
          required: ["host", "proxyHostId", "count", "requests", "start", "end", "ongoing", "status", "method", "path"],
        },
      },
      mitigationSpikes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            host: { type: "string" },
            proxyHostId: { type: ["integer", "null"] },
            count: { type: "integer" },
            baseline: { type: "number", description: "Daily average over the 7 days before" },
            factor: nullableNumber,
            topOutcome: outcome,
          },
          required: ["host", "proxyHostId", "count", "baseline", "factor", "topOutcome"],
        },
      },
      blockedConcentrations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            host: { type: "string" },
            proxyHostId: { type: ["integer", "null"] },
            path: { type: "string" },
            outcome,
            count: { type: "integer" },
            shareOfHost: { type: "number" },
            countries: {
              type: "array",
              items: { type: "object", properties: { country: { type: "string" }, count: { type: "integer" } }, required: ["country", "count"] },
            },
            wafRuleId: { type: ["integer", "null"] },
          },
          required: ["host", "proxyHostId", "path", "outcome", "count", "shareOfHost", "countries", "wafRuleId"],
        },
      },
    },
    required: ["status", "generatedAt", "errorBursts", "mitigationSpikes", "blockedConcentrations"],
  },
  AnalyticsView: {
    type: "object",
    properties: {
      id: { type: "integer" },
      name: { type: "string" },
      shared: { type: "boolean" },
      range: viewRange,
      filters: { type: "array", items: ref("AnalyticsFilter") },
      metric: { type: "string", enum: [...METRICS] },
      groupBy: { type: ["string", "null"], enum: [...GROUPINGS, null] },
      owned: { type: "boolean", description: "The caller saved it (and may change it)" },
      ownerName: { type: ["string", "null"] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: ["id", "name", "shared", "range", "filters", "metric", "groupBy", "owned", "ownerName", "createdAt", "updatedAt"],
  },
  AnalyticsViewInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100 },
      shared: { type: "boolean", default: false, description: "List it for everyone who can read analytics" },
      range: { ...viewRange, default: "24h" },
      filters: { type: "array", maxItems: MAX_FILTERS, items: ref("AnalyticsFilter") },
      metric: { type: "string", enum: [...METRICS], default: "requests" },
      groupBy: { type: ["string", "null"], enum: [...GROUPINGS, null] },
    },
    required: ["name"],
  },
  AnalyticsViewUpdate: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100 },
      shared: { type: "boolean" },
      range: viewRange,
      filters: { type: "array", maxItems: MAX_FILTERS, items: ref("AnalyticsFilter") },
      metric: { type: "string", enum: [...METRICS] },
      groupBy: { type: ["string", "null"], enum: [...GROUPINGS, null] },
    },
  },
};
