// SPDX-License-Identifier: Elastic-2.0
/**
 * Attention provider: scheduled backup destinations whose last backup
 * failed.
 */
import { and, eq } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { backupDestinations } from "@/src/lib/db/schema";
import type { AttentionProvider } from "@/src/lib/attention/types";

export const backupsAttentionProvider: AttentionProvider = {
  id: "backups",
  label: "Backups",
  permissions: ["backups:read"],
  supersededBy: ["backup_failed"],
  async collect() {
    const rows = await appDb
      .select()
      .from(backupDestinations)
      .where(and(eq(backupDestinations.enabled, true), eq(backupDestinations.lastStatus, "failed")))
      .orderBy(backupDestinations.id);
    return rows.map((row) => ({
      id: String(row.id),
      severity: row.consecutiveFailures >= 3 ? ("critical" as const) : ("warning" as const),
      title: `Backups to "${row.name}" are failing`,
      detail: `${row.consecutiveFailures} failure${row.consecutiveFailures === 1 ? "" : "s"} in a row; the last successful backup was ${row.lastSuccessAt ? row.lastSuccessAt.slice(0, 10) : "never"}.`,
      actions: [{ label: "Backups", route: "/backups" }],
      at: row.lastRunAt,
    }));
  },
};
