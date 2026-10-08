/**
 * Attention providers of the free core: certificates (imported ones and the
 * ones Caddy manages), the last Caddy apply, and the setup checklist.
 */
import { X509Certificate } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { certificates, proxyHosts } from "@/src/lib/db/schema";
import { scopeTagsFor, tagsInScope } from "@/src/lib/permissions";
import { parseStoredTags } from "@/src/lib/host-tags";
import { getCaddyApplyStatus } from "@/src/lib/caddy-apply-status";
import { filterManagedCertificatesForAccess, getManagedCertificates } from "@/src/lib/managed-certificates";
import { getSetupChecklist } from "@/src/lib/setup-checklist";
import type { AttentionItem, AttentionProvider } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const WARNING_DAYS = 14;
const INFO_DAYS = 30;

type Item = Omit<AttentionItem, "source">;

function day(iso: string): string {
  return iso.slice(0, 10);
}

function daysText(days: number): string {
  return `${days} day${days === 1 ? "" : "s"}`;
}

export const certificatesProvider: AttentionProvider = {
  id: "certificates",
  label: "Certificates",
  permissions: ["certificates:read"],
  supersededBy: ["cert_expiring"],
  async collect({ access, now }) {
    const items: Item[] = [];
    const view = [{ label: "View certificates", route: "/certificates" }];

    // Certificates Caddy manages (cached TLS checks; stale ones are refreshed in the background).
    const managed = await getManagedCertificates({ cachedOnly: true });
    for (const status of await filterManagedCertificatesForAccess(managed.certificates, access)) {
      const hosts = status.proxyHosts.map((host) => host.name).slice(0, 3).join(", ");
      const id = `managed:${status.servername}`;
      if (status.state === "missing" || status.state === "mismatch") {
        if (status.changedAt && now.getTime() - Date.parse(status.changedAt) < 15 * 60 * 1000) continue;
        items.push({
          id,
          severity: "critical",
          title: `No valid certificate for ${status.domain}`,
          detail: `${status.error ?? "Caddy serves no valid certificate for this name"}. Check that the domain points at this server and ports 80 and 443 are reachable${hosts ? ` (used by ${hosts})` : ""}.`,
          actions: view,
          at: status.checkedAt,
        });
      } else if (status.state === "expired" && status.validTo) {
        items.push({ id, severity: "critical", title: `Certificate for ${status.domain} has expired`, detail: `It expired on ${day(status.validTo)} and Caddy could not renew it.`, actions: view, at: status.validTo });
      } else if (status.state === "renewal_overdue" && status.validTo && status.daysLeft !== null) {
        items.push({
          id,
          severity: status.daysLeft < 7 ? "critical" : "warning",
          title: `Renewal of the certificate for ${status.domain} is failing`,
          detail: `Caddy should have renewed it from ${status.renewsAt ? day(status.renewsAt) : "earlier"}; it expires on ${day(status.validTo)} (${daysText(status.daysLeft)}).`,
          actions: view,
          at: status.renewsAt,
        });
      } else if (status.state === "renewal_due" && status.validTo && status.daysLeft !== null && status.daysLeft < INFO_DAYS) {
        items.push({
          id,
          severity: "info",
          title: `Certificate for ${status.domain} is due for renewal`,
          detail: `Expires ${day(status.validTo)} (${daysText(status.daysLeft)}). Caddy renews it automatically; nothing to do unless the renewal fails.`,
          actions: view,
          at: status.renewsAt,
        });
      }
    }

    // Imported certificates, within the reader's tag scope.
    const scope = scopeTagsFor(access, "certificates");
    const rows = await appDb
      .select({ id: certificates.id, name: certificates.name, pem: certificates.certificatePem })
      .from(certificates)
      .where(and(eq(certificates.type, "imported"), isNotNull(certificates.certificatePem)));
    let visible = rows;
    if (scope !== null) {
      const used = new Set(
        (await appDb
          .select({ certificateId: proxyHosts.certificateId, tags: proxyHosts.tags })
          .from(proxyHosts)
          .where(isNotNull(proxyHosts.certificateId)))
          .filter((row) => tagsInScope(parseStoredTags(row.tags), scope))
          .map((row) => row.certificateId)
      );
      visible = rows.filter((row) => used.has(row.id));
    }
    for (const row of visible) {
      let validTo: Date;
      try {
        validTo = new Date(new X509Certificate(row.pem!).validTo);
      } catch {
        continue;
      }
      const days = Math.floor((validTo.getTime() - now.getTime()) / DAY_MS);
      if (days >= INFO_DAYS) continue;
      items.push({
        id: `imported:${row.id}`,
        severity: days < 0 ? "critical" : days < WARNING_DAYS ? "warning" : "info",
        title: days < 0 ? `Certificate "${row.name}" has expired` : `Certificate "${row.name}" expires in ${daysText(days)}`,
        detail: days < 0 ? `It expired on ${day(validTo.toISOString())}. Import a renewed certificate.` : `It expires on ${day(validTo.toISOString())}. Import a renewed certificate before then.`,
        actions: view,
        at: validTo.toISOString(),
      });
    }
    return items;
  },
};

export const caddyApplyProvider: AttentionProvider = {
  id: "caddy",
  label: "Caddy",
  permissions: ["settings:read"],
  supersededBy: ["caddy_apply_failed"],
  async collect() {
    const status = await getCaddyApplyStatus();
    if (!status || status.ok) return [];
    return [
      {
        id: "apply",
        severity: "critical",
        title: "Applying the configuration to Caddy failed",
        detail: `${status.message ?? status.code ?? "Caddy did not accept the configuration"}. Caddy keeps serving its previous configuration, so recent changes are not live.`,
        actions: [{ label: "Settings", route: "/settings" }],
        at: status.at,
      },
    ];
  },
};

export const setupProvider: AttentionProvider = {
  id: "setup",
  label: "Setup",
  permissions: ["settings:read"],
  async collect() {
    const checklist = await getSetupChecklist();
    if (checklist.complete || checklist.dismissed) return [];
    const next = checklist.steps.find((step) => !step.done);
    return [
      {
        id: "checklist",
        severity: "info",
        title: `Finish setting up: ${checklist.done} of ${checklist.total} steps done`,
        detail: next ? `Next: ${next.title.charAt(0).toLowerCase()}${next.title.slice(1)}.` : "Every step is done.",
        actions: [{ label: "Open the checklist", route: "/" }],
        at: null,
      },
    ];
  },
};
