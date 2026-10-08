// SPDX-License-Identifier: Elastic-2.0
/**
 * The dashboard pages that deal with an alert, from its rule type, subject
 * and facts: the certificates of an expiring certificate, the proxy host and
 * its 5xx requests of an error rate alert, and so on. Each link names the
 * permission a reader needs to open it. Pure, safe for the client.
 */
import { analyticsHref, securityHref } from "@/src/lib/analytics/links";
import type { Permission } from "@/src/lib/permissions";
import type { RuleType } from "./types";

export type IssueLink = { label: string; route: string; permission: Permission };

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function idAfter(subjectKey: string, prefix: string): number | null {
  if (!subjectKey.startsWith(prefix)) return null;
  const id = Number(subjectKey.slice(prefix.length));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** At most three links for an alert; facts may be empty (an alert fired before facts were stored). */
export function issueLinks(ruleType: RuleType, subjectKey: string, facts: Record<string, unknown>): IssueLink[] {
  switch (ruleType) {
    case "cert_expiring":
      return [{ label: "View certificates", route: "/certificates", permission: "certificates:read" }];
    case "upstream_down": {
      const upstream = typeof facts.upstream === "string" ? facts.upstream : subjectKey.replace(/^upstream:/, "");
      return [{ label: "Show hosts", route: `/proxy-hosts?search=${encodeURIComponent(upstream)}`, permission: "proxy_hosts:read" }];
    }
    case "error_rate": {
      const hostId = idAfter(subjectKey, "proxy_host:");
      const domain = strings(facts.domains)[0];
      const links: IssueLink[] = [];
      if (hostId !== null) links.push({ label: "Open host", route: `/proxy-hosts/${hostId}`, permission: "proxy_hosts:read" });
      links.push({
        label: "Show requests",
        route: analyticsHref([...(domain ? [{ dim: "host" as const, value: domain }] : []), { dim: "status", value: "5xx" }], "1h"),
        permission: "analytics:read",
      });
      return links;
    }
    case "waf_spike":
      return [{ label: "Security events", route: securityHref({ kind: "waf", range: "1h" }), permission: "waf:read" }];
    case "instance_sync_failed":
      return [{ label: "Instance sync", route: "/instances", permission: "settings:read" }];
    case "caddy_apply_failed":
      return [{ label: "Change history", route: "/history", permission: "config_history:read" }];
    case "backup_failed":
      return [{ label: "Backups", route: "/backups", permission: "backups:read" }];
    case "approval_pending": {
      const id = idAfter(subjectKey, "change_request:");
      return [{ label: "Open request", route: id ? `/approvals?request=${id}` : "/approvals", permission: "approvals:read" }];
    }
    case "access_review_started":
    case "access_review_overdue": {
      const id = idAfter(subjectKey, "access_review:");
      return [{ label: "Open review", route: id ? `/access-reviews/${id}` : "/access-reviews", permission: "access_reviews:read" }];
    }
    case "fleet_drift":
    case "fleet_rollout_failed":
      return [{ label: "Open fleet", route: "/fleet", permission: "fleet:read" }];
  }
}
