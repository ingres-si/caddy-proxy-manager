/**
 * Where the proxy host pages link to: a host's page and the sections of its
 * editor (tabs of that page), the host's audit log and configuration history,
 * and its traffic on the analytics page.
 */
import type { HostEditorSection } from "@/src/lib/proxy-host-config-summary";

/** The host editor for a new host. */
export const NEW_HOST_HREF = "/proxy-hosts/new";

export function hostHref(id: number): string {
  return `/proxy-hosts/${id}`;
}

/** A host's page, opened at a section of its editor (Routing unless given). */
export function hostEditorHref(id: number, section?: HostEditorSection): string {
  return `/proxy-hosts/${id}#${section ?? "routing"}`;
}

/** The host editor's anchor that opens Routing with health checks turned on as an unsaved change. */
export const HEALTH_CHECKS_TARGET = "health-checks";

/** A host's page with health checks turned on as an unsaved change in Routing, to review and save. */
export function hostHealthChecksHref(id: number): string {
  return `/proxy-hosts/${id}#${HEALTH_CHECKS_TARGET}`;
}

/** The audit log filtered to the host (the filters of GET /api/v1/audit-log). */
export function hostAuditHref(id: number): string {
  return `/audit-log?entityType=proxy_host&entityId=${id}`;
}

/** A configuration history version, to look at or roll back to. */
export function historyVersionHref(versionId: number): string {
  return `/history?version=${versionId}`;
}

/**
 * The analytics page filtered to the host's domains (the filters of the
 * analytics API), for the last 24 hours or for `from`–`to` (Unix seconds).
 */
export function hostAnalyticsHref(domains: readonly string[], window?: { from: number; to: number }): string {
  // The host filter matches stored names exactly, so wildcard domains are left out.
  const filters = domains
    .filter((domain) => !domain.includes("*"))
    .slice(0, 10)
    .map((domain) => ({ dim: "host", op: "is", value: domain }));
  const params = new URLSearchParams();
  if (filters.length > 0) params.set("filters", JSON.stringify(filters));
  if (window) {
    params.set("from", String(window.from));
    params.set("to", String(window.to));
  } else {
    params.set("range", "24h");
  }
  return `/analytics?${params.toString()}`;
}

/** "https://app.example.com", or null for a wildcard domain nobody can open. */
export function siteUrl(domain: string | undefined, https: boolean): string | null {
  if (!domain || domain.includes("*")) return null;
  return `${https ? "https" : "http"}://${domain}`;
}
