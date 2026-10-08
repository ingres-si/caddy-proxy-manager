// SPDX-License-Identifier: Elastic-2.0
/**
 * Attention provider: fleet nodes that failed to sync, drifted, stopped
 * checking in or run another release than this master. Only on a master.
 */
import type { AttentionItem, AttentionProvider } from "@/src/lib/attention/types";
import { can } from "@/src/lib/permissions";
import { getInstanceMode } from "@/src/lib/instance-sync";
import { APP_VERSION } from "@/src/lib/app-version";
import { listFleetInstances } from "./environments";

export const fleetAttentionProvider: AttentionProvider = {
  id: "fleet",
  label: "Fleet",
  permissions: ["fleet:read", "instances:read"],
  async collect({ access }) {
    if ((await getInstanceMode()) !== "master") return [];
    const route = can(access, "fleet:read") ? "/fleet" : "/instances";
    const open = [{ label: can(access, "fleet:read") ? "Open fleet" : "Instance sync", route }];
    const items: Omit<AttentionItem, "source">[] = [];
    for (const instance of await listFleetInstances()) {
      if (!instance.enabled) continue;
      if (instance.lastSyncError) {
        items.push({
          id: `sync:${instance.id}`,
          severity: "warning",
          title: `Sync to ${instance.name} failed`,
          detail: `${instance.lastSyncError}. It keeps its previous configuration until a sync succeeds.`,
          actions: open,
          at: instance.lastSyncAt,
        });
      }
      if (instance.drift.status === "drifted") {
        items.push({
          id: `drift:${instance.id}`,
          severity: "warning",
          title: `${instance.name} drifted from the configuration the master pushed`,
          detail: instance.drift.detail ? `${instance.drift.detail}. Re-sync it to put it back.` : "Re-sync it to put it back.",
          actions: open,
          at: instance.drift.since,
        });
      }
      if (instance.pull?.checkIn === "missed") {
        items.push({
          id: `pull:${instance.id}`,
          severity: "warning",
          title: `${instance.name} stopped checking in`,
          detail: `The pull replica last asked for its configuration ${instance.pull.lastSeenAt ? `at ${instance.pull.lastSeenAt.slice(0, 16).replace("T", " ")} UTC` : "never"}.`,
          actions: open,
          at: instance.pull.lastSeenAt,
        });
      }
      const version = instance.drift.reportedVersion;
      if (version && APP_VERSION !== "unknown" && version !== APP_VERSION) {
        items.push({
          id: `version:${instance.id}`,
          severity: "info",
          title: `${instance.name} runs ${version}, this node ${APP_VERSION}`,
          detail: "Update it so every node runs the same release.",
          actions: open,
          at: instance.drift.checkedAt,
        });
      }
    }
    return items;
  },
};
