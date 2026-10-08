/**
 * What the Security events page hands its client components: plain data,
 * computed on the server after the waf:read check (page.tsx).
 */
import type { AnalyticsStatus } from "@/src/lib/analytics/run";
import type { SecurityEvent, SecurityHost, SecurityPeak, SecurityRule, SecuritySource } from "@/src/lib/analytics/security";
import type { WafTuningSuggestionView } from "@/ee/ai/types";
import type { WafExclusionHostOption } from "../waf/WafExclusionDialog";
import type { SecurityQuery, SecuritySourceKey } from "./security-view";

export type SecurityRange = {
  /** 1h, 24h, 7d, 30d or custom. */
  preset: string;
  start: number;
  end: number;
  step: number;
  buckets: number;
  /** "last 7 days", or the custom range in UTC. */
  label: string;
  /** "the week before". */
  previousLabel: string;
};

export type RuleSetStatus = {
  /** A host using the WAF loads the OWASP Core Rule Set (or, when none uses it, the global settings do). */
  crsLoaded: boolean;
  crsVersion: string;
  paranoiaLevel: number;
  inboundThreshold: number;
  /** Enabled proxy hosts whose WAF blocks, and those in detection only. */
  blocking: number;
  detecting: number;
  /** Enabled proxy hosts. */
  hosts: number;
  exclusions: number;
};

export type SecurityRuleView = SecurityRule & {
  category: string | null;
  /** The proxy host the rule matched on, when it matched on one only (the exclusion dialog's scope). */
  exclusionHostId: number | null;
};

export type SecurityPageData = {
  /** Unix seconds when the page was built. */
  now: number;
  query: SecurityQuery;
  range: SecurityRange;
  /** Why the range in the URL was not used (the last 7 days are shown instead). */
  rangeError: string | null;
  status: AnalyticsStatus;
  ruleSet: RuleSetStatus;
  summary: {
    mitigated: number;
    requests: number;
    share: number;
    previousMitigated: number | null;
    bySource: Record<SecuritySourceKey, number>;
  };
  series: { key: SecuritySourceKey; values: number[] }[];
  peak: SecurityPeak | null;
  rules: { matched: number; events: number; list: SecurityRuleView[] };
  sources: { total: number; list: SecuritySource[] };
  hosts: { total: number; list: SecurityHost[] };
  events: {
    list: SecurityEvent[];
    page: number;
    perPage: number;
    hasMore: boolean;
    /** Why the source or filters in the URL were not used. */
    filterError: string | null;
  };
  /** Addresses on this page that the Blocked sources list already blocks. */
  blockedIps: string[];
  /** Shown addresses that belong to a CDN (Cloudflare): the edge server, not the client, unless the CDN is a trusted proxy. */
  cdnIps: Record<string, string>;
  /** Proxy hosts an exclusion can be limited to. */
  exclusionHosts: WafExclusionHostOption[];
  /** The proxy host serving each WAF event's host name on this page, when one does. */
  eventHostIds: Record<string, number>;
  /** Some host has a rate limit rule, or something was rate limited. */
  rateLimitInUse: boolean;
  permissions: {
    canWriteWaf: boolean;
    /** Null when the user may block addresses; otherwise why not. */
    blockDisabledReason: string | null;
    canReadAnalytics: boolean;
    canReadSettings: boolean;
  };
  tuning: {
    suggestions: WafTuningSuggestionView[];
    analyticsEnabled: boolean;
    aiConfigured: boolean;
  };
};
