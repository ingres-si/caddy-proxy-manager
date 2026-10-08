/**
 * What the overview page shows, as plain data: the types the loader
 * (src/lib/overview.ts) returns and the client components read, and the
 * range control's values. No server imports, so client components can use it.
 */
import type { AttentionView } from "./attention/types";
import type { AnalyticsStatus } from "./analytics/run";
import type { SetupChecklistView } from "./setup-checklist";

export const OVERVIEW_RANGES = ["1h", "24h", "7d"] as const;
export type OverviewRange = (typeof OVERVIEW_RANGES)[number];
export const DEFAULT_OVERVIEW_RANGE: OverviewRange = "24h";

/** "last 24 hours", as the traffic chart's title and the KPI notes say it. */
export const OVERVIEW_RANGE_LABELS: Record<OverviewRange, string> = {
  "1h": "last hour",
  "24h": "last 24 hours",
  "7d": "last 7 days",
};

/** The range of the `range` query parameter; the default for anything else. */
export function parseOverviewRange(value: unknown): OverviewRange {
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === "string" && (OVERVIEW_RANGES as readonly string[]).includes(text) ? (text as OverviewRange) : DEFAULT_OVERVIEW_RANGE;
}

export type OverviewTone = "ok" | "warn" | "bad" | "off" | "info";

/** A host's 5xx rate from which its dot turns amber, and red (with at least ten 5xx). */
export const HOST_WARN_ERROR_RATE = 0.01;
export const HOST_BAD_ERROR_RATE = 0.05;

/** What the viewer may open or do from the overview; each section is also left out when they cannot read it. */
export type OverviewPermissions = {
  /** proxy_hosts:write: the "New proxy host" action. */
  createProxyHost: boolean;
  /** proxy_hosts:read: host names link to their page, "All hosts". */
  readProxyHosts: boolean;
  /** analytics:read. */
  readAnalytics: boolean;
  /** waf:read: the security events page. */
  readSecurity: boolean;
  /** alerts:read: "Alerts" next to Needs attention. */
  readAlerts: boolean;
  /** alerts:write: dismissing an alert from Needs attention, "Add a channel". */
  writeAlerts: boolean;
  /** audit_log:read. */
  readAuditLog: boolean;
  /** users:read / users:write: the setup checklist's "Add a user". */
  readUsers: boolean;
  /** sso:read: the setup checklist's single sign-on step. */
  readSso: boolean;
  /** settings:write: marking setup steps done and hiding the checklist. */
  writeSettings: boolean;
};

export type OverviewTraffic = {
  status: AnalyticsStatus;
  range: { preset: string; start: number; end: number; step: number; buckets: number };
  /** Requests per bucket that were served, and that were mitigated (stacked on top). */
  served: number[];
  mitigated: number[];
  totals: {
    requests: number;
    mitigated: number;
    /** Mitigated over requests, 0 to 1. */
    mitigatedShare: number;
    errors5xx: number;
    /** 5xx responses over requests, 0 to 1. */
    errorRate5xx: number;
    bytes: number;
  };
  /** The same numbers for the period right before; null when the retention window does not cover it. */
  previous: { requests: number; errorRate5xx: number; bytes: number; mitigated: number } | null;
  sparklines: { requests: number[]; mitigated: number[]; errors5xx: number[]; bytes: number[] };
  /** The bucket with the most mitigated requests (Unix seconds). */
  peakMitigated: { index: number; ts: number; value: number } | null;
  /** The host with the most 5xx responses in the range, among those the viewer sees. */
  topErrorHost: { name: string; count: number } | null;
};

export type OverviewHostRow = {
  id: number;
  /** The host's first domain (its name when it has none). */
  label: string;
  name: string;
  enabled: boolean;
  href: string | null;
  requests: number;
  /** Requests relative to the busiest host, 0 to 1 (the bar). */
  share: number;
  errors5xx: number;
  errorRate5xx: number;
  mitigated: number;
  /** Whole days left of the certificate it serves; null when unknown or not readable. */
  certificateDaysLeft: number | null;
  tone: OverviewTone;
  /** Why the dot is not green, for screen readers and the tooltip. */
  toneLabel: string;
  /** A 5xx burst in the last 24 hours (Unix seconds), shown next to the name. */
  burst: { status: number; start: number; ongoing: boolean } | null;
};

export type OverviewHosts = {
  status: AnalyticsStatus;
  /** Every proxy host the viewer sees. */
  total: number;
  rows: OverviewHostRow[];
  /** The certificate column is shown (certificates:read). */
  certificates: boolean;
};

export type OverviewNode = {
  key: string;
  name: string;
  /** "Master", "Replica · in sync", "Pull replica · last check-in". */
  detail: string;
  /** A time the detail refers to ("synced 2 minutes ago"), ISO 8601. */
  at: string | null;
  version: string | null;
  /** Runs another release than this server. */
  versionDiffers: boolean;
  tone: OverviewTone;
};

export type OverviewNodes = {
  mode: "standalone" | "master" | "slave";
  nodes: OverviewNode[];
  /** Enabled replicas not listed. */
  more: number;
  link: { label: string; href: string } | null;
};

export type OverviewChange = {
  id: number;
  /** The user's name or e-mail; null for the system. */
  who: string | null;
  summary: string;
  at: string;
  /** The History page at the version from before the change, when the viewer may roll back to it. */
  rollbackHref: string | null;
};

export type OverviewFirstRun = {
  checklist: SetupChecklistView;
};

export type OverviewData = {
  generatedAt: string;
  range: OverviewRange;
  userName: string;
  version: string;
  permissions: OverviewPermissions;
  /** The setup checklist, while the install is fresh (not complete, not hidden) and the viewer reads settings. */
  firstRun: OverviewFirstRun | null;
  attention: AttentionView;
  /** null: the viewer does not read analytics. */
  traffic: OverviewTraffic | null;
  hosts: OverviewHosts | null;
  /** null: the viewer reads neither the fleet nor the instances. */
  nodes: OverviewNodes | null;
  /** null: the viewer does not read the audit log. */
  changes: OverviewChange[] | null;
};
