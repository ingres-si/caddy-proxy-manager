/**
 * OpenAPI paths and schemas of the governance and operations endpoints that
 * are not part of a single ee module: audit log details and facets, firing
 * alerts, Caddy-managed certificates, configuration history versions,
 * comparisons and rollback previews, the setup checklist and the overview's
 * "needs attention" list. Spread into app/api/v1/openapi.json/route.ts.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });
const idParam = { $ref: "#/components/parameters/IdPath" };
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

export const GOVERNANCE_OPENAPI_TAGS = [
  { name: "Overview", description: "What needs attention, gathered from every area the caller may read" },
  { name: "Setup", description: "The setup checklist of a fresh install" },
];

const fieldChange = {
  type: "object",
  properties: {
    path: { type: "string", example: "upstreams" },
    before: {},
    after: {},
    secret: { type: "boolean", description: "The value is secret: only the fact that it changed is reported" },
    beforeLabel: { type: ["string", "null"], description: "For a reference such as accessListId: the name it pointed to" },
    afterLabel: { type: ["string", "null"] },
  },
};

export const GOVERNANCE_OPENAPI_PATHS = {
  "/api/v1/audit-log/{id}": {
    get: {
      tags: ["Audit Log"],
      summary: "Get an audit event",
      description:
        "One event with its data and, for a configuration change recorded while configuration history was on, the before/after diff from " +
        "the history versions recorded with it: only the event's own entity (a proxy host with its mTLS rules and forward-auth grants), every " +
        "change for imports and restores. Secrets are never returned. Older events, and events whose versions retention deleted, have none. " +
        "Permission audit_log:read.",
      operationId: "getAuditEvent",
      parameters: [idParam],
      responses: { "200": { description: "Event", content: json(ref("AuditEventDetail")) }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/audit-log/facets": {
    get: {
      tags: ["Audit Log"],
      summary: "List the values of the audit log filters",
      description: "The actors (users and system), actions and entity types that occur, at most 200 of each. Permission audit_log:read.",
      operationId: "getAuditLogFacets",
      responses: {
        "200": {
          description: "Facets",
          content: json({
            type: "object",
            properties: {
              actors: {
                type: "array",
                items: { type: "object", properties: { id: { type: ["integer", "null"] }, name: { type: ["string", "null"] }, email: { type: ["string", "null"] }, events: { type: "integer" } } },
              },
              actions: { type: "array", items: { type: "string" } },
              entityTypes: { type: "array", items: { type: "string" } },
            },
          }),
        },
        ...errors("401", "403"),
      },
    },
  },
  "/api/v1/alert-events/firing": {
    get: {
      tags: ["Alerting"],
      summary: "List alerts firing now",
      description:
        "Every subject firing now, with the event that started it, the channels that were told and its dismissal or its rule's mute " +
        "(see /api/v1/alert-silences): those neither dismissed nor muted first, then most severe and newest first. Permission alerts:read.",
      operationId: "listFiringAlerts",
      responses: {
        "200": { description: "Firing alerts", content: json({ type: "object", properties: { alerts: { type: "array", items: ref("FiringAlert") } } }) },
        ...errors("401", "403"),
      },
    },
  },
  "/api/v1/certificates/managed": {
    get: {
      tags: ["Certificates"],
      summary: "List the certificates Caddy manages",
      description:
        "For every domain of an enabled proxy host whose certificate Caddy obtains itself (ACME, or its internal CA), the certificate Caddy " +
        "presents, read with a TLS handshake to Caddy's HTTPS port (CADDY_TLS_ADDRESS, or the host of CADDY_API_URL on port 443): issuer, " +
        "validity, when Caddy renews it (a third of its lifetime before expiry) and a state. Results are cached (30 minutes, 5 for problems); " +
        "?refresh=true checks names older than a minute again. Limited to the hosts within the caller's tag scope. " +
        "Permission certificates:read.",
      operationId: "listManagedCertificates",
      parameters: [{ name: "refresh", in: "query", schema: { type: "boolean" } }],
      responses: {
        "200": {
          description: "Managed certificates",
          content: json({
            type: "object",
            properties: {
              available: { type: "boolean", description: "False when Caddy's HTTPS port could not be reached or nothing was checked yet" },
              reason: { type: ["string", "null"] },
              unchecked: { type: "integer" },
              certificates: { type: "array", items: ref("ManagedCertificate") },
            },
          }),
        },
        ...errors("401", "403"),
      },
    },
  },
  "/api/v1/config-history/versions": {
    get: {
      tags: ["Configuration History"],
      summary: "List configuration versions",
      description:
        "Newest first. Each version has a title taken from the audit events that produced it (the manual note, or a summary of the diff " +
        "when there are none), who made it, the change requests whose approved changes it contains, how big the change was, and whether it " +
        "is the configuration running now. Permission config_history:read.",
      operationId: "listConfigVersions",
      parameters: [
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
        { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
      ],
      responses: { "200": { description: "Versions", content: json(ref("ConfigVersionList")) }, ...errors("400", "401", "403") },
    },
  },
  "/api/v1/config-history/compare": {
    get: {
      tags: ["Configuration History"],
      summary: "Compare two configuration versions",
      description:
        "Every difference going from `from` to `to`, per row (with the proxy host it belongs to) and settings group, field by field. " +
        "from: a version id, previous (the version before `to`, the default) or current; to: a version id or current (the default). " +
        "Timestamps are ignored and secrets are never returned. Permission config_history:read.",
      operationId: "compareConfigVersions",
      parameters: [
        { name: "from", in: "query", schema: { type: "string" } },
        { name: "to", in: "query", schema: { type: "string" } },
      ],
      responses: { "200": { description: "Differences", content: json(ref("ConfigComparison")) }, ...errors("400", "401", "403", "404", "409") },
    },
  },
  "/api/v1/config-history/{id}/rollback-preview": {
    get: {
      tags: ["Configuration History"],
      summary: "Preview rolling back to a version",
      description:
        "What restoring the version would do, without changing anything: the hosts and settings groups that change, the later versions it " +
        "undoes, later versions that changed a host this version itself changed, the approval policies that would refuse it (POST " +
        "/api/v1/config-history/{id}/restore answers 409 then), how many Caddy nodes reload, and whether the caller can roll back now. " +
        "Permission config_history:read.",
      operationId: "previewConfigRollback",
      parameters: [idParam],
      responses: { "200": { description: "Preview", content: json(ref("ConfigRollbackPreview")) }, ...errors("401", "403", "404", "409") },
    },
  },
  "/api/v1/setup-checklist": {
    get: {
      tags: ["Setup"],
      summary: "Get the setup checklist",
      description:
        "Five steps of setting up a fresh install, each done when the data shows it (a valid certificate from Caddy, a proxy host, " +
        "analytics, a second user, a sign-in provider) or when marked done. Permission settings:read.",
      operationId: "getSetupChecklist",
      responses: { "200": { description: "Checklist", content: json(ref("SetupChecklist")) }, ...errors("401", "403") },
    },
    put: {
      tags: ["Setup"],
      summary: "Mark setup steps done or hide the checklist",
      description: "Permission settings:write. Audited. Stored on this node only.",
      operationId: "updateSetupChecklist",
      requestBody: {
        required: true,
        content: json({
          type: "object",
          additionalProperties: false,
          properties: {
            steps: {
              type: "object",
              additionalProperties: false,
              properties: Object.fromEntries(["domain", "first_proxy_host", "analytics", "second_user", "single_sign_on"].map((key) => [key, { type: "boolean" }])),
            },
            dismissed: { type: "boolean" },
          },
        }),
      },
      responses: { "200": { description: "Checklist", content: json(ref("SetupChecklist")) }, ...errors("400", "401", "403") },
    },
  },
  "/api/v1/overview/attention": {
    get: {
      tags: ["Overview"],
      summary: "List what needs attention",
      description:
        "Items from every source the caller may read: certificates expiring, failing renewal or missing (certificates:read), the last Caddy " +
        "apply (settings:read), the setup checklist (settings:read), 5xx bursts, mitigation spikes and blocked-traffic concentrations of the " +
        "last 24 hours (analytics:read), failing LDAP directories (ldap:read) and accounts locked out by the MFA policy (users:read), " +
        "alerts firing (alerts:read), change requests (approvals:read), access " +
        "reviews overdue or due (access_reviews:read) and the caller's own items to review (anyone), fleet nodes that failed to sync, drifted, " +
        "stopped checking in or run another release (fleet:read or instances:read), failing backups (backups:read). Each source has a few " +
        "seconds; one that fails or is slow is reported in sources and the others still answer. Any signed-in user.",
      operationId: "getOverviewAttention",
      responses: { "200": { description: "Items", content: json(ref("AttentionView")) }, ...errors("401") },
    },
  },
  "/api/v1/overview/attention/dismissals": {
    get: {
      tags: ["Overview"],
      summary: "List the caller's dismissed items",
      description: "The items the caller hid from their own list, still in effect, the ones ending soonest first. Any signed-in user.",
      operationId: "listAttentionDismissals",
      responses: {
        "200": {
          description: "Dismissals",
          content: json({ type: "object", properties: { dismissals: { type: "array", items: ref("AttentionDismissal") } } }),
        },
        ...errors("401"),
      },
    },
    post: {
      tags: ["Overview"],
      summary: "Dismiss an item",
      description:
        "Hides an item from the caller's own list for 24 hours, or until it becomes more severe than it is now. Only items listed for the " +
        "caller now, of sources that allow it (traffic: 5xx bursts, mitigation spikes, blocked-traffic concentrations; dismissible on the " +
        "item); other sources answer 400, an item not listed 404. Dismissing it again starts the 24 hours again. Other users still see it. " +
        "Any signed-in user.",
      operationId: "dismissAttentionItem",
      requestBody: {
        required: true,
        content: json({
          type: "object",
          additionalProperties: false,
          required: ["source", "id"],
          properties: { source: { type: "string", example: "traffic" }, id: { type: "string", example: "spike:www.example.com" } },
        }),
      },
      responses: { "200": { description: "Dismissal", content: json(ref("AttentionDismissal")) }, ...errors("400", "401", "404") },
    },
    delete: {
      tags: ["Overview"],
      summary: "List dismissed items again",
      description: "With source and id, that item; with neither, every item the caller dismissed. Any signed-in user.",
      operationId: "restoreAttentionItems",
      parameters: [
        { name: "source", in: "query", required: false, schema: { type: "string" } },
        { name: "id", in: "query", required: false, schema: { type: "string" } },
      ],
      responses: {
        "200": { description: "How many dismissals ended", content: json({ type: "object", properties: { restored: { type: "integer" } } }) },
        ...errors("400", "401"),
      },
    },
  },
};

export const GOVERNANCE_OPENAPI_SCHEMAS = {
  AuditEventDetail: {
    allOf: [
      ref("AuditLogEvent"),
      {
        type: "object",
        properties: {
          data: { description: "The data recorded with the event (parsed JSON when it is JSON)" },
          configDiff: {
            type: ["object", "null"],
            properties: {
              beforeId: { type: "integer" },
              afterId: { type: "integer" },
              available: { type: "boolean" },
              reason: { type: ["string", "null"] },
              filtered: { type: "boolean", description: "Only the event's own entity is shown" },
              truncated: { type: "boolean" },
              groups: { type: "array", items: ref("ConfigCompareGroup") },
            },
          },
        },
      },
    ],
  },
  ManagedCertificate: {
    type: "object",
    properties: {
      domain: { type: "string" },
      servername: { type: "string", description: "The name sent as SNI (tls-check.<domain> for a wildcard)" },
      proxyHosts: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } } },
      changedAt: { type: ["string", "null"] },
      state: { type: "string", enum: ["valid", "renewal_due", "renewal_overdue", "expired", "missing", "mismatch", "error"] },
      validFrom: { type: ["string", "null"] },
      validTo: { type: ["string", "null"] },
      daysLeft: { type: ["integer", "null"] },
      renewsAt: { type: ["string", "null"] },
      issuer: { type: ["string", "null"] },
      fingerprint256: { type: ["string", "null"] },
      error: { type: ["string", "null"] },
      checkedAt: { type: "string" },
    },
  },
  ConfigVersion: {
    allOf: [
      ref("ConfigSnapshot"),
      {
        type: "object",
        properties: {
          title: { type: "string" },
          titleSource: { type: "string", enum: ["audit", "note", "summary"] },
          actors: { type: "array", items: { type: "object", properties: { userId: { type: "integer" }, name: { type: ["string", "null"] } } } },
          auditEventIds: { type: "array", items: { type: "integer" } },
          changeRequestIds: { type: "array", items: { type: "integer" } },
          previousId: { type: ["integer", "null"] },
          size: { type: "string", example: "1 host · 2 fields" },
          totals: {
            type: ["object", "null"],
            properties: {
              items: { type: "integer" },
              fields: { type: "integer" },
              hosts: { type: "integer" },
              hostsAdded: { type: "integer" },
              hostsRemoved: { type: "integer" },
              settings: { type: "integer" },
              other: { type: "integer" },
            },
          },
          touched: {
            type: "object",
            properties: {
              hosts: { type: "array", items: { type: "object", properties: { type: { type: "string" }, id: { type: "integer" }, label: { type: "string" } } } },
              settings: { type: "array", items: { type: "string" } },
            },
          },
          live: { type: "boolean" },
        },
      },
    ],
  },
  ConfigVersionList: {
    type: "object",
    properties: {
      versions: { type: "array", items: ref("ConfigVersion") },
      total: { type: "integer" },
      limit: { type: "integer" },
      offset: { type: "integer" },
      liveId: { type: ["integer", "null"], description: "Null when the running configuration has changes no version holds" },
      recording: { type: "object", properties: { enabled: { type: "boolean" }, retention: { type: "integer" } } },
    },
  },
  ConfigCompareGroup: {
    type: "object",
    properties: {
      entity: { type: "string", example: "proxyHosts" },
      entityLabel: { type: "string" },
      id: { type: ["integer", "string"] },
      label: { type: "string" },
      kind: { type: "string", enum: ["added", "removed", "changed"] },
      host: { type: ["object", "null"], properties: { type: { type: "string" }, id: { type: "integer" }, label: { type: "string" } } },
      fields: { type: "array", items: fieldChange },
    },
  },
  ConfigComparison: {
    type: "object",
    properties: {
      from: { type: "object", properties: { kind: { type: "string", enum: ["current", "snapshot", "empty"] }, id: { type: "integer" } } },
      to: { type: "object", properties: { kind: { type: "string", enum: ["current", "snapshot", "empty"] }, id: { type: "integer" } } },
      totals: { type: "object", properties: { added: { type: "integer" }, removed: { type: "integer" }, changed: { type: "integer" }, fields: { type: "integer" } } },
      groups: { type: "array", items: ref("ConfigCompareGroup") },
    },
  },
  ConfigRollbackPreview: {
    type: "object",
    properties: {
      target: ref("ConfigVersion"),
      liveId: { type: ["integer", "null"] },
      identical: { type: "boolean" },
      hosts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["proxy_host", "l4_proxy_host"] },
            id: { type: "integer" },
            name: { type: "string" },
            kind: { type: "string", enum: ["added", "removed", "changed"], description: "added: it comes back; removed: it did not exist yet" },
            fields: { type: "array", items: { type: "string" } },
          },
        },
      },
      settings: { type: "array", items: { type: "object", properties: { key: { type: "string" }, label: { type: "string" }, kind: { type: "string" }, fields: { type: "array", items: { type: "string" } } } } },
      other: { type: "array", items: { type: "object", properties: { entity: { type: "string" }, entityLabel: { type: "string" }, id: {}, label: { type: "string" }, kind: { type: "string" } } } },
      undoes: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, title: { type: "string" }, createdAt: { type: "string" }, reason: { type: "string" } } } },
      undoesUnrecordedChanges: { type: "boolean" },
      sameHostWarnings: {
        type: "array",
        items: { type: "object", properties: { versionId: { type: "integer" }, title: { type: "string" }, createdAt: { type: "string" }, hosts: { type: "array", items: { type: "string" } } } },
      },
      blocked: {
        type: ["object", "null"],
        properties: {
          message: { type: "string" },
          hosts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string" },
                id: { type: "integer" },
                name: { type: "string" },
                operations: { type: "array", items: { type: "string" } },
                policies: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } } },
              },
            },
          },
        },
      },
      reload: { type: "object", properties: { nodes: { type: "integer" }, instances: { type: "array", items: { type: "string" } }, heldBack: { type: "array", items: { type: "string" } } } },
      canRestore: { type: "boolean" },
      reasons: { type: "array", items: { type: "string" } },
    },
  },
  SetupChecklist: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string", enum: ["domain", "first_proxy_host", "analytics", "second_user", "single_sign_on"] },
            title: { type: "string" },
            description: { type: "string" },
            done: { type: "boolean" },
            doneBy: { type: ["string", "null"], enum: ["data", "manual", null] },
            markedAt: { type: ["string", "null"] },
            action: { type: ["object", "null"], properties: { label: { type: "string" }, route: { type: "string" } } },
          },
        },
      },
      done: { type: "integer" },
      total: { type: "integer" },
      complete: { type: "boolean" },
      dismissed: { type: "boolean" },
      dismissedAt: { type: ["string", "null"] },
    },
  },
  AttentionView: {
    type: "object",
    properties: {
      generatedAt: { type: "string", format: "date-time" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            source: { type: "string", example: "certificates" },
            severity: { type: "string", enum: ["critical", "warning", "info"] },
            title: { type: "string" },
            detail: { type: "string" },
            actions: { type: "array", items: { type: "object", properties: { label: { type: "string" }, route: { type: "string" } } } },
            at: { type: ["string", "null"] },
            dismissible: { type: "boolean", description: "The caller may hide it (POST /api/v1/overview/attention/dismissals)" },
          },
        },
      },
      truncated: { type: "boolean" },
      counts: { type: "object", properties: { critical: { type: "integer" }, warning: { type: "integer" }, info: { type: "integer" } } },
      dismissed: { type: "integer", description: "Items the caller dismissed that would otherwise be listed (not in items or counts)" },
      sources: {
        type: "array",
        items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, status: { type: "string", enum: ["ok", "error", "timeout"] }, items: { type: "integer" } } },
      },
    },
  },
  AttentionDismissal: {
    type: "object",
    properties: {
      source: { type: "string", example: "traffic" },
      id: { type: "string" },
      severity: { type: "string", enum: ["critical", "warning", "info"], description: "The item's severity when it was dismissed" },
      until: { type: "string", format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
};
