/**
 * OpenAPI paths and schemas of the /api/v1/waf endpoints (rule exclusions,
 * per-host modes, events and their explanations), spread into
 * app/api/v1/openapi.json/route.ts. The global WAF settings, tuning included,
 * stay in /api/v1/settings/waf (schema WafSettings there).
 */
import { WAF_EXCLUSION_COLLECTIONS, MAX_EXCLUSION_PATH_LENGTH, MAX_EXCLUSION_REASON_LENGTH, MAX_WAF_RULE_ID } from "./waf-exclusions";
import { WAF_HOST_MODES } from "./waf-host-mode";
import {
  ANOMALY_ACTIONS,
  DEFAULT_INBOUND_ANOMALY_THRESHOLD,
  DEFAULT_OUTBOUND_ANOMALY_THRESHOLD,
  MAX_ANOMALY_THRESHOLD,
  MIN_ANOMALY_THRESHOLD,
} from "./waf-tuning";

const TAG = "WAF";

export const WAF_OPENAPI_TAG = {
  name: TAG,
  description:
    "Web application firewall (Coraza with the OWASP Core Rule Set): rule exclusions, the WAF mode of each proxy host, " +
    "WAF events and why a request was blocked. The global settings, paranoia level and anomaly thresholds included, are " +
    "GET/PUT /api/v1/settings/waf. Reading needs waf:read, changing waf:write. Changes are applied to Caddy right away.",
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });
const responses: Record<string, unknown> = {
  "400": { $ref: "#/components/responses/BadRequest" },
  "401": { $ref: "#/components/responses/Unauthorized" },
  "403": { $ref: "#/components/responses/Forbidden" },
  "404": { $ref: "#/components/responses/NotFound" },
  "409": { $ref: "#/components/responses/Conflict" },
  "422": { description: "The event's stored audit record cannot be read", content: json(ref("Error")) },
  "502": { description: "Caddy did not accept the new configuration", content: json(ref("Error")) },
};
const errors = (...codes: string[]) => Object.fromEntries(codes.map((code) => [code, responses[code]]));
const idParam = (description: string) => ({ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 }, description });
const eventIdParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
  description: "The event id: Coraza's transaction id, as GET /api/v1/waf/events lists it",
};
const variableDescription =
  `A variable, optionally with a name after a colon: ${Object.entries(WAF_EXCLUSION_COLLECTIONS)
    .map(([name, spec]) => (spec.keyed ? `${name}[:name]` : name))
    .join(", ")}. Names are letters, digits and _ . - [ ]; no regular expressions.`;

export const WAF_OPENAPI_PATHS = {
  "/api/v1/waf/exclusions": {
    get: {
      tags: [TAG],
      summary: "List rule exclusions",
      description:
        "Permission waf:read. Oldest first. Whole-scope exclusions (no path, no variable) are also listed in excluded_rule_ids of " +
        "GET /api/v1/settings/waf (global) and of each proxy host's waf (host).",
      operationId: "listWafExclusions",
      parameters: [
        { name: "scope", in: "query", required: false, schema: { type: "string", enum: ["global", "host"] } },
        { name: "proxyHostId", in: "query", required: false, schema: { type: "integer", minimum: 1 }, description: "Only this host's exclusions" },
        { name: "ruleId", in: "query", required: false, schema: { type: "integer", minimum: 1 } },
      ],
      responses: {
        "200": {
          description: "Exclusions",
          content: json({ type: "object", properties: { exclusions: { type: "array", items: ref("WafExclusion") } }, required: ["exclusions"] }),
        },
        ...errors("400", "401", "403"),
      },
    },
    post: {
      tags: [TAG],
      summary: "Add a rule exclusion",
      description:
        "Permission waf:write. The rule is skipped for the global settings (no proxyHostId: every host that follows or merges with " +
        "them) or for one proxy host, on every request or only for a path (exact or prefix, matched on the decoded, normalized path) " +
        "and/or only on one variable. Without a path or variable it is written as SecRuleRemoveById; otherwise as a rule that runs " +
        "before the Core Rule Set with ctl:ruleRemoveById or ctl:ruleRemoveTargetById. The rules that decide blocking (949110, " +
        "949111, 959100, 959101) cannot be excluded. An exact duplicate answers 409; a host protected by a change approval policy " +
        "answers 409. Applied right away; if Caddy refuses the configuration the exclusion is not kept (502).",
      operationId: "createWafExclusion",
      requestBody: { required: true, content: json(ref("WafExclusionInput")) },
      responses: { "201": { description: "Created", content: json(ref("WafExclusion")) }, ...errors("400", "401", "403", "404", "409", "502") },
    },
  },
  "/api/v1/waf/exclusions/batch": {
    post: {
      tags: [TAG],
      summary: "Add several rule exclusions",
      description:
        "Permission waf:write. Adds 1 to 50 exclusions, each as POST /api/v1/waf/exclusions takes it, with one apply: all of them " +
        "or none. Meant for the suggestions of a WAF event (GET /api/v1/waf/events/{id}/suggested-exclusion). One that exists " +
        "already answers 409, the same one twice 400; if Caddy refuses the configuration none is kept (502).",
      operationId: "createWafExclusions",
      requestBody: {
        required: true,
        content: json({
          type: "object",
          properties: { exclusions: { type: "array", minItems: 1, maxItems: 50, items: ref("WafExclusionInput") } },
          required: ["exclusions"],
          additionalProperties: false,
        }),
      },
      responses: {
        "201": {
          description: "Created",
          content: json({ type: "object", properties: { exclusions: { type: "array", items: ref("WafExclusion") } }, required: ["exclusions"] }),
        },
        ...errors("400", "401", "403", "404", "409", "502"),
      },
    },
  },
  "/api/v1/waf/exclusions/{id}": {
    get: {
      tags: [TAG],
      summary: "Get a rule exclusion",
      description: "Permission waf:read.",
      operationId: "getWafExclusion",
      parameters: [idParam("Exclusion id")],
      responses: { "200": { description: "Exclusion", content: json(ref("WafExclusion")) }, ...errors("400", "401", "403", "404") },
    },
    patch: {
      tags: [TAG],
      summary: "Change a rule exclusion",
      description:
        "Permission waf:write. Changes the reason, path, pathMatch or variable (null removes the path or variable). The rule and " +
        "the scope cannot change: delete the exclusion and add another. Applied right away; undone if Caddy refuses it (502).",
      operationId: "updateWafExclusion",
      parameters: [idParam("Exclusion id")],
      requestBody: { required: true, content: json(ref("WafExclusionUpdate")) },
      responses: { "200": { description: "Changed", content: json(ref("WafExclusion")) }, ...errors("400", "401", "403", "404", "409", "502") },
    },
    delete: {
      tags: [TAG],
      summary: "Remove a rule exclusion",
      description: "Permission waf:write. The rule checks the requests in scope again. Applied right away.",
      operationId: "deleteWafExclusion",
      parameters: [idParam("Exclusion id")],
      responses: {
        "200": { description: "Removed", content: json({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }) },
        ...errors("400", "401", "403", "404", "502"),
      },
    },
  },
  "/api/v1/waf/hosts": {
    get: {
      tags: [TAG],
      summary: "List the WAF mode of every proxy host",
      description: "Permission waf:read. Each host's mode setting, what it gets once the global settings apply, and how it differs from them.",
      operationId: "listWafHosts",
      responses: {
        "200": {
          description: "Hosts",
          content: json({ type: "object", properties: { hosts: { type: "array", items: ref("WafHost") } }, required: ["hosts"] }),
        },
        ...errors("401", "403"),
      },
    },
  },
  "/api/v1/waf/hosts/{id}": {
    get: {
      tags: [TAG],
      summary: "Get a proxy host's WAF mode",
      description: "Permission waf:read.",
      operationId: "getWafHost",
      parameters: [idParam("Proxy host id")],
      responses: { "200": { description: "Host", content: json(ref("WafHost")) }, ...errors("400", "401", "403", "404") },
    },
    put: {
      tags: [TAG],
      summary: "Set a proxy host's WAF mode",
      description:
        "Permission waf:write. inherit: the host uses the WAF with the global mode (also when the global WAF does not apply to every " +
        "host); off: no WAF for this host; detection_only: matches are logged, nothing is blocked; block: requests over the anomaly " +
        "threshold get 403. The rest of the host's WAF settings stay. Stored in the host's waf.mode (On, DetectionOnly, Off, or unset " +
        "to inherit) and waf.enabled, so PUT /api/v1/proxy-hosts/{id} with waf can set the same. Recorded in the audit log as a " +
        "proxy host change; a host protected by a change approval policy answers 409.",
      operationId: "setWafHostMode",
      parameters: [idParam("Proxy host id")],
      requestBody: {
        required: true,
        content: json({
          type: "object",
          additionalProperties: false,
          properties: { mode: { type: "string", enum: [...WAF_HOST_MODES] } },
          required: ["mode"],
        }),
      },
      responses: { "200": { description: "Host", content: json(ref("WafHost")) }, ...errors("400", "401", "403", "404", "409", "502") },
    },
  },
  "/api/v1/waf/events": {
    get: {
      tags: [TAG],
      summary: "List WAF events",
      description:
        "Permission waf:read. Newest first, from ClickHouse (empty when analytics are off). `id` is Coraza's transaction id, for the " +
        "explain and suggested-exclusion endpoints. Credential headers and parameters were redacted when the event was stored.",
      operationId: "listWafEvents",
      parameters: [
        { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 1 } },
        { name: "perPage", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
        { name: "search", in: "query", required: false, schema: { type: "string", maxLength: 200 }, description: "Host, client address, URI or rule message" },
        { name: "from", in: "query", required: false, schema: { type: "integer" }, description: "Unix time in seconds; needs to" },
        { name: "to", in: "query", required: false, schema: { type: "integer" }, description: "Unix time in seconds; needs from" },
      ],
      responses: {
        "200": {
          description: "Events",
          content: json({
            type: "object",
            properties: {
              events: { type: "array", items: ref("WafEventSummary") },
              total: { type: "integer" },
              page: { type: "integer" },
              perPage: { type: "integer" },
            },
            required: ["events", "total", "page", "perPage"],
          }),
        },
        ...errors("400", "401", "403"),
      },
    },
  },
  "/api/v1/waf/events/{id}/explain": {
    get: {
      tags: [TAG],
      summary: "Explain why a request was blocked",
      description:
        "Permission waf:read. Reads the event's stored Coraza audit record: every matched rule with its message, severity, anomaly " +
        "points, matched variable and data, the total inbound score against the threshold, and the rule that decided (949110 for " +
        "the anomaly score, or a custom rule with its own deny). Rules above the blocking paranoia level log without adding points. " +
        "The threshold is the one in the record when the record reports it, else the current settings for the host. Includes the " +
        "suggested exclusions (see suggested-exclusion).",
      operationId: "explainWafEvent",
      parameters: [eventIdParam],
      responses: { "200": { description: "Explanation", content: json(ref("WafEventExplanation")) }, ...errors("401", "403", "404", "422") },
    },
  },
  "/api/v1/waf/events/{id}/suggested-exclusion": {
    get: {
      tags: [TAG],
      summary: "Suggest exclusions for a WAF event",
      description:
        "Permission waf:read. For each Core Rule Set rule that added to the event's score: the rule, on the proxy host that served " +
        "the request (global when none does), for the request's path (exact), on the matched variable when the record names one. " +
        "existingExclusionId is set when that exclusion already exists. Nothing is changed: POST a suggestion's ruleId, " +
        "proxyHostId, path, pathMatch, variable and reason to /api/v1/waf/exclusions to create it.",
      operationId: "suggestWafExclusion",
      parameters: [eventIdParam],
      responses: {
        "200": {
          description: "Suggestions",
          content: json({
            type: "object",
            properties: { eventId: { type: "string" }, suggestions: { type: "array", items: ref("WafExclusionSuggestion") } },
            required: ["eventId", "suggestions"],
          }),
        },
        ...errors("401", "403", "404", "422"),
      },
    },
  },
};

const nullableString = { type: ["string", "null"] };
const nullableInteger = { type: ["integer", "null"] };

const exclusionFields = {
  path: {
    type: ["string", "null"],
    maxLength: MAX_EXCLUSION_PATH_LENGTH,
    description:
      "Only requests to this path: decoded, starting with /, letters, digits and - . _ ~ ! $ & ( ) * + , ; = : @ / only, no " +
      "\"//\", \"/./\" or \"/../\"",
  },
  pathMatch: { type: ["string", "null"], enum: ["exact", "prefix", null], description: "Default: prefix when the path ends with /, else exact" },
  variable: { type: ["string", "null"], description: variableDescription, examples: ["ARGS:content", "REQUEST_HEADERS:Content-Type"] },
  reason: { type: "string", maxLength: MAX_EXCLUSION_REASON_LENGTH, description: "Why the rule is excluded (one line)" },
};

export const WAF_OPENAPI_SCHEMAS = {
  WafExclusion: {
    type: "object",
    properties: {
      id: { type: "integer" },
      ruleId: { type: "integer" },
      scope: { type: "string", enum: ["global", "host"] },
      proxyHostId: nullableInteger,
      host: {
        oneOf: [
          { type: "null" },
          {
            type: "object",
            properties: { id: { type: "integer" }, name: { type: "string" }, domains: { type: "array", items: { type: "string" } } },
            required: ["id", "name", "domains"],
          },
        ],
      },
      pathMatch: { type: ["string", "null"], enum: ["exact", "prefix", null] },
      path: nullableString,
      variable: nullableString,
      reason: { type: "string" },
      createdBy: {
        oneOf: [{ type: "null" }, { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } }, required: ["id", "name"] }],
        description: "Null when unknown: migrated from an excluded rule list, synced from a master, or the user was deleted",
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: ["id", "ruleId", "scope", "proxyHostId", "host", "pathMatch", "path", "variable", "reason", "createdBy", "createdAt", "updatedAt"],
  },
  WafExclusionInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      ruleId: { type: "integer", minimum: 1, maximum: MAX_WAF_RULE_ID },
      proxyHostId: { type: ["integer", "null"], minimum: 1, description: "Null or absent: the global settings" },
      ...exclusionFields,
    },
    required: ["ruleId"],
  },
  WafExclusionUpdate: {
    type: "object",
    additionalProperties: false,
    properties: exclusionFields,
  },
  WafHost: {
    type: "object",
    properties: {
      id: { type: "integer" },
      name: { type: "string" },
      domains: { type: "array", items: { type: "string" } },
      hostEnabled: { type: "boolean" },
      mode: { type: "string", enum: [...WAF_HOST_MODES], description: "The host's setting" },
      configured: { type: "boolean", description: "False: the host has no WAF settings of its own and uses the WAF only when it applies to all hosts" },
      rules: { type: "string", enum: ["merge", "override"] },
      effectiveMode: { type: "string", enum: ["off", "detection_only", "block"], description: "What the host gets" },
      loadOwaspCrs: { type: "boolean" },
      settings: { type: "string", enum: ["follows", "merges", "overrides", "off"] },
      differences: { type: "array", items: { type: "string" } },
      exclusions: { type: "integer", description: "The host's own rule exclusions" },
    },
    required: ["id", "name", "domains", "hostEnabled", "mode", "configured", "rules", "effectiveMode", "loadOwaspCrs", "settings", "differences", "exclusions"],
  },
  WafEventSummary: {
    type: "object",
    properties: {
      id: { type: ["string", "null"], description: "Coraza's transaction id" },
      ts: { type: "integer", description: "Unix time in seconds" },
      host: { type: "string" },
      clientIp: { type: "string" },
      countryCode: nullableString,
      method: { type: "string" },
      uri: { type: "string" },
      ruleId: nullableInteger,
      ruleMessage: nullableString,
      severity: nullableString,
      blocked: { type: "boolean" },
    },
    required: ["id", "ts", "host", "clientIp", "method", "uri", "ruleId", "blocked"],
  },
  WafMatchedRule: {
    type: "object",
    properties: {
      ruleId: { type: "integer" },
      kind: { type: "string", enum: ["attack", "inbound_evaluation", "outbound_evaluation", "reporting", "custom"] },
      message: nullableString,
      severity: nullableString,
      paranoiaLevel: nullableInteger,
      anomalyPoints: { type: ["integer", "null"], description: "Points added to the blocking score (critical 5, error 4, warning 3, notice 2); 0 when logged only; null outside the anomaly scoring" },
      countedInScore: { type: "boolean" },
      matchedVariable: nullableString,
      matchedData: nullableString,
      disruptive: { type: "boolean" },
      phase: nullableInteger,
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["ruleId", "kind", "message", "severity", "paranoiaLevel", "anomalyPoints", "countedInScore", "matchedVariable", "matchedData", "disruptive", "phase", "tags"],
  },
  WafExclusionSuggestion: {
    type: "object",
    properties: {
      ruleId: { type: "integer" },
      proxyHostId: nullableInteger,
      hostName: nullableString,
      pathMatch: { type: ["string", "null"], enum: ["exact", null] },
      path: nullableString,
      variable: nullableString,
      reason: { type: "string" },
      description: { type: "string" },
      existingExclusionId: nullableInteger,
    },
    required: ["ruleId", "proxyHostId", "hostName", "pathMatch", "path", "variable", "reason", "description", "existingExclusionId"],
  },
  WafEventExplanation: {
    type: "object",
    properties: {
      eventId: nullableString,
      blocked: { type: "boolean" },
      event: { type: "object", description: "The event as GET /api/v1/waf/events lists it, with eventId" },
      request: {
        type: "object",
        properties: {
          method: nullableString,
          uri: nullableString,
          host: nullableString,
          clientIp: nullableString,
          httpVersion: nullableString,
          headers: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
        },
      },
      rules: { type: "array", items: ref("WafMatchedRule") },
      inboundScore: { type: "integer" },
      inboundScoreSource: { type: "string", enum: ["record", "computed"] },
      outboundScore: nullableInteger,
      inboundThreshold: { type: "integer" },
      outboundThreshold: { type: "integer" },
      thresholdSource: { type: "string", enum: ["record", "settings"] },
      decidingRule: {
        oneOf: [
          { type: "null" },
          {
            type: "object",
            properties: { ruleId: { type: "integer" }, message: nullableString, kind: { type: "string" }, blocked: { type: "boolean" } },
            required: ["ruleId", "message", "kind", "blocked"],
          },
        ],
      },
      summary: { type: "string" },
      suggestions: { type: "array", items: ref("WafExclusionSuggestion") },
    },
    required: ["eventId", "blocked", "event", "request", "rules", "inboundScore", "inboundThreshold", "outboundThreshold", "thresholdSource", "decidingRule", "summary", "suggestions"],
  },
};

/** The tuning fields of WafSettings (GET/PUT /api/v1/settings/waf). */
export const WAF_TUNING_OPENAPI_PROPERTIES = {
  paranoia_level: {
    type: "integer",
    minimum: 1,
    maximum: 4,
    description: "OWASP CRS paranoia level (tx.blocking_paranoia_level). Default 1. Higher levels catch more and match more normal traffic. Global only: hosts that override the global settings run the CRS defaults.",
  },
  detection_paranoia_level: {
    type: "integer",
    minimum: 1,
    maximum: 4,
    description: "Run rules up to this level but only log those above paranoia_level (tx.detection_paranoia_level). Default: paranoia_level; never lower.",
  },
  inbound_anomaly_threshold: {
    type: "integer",
    minimum: MIN_ANOMALY_THRESHOLD,
    maximum: MAX_ANOMALY_THRESHOLD,
    description: `Request anomaly score that triggers the over-the-threshold action (tx.inbound_anomaly_score_threshold). Default ${DEFAULT_INBOUND_ANOMALY_THRESHOLD}.`,
  },
  outbound_anomaly_threshold: {
    type: "integer",
    minimum: MIN_ANOMALY_THRESHOLD,
    maximum: MAX_ANOMALY_THRESHOLD,
    description: `Response anomaly score that triggers it (tx.outbound_anomaly_score_threshold). Default ${DEFAULT_OUTBOUND_ANOMALY_THRESHOLD}.`,
  },
  anomaly_action: {
    type: "string",
    enum: [...ANOMALY_ACTIONS],
    description: "Over the threshold: block (403, the default) or log (the event is recorded and the request goes through). Custom rules with their own deny still block.",
  },
};
