// SPDX-License-Identifier: Elastic-2.0
/**
 * Attention provider: the alerts firing now, except dismissed ones and those
 * of muted rules. With the built-in rules (builtins.ts) these are the issues
 * of the install: expiring certificates, a failed Caddy apply, server errors,
 * failing upstreams and backups. Each item links to the pages that deal with
 * it that the reader may open, and names its rule and subject so a reader
 * with alerts:write can dismiss it until it resolves.
 */
import { can, type Permission } from "@/src/lib/permissions";
import type { AttentionProvider } from "@/src/lib/attention/types";
import { listFiringAlerts } from "./events";

export const alertsAttentionProvider: AttentionProvider = {
  id: "alerts",
  label: "Alerts",
  permissions: ["alerts:read"],
  async collect({ access }) {
    const alerts = (await listFiringAlerts()).filter((alert) => !alert.dismissal && !alert.mute);
    return alerts.map((alert) => ({
      id: `${alert.ruleId}:${alert.subjectKey}`,
      severity: alert.severity,
      title: alert.title,
      detail: `${alert.message.slice(0, 300)}${alert.message.length > 300 ? "…" : ""}`,
      actions: alert.links
        .filter((link) => can(access, link.permission as Permission))
        .map(({ label, route }) => ({ label, route })),
      at: alert.firedAt,
      issue: { ruleId: alert.ruleId, subjectKey: alert.subjectKey },
    }));
  },
};
