// SPDX-License-Identifier: Elastic-2.0
/**
 * Alerting: shared types and constants. Safe to import from client components
 * (no server-only dependencies).
 */

export const CHANNEL_TYPES = ["email", "slack", "teams", "webhook", "pagerduty", "ntfy"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const RULE_TYPES = [
  "cert_expiring",
  "upstream_down",
  "waf_spike",
  "error_rate",
  "instance_sync_failed",
  "caddy_apply_failed",
  "backup_failed",
  "approval_pending",
  "access_review_started",
  "access_review_overdue",
  "fleet_drift",
  "fleet_rollout_failed",
] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export const CHANNEL_TYPE_LABELS: Record<ChannelType, string> = {
  email: "E-mail (SMTP)",
  slack: "Slack",
  teams: "Microsoft Teams",
  webhook: "Webhook",
  pagerduty: "PagerDuty",
  ntfy: "ntfy",
};

export const RULE_TYPE_LABELS: Record<RuleType, string> = {
  cert_expiring: "Certificate expiring",
  upstream_down: "Upstream failing",
  waf_spike: "WAF block spike",
  error_rate: "Error rate",
  instance_sync_failed: "Instance sync failed",
  caddy_apply_failed: "Caddy config apply failed",
  backup_failed: "Backup failed",
  approval_pending: "Change awaiting approval",
  access_review_started: "Access review started",
  access_review_overdue: "Access review overdue",
  fleet_drift: "Fleet instance drifted",
  fleet_rollout_failed: "Fleet rollout failed",
};

export const RULE_TYPE_DESCRIPTIONS: Record<RuleType, string> = {
  cert_expiring:
    "Certificates that expire within the given number of days: imported certificates, CA certificates and issued client certificates stored in the dashboard, and the certificates Caddy obtains through ACME for proxy hosts, which also fire when their renewal is overdue or Caddy has no certificate for a domain (read from Caddy with a TLS handshake).",
  upstream_down:
    "An HTTP reverse-proxy upstream with recent failures in Caddy's passive health checks (needs passive health checks with a fail duration on the host).",
  waf_spike: "Requests blocked by the WAF in the time window reach the threshold (needs ClickHouse analytics).",
  error_rate:
    "The share of 5xx responses of a proxy host, or of the chosen hosts together, is above the threshold in the time window, counting only when there were at least the minimum number of requests (needs ClickHouse analytics).",
  instance_sync_failed: "A slave instance whose last configuration sync failed (master mode).",
  caddy_apply_failed: "The last attempt to push the configuration to Caddy failed.",
  backup_failed:
    "Scheduled configuration backups to an enabled destination failed the given number of times in a row (Scheduled backups, on the History page).",
  approval_pending:
    "A change to a protected host is waiting for approval (Change approvals): notifies approvers once per request; resolves when it is decided.",
  access_review_started:
    "An access review campaign is open (started by hand or by a schedule); resolves when it is completed or cancelled.",
  access_review_overdue:
    "An open access review campaign is past its due date with items nobody has confirmed yet.",
  fleet_drift:
    "A slave instance runs another configuration than the one the master last pushed to it, or its synced configuration was changed on the instance (Fleet page, master mode).",
  fleet_rollout_failed:
    "The latest rollout into a fleet environment failed; its instances not reached yet stay on the previous revision (Fleet page, master mode).",
};

export type Severity = "critical" | "warning" | "info";

export type CertExpiringParams = { days: number; includeClientCertificates: boolean; includeManagedCertificates: boolean };
export type UpstreamDownParams = { minFails: number };
export type WafSpikeParams = { threshold: number; windowMinutes: number };
/** thresholdPercent: 0.1 to 100 in steps of 0.1. perHost: one alert per proxy host, or one for all hosts in scope together. */
export type ErrorRateParams = { thresholdPercent: number; windowMinutes: number; minRequests: number; perHost: boolean };
export type BackupFailedParams = { minFailures: number };
export type EmptyParams = Record<string, never>;

export type RuleParams = {
  cert_expiring: CertExpiringParams;
  upstream_down: UpstreamDownParams;
  waf_spike: WafSpikeParams;
  error_rate: ErrorRateParams;
  instance_sync_failed: EmptyParams;
  caddy_apply_failed: EmptyParams;
  backup_failed: BackupFailedParams;
  approval_pending: EmptyParams;
  access_review_started: EmptyParams;
  access_review_overdue: EmptyParams;
  fleet_drift: EmptyParams;
  fleet_rollout_failed: EmptyParams;
};

export const DEFAULT_RULE_PARAMS: { [T in RuleType]: RuleParams[T] } = {
  cert_expiring: { days: 14, includeClientCertificates: true, includeManagedCertificates: true },
  upstream_down: { minFails: 1 },
  waf_spike: { threshold: 100, windowMinutes: 15 },
  error_rate: { thresholdPercent: 5, windowMinutes: 5, minRequests: 20, perHost: true },
  instance_sync_failed: {},
  caddy_apply_failed: {},
  backup_failed: { minFailures: 1 },
  approval_pending: {},
  access_review_started: {},
  access_review_overdue: {},
  fleet_drift: {},
  fleet_rollout_failed: {},
};

/**
 * Which proxy hosts a rule watches. Only rule types in SCOPED_RULE_TYPES
 * accept a host list; the others watch what they always watched ("all").
 */
export type RuleScope = { type: "all" } | { type: "hosts"; proxyHostIds: number[] };

export const SCOPED_RULE_TYPES: readonly RuleType[] = ["cert_expiring", "upstream_down", "waf_spike", "error_rate"];

/**
 * Rule types that accept a "for" duration: the condition must hold for that
 * many minutes before the rule fires. Rules about one-off events (a change
 * waiting for approval, a review that started) fire at once.
 */
export const FOR_DURATION_RULE_TYPES: readonly RuleType[] = [
  "cert_expiring",
  "upstream_down",
  "waf_spike",
  "error_rate",
  "instance_sync_failed",
  "caddy_apply_failed",
  "backup_failed",
  "fleet_drift",
];

export const MAX_FOR_MINUTES = 24 * 60;
export const MAX_SCOPE_HOSTS = 200;

/** Durations offered for dismissing an alert or muting a rule (minutes): 1 hour, 8 hours, 1 day, 1 week. */
export const SILENCE_DURATIONS = [60, 8 * 60, 24 * 60, 7 * 24 * 60] as const;
/** The longest dismissal or mute (minutes). */
export const MAX_SILENCE_MINUTES = 30 * 24 * 60;
export const MAX_SILENCE_NOTE_LENGTH = 500;

/**
 * A mute (every alert of a rule, until a time) or a dismissal (one alert,
 * until a time or until it resolves), in effect now.
 */
export type AlertSilenceView = {
  id: number;
  kind: "mute" | "dismissal";
  ruleId: number;
  ruleName: string;
  /** The dismissed alert; null for a mute. */
  subjectKey: string | null;
  /** What the dismissed alert is about, while it fires; null otherwise. */
  subjectTitle: string | null;
  /** When it ends; null for a dismissal that ends when the alert resolves. */
  until: string | null;
  note: string | null;
  createdBy: number | null;
  /** The name (or e-mail) of who created it; null when unknown or deleted. */
  createdByName: string | null;
  createdAt: string;
};

/** Non-secret channel settings as returned by the API, with `has*` flags in place of secrets. */
export type EmailChannelView = {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  from: string;
  to: string[];
  hasPassword: boolean;
};
export type WebhookUrlChannelView = { hasWebhookUrl: boolean; webhookUrlHint: string | null };
export type WebhookChannelView = { hasUrl: boolean; urlHint: string | null; hasHmacSecret: boolean };
export type PagerDutyChannelView = { region: "us" | "eu"; hasRoutingKey: boolean };
export type NtfyChannelView = { serverUrl: string; topic: string; hasToken: boolean };

export type ChannelConfigView =
  | EmailChannelView
  | WebhookUrlChannelView
  | WebhookChannelView
  | PagerDutyChannelView
  | NtfyChannelView;

export type AlertChannelView = {
  id: number;
  name: string;
  type: ChannelType;
  enabled: boolean;
  config: ChannelConfigView;
  lastDeliveryAt: string | null;
  lastDeliveryError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AlertRuleView = {
  id: number;
  /** Key of a built-in rule (ee/alerting/builtins.ts); null for rules people created. Built-in rules cannot be deleted. */
  builtIn: string | null;
  name: string;
  type: RuleType;
  enabled: boolean;
  params: Record<string, unknown>;
  channelIds: number[];
  cooldownMinutes: number;
  notifyOnResolve: boolean;
  explain: boolean;
  scope: RuleScope;
  /** What the rule watches, in words (e.g. "Each proxy host", "3 proxy hosts", "This node"). */
  scopeLabel: string;
  /** Minutes the condition must hold before the rule fires (0: at once). */
  forMinutes: number;
  /** Subjects currently firing (e.g. one per expiring certificate). */
  firing: { subjectKey: string; title: string | null; firedAt: string | null }[];
  /** Subjects whose condition holds but has not lasted forMinutes yet. */
  pending: { subjectKey: string; title: string | null; since: string | null }[];
  /** When the rule last fired (its newest firing event in the 90-day history); null when it has not. */
  lastFiredAt: string | null;
  /** The rule's mute in effect, if any. */
  mute: AlertSilenceView | null;
  createdAt: string;
  updatedAt: string;
};

export type AlertEventView = {
  id: number;
  ruleId: number;
  ruleName: string;
  ruleType: string;
  subjectKey: string;
  status: "firing" | "resolved";
  severity: Severity;
  title: string;
  message: string;
  explanation: string | null;
  notified: boolean;
  deliveries: { channelId: number; channelName: string; ok: boolean; error: string | null }[];
  createdAt: string;
  /** For a firing event: when that episode resolved (null while it still fires or when unknown). */
  resolvedAt: string | null;
  /** Not notified because the rule was muted or the alert dismissed; null otherwise. */
  silenced: "muted" | "dismissed" | null;
};

/** One subject firing now, with the event that started it. */
export type FiringAlertView = {
  ruleId: number;
  ruleName: string;
  ruleType: RuleType;
  subjectKey: string;
  severity: Severity;
  title: string;
  message: string;
  firedAt: string | null;
  /** Channels told when it fired. */
  deliveries: AlertEventView["deliveries"];
  /** Nothing was sent when it fired because the rule was muted or the alert dismissed. */
  silenced: AlertEventView["silenced"];
  eventId: number | null;
  notifyOnResolve: boolean;
  /** This alert's dismissal in effect, if any. */
  dismissal: AlertSilenceView | null;
  /** Its rule's mute in effect, if any. */
  mute: AlertSilenceView | null;
  /** The pages that deal with it (links.ts), each with the permission needed to open it. */
  links: { label: string; route: string; permission: string }[];
};

export function isChannelType(value: unknown): value is ChannelType {
  return typeof value === "string" && (CHANNEL_TYPES as readonly string[]).includes(value);
}

export function isRuleType(value: unknown): value is RuleType {
  return typeof value === "string" && (RULE_TYPES as readonly string[]).includes(value);
}
