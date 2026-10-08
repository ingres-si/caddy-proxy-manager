/**
 * "Needs attention" on the overview: short items from several sources
 * (certificates, alerts, approvals, access reviews, the fleet, ...), each
 * with a severity and the pages that deal with it. A source is an
 * AttentionProvider; providers are registered in registry.ts and each one
 * declares the permissions a reader needs to see its items. Safe to import
 * from client components (types only).
 */
import type { Access, Permission } from "@/src/lib/permissions";

export type AttentionSeverity = "critical" | "warning" | "info";

/** A dashboard route to deal with the item, e.g. {label: "View certificate", route: "/certificates"}. */
export type AttentionAction = { label: string; route: string };

export type AttentionItem = {
  /** Stable within the provider, e.g. "managed:auth.example.com". */
  id: string;
  /** The provider's id (filled in by the registry). */
  source: string;
  severity: AttentionSeverity;
  title: string;
  detail: string;
  actions: AttentionAction[];
  /** When it started or happened; newer items of the same severity come first. */
  at: string | null;
  /**
   * An alert firing now (ee/alerting): its rule and subject, so a reader with
   * alerts:write can dismiss it until it resolves (POST /api/v1/alert-silences).
   */
  issue?: { ruleId: number; subjectKey: string };
};

export type AttentionContext = {
  access: Access;
  now: Date;
};

export interface AttentionProvider {
  /** Stable id, e.g. "certificates". */
  id: string;
  label: string;
  /**
   * The reader must hold at least one of these permissions to see the
   * provider's items; empty means every signed-in user (the provider then
   * only returns items about the reader).
   */
  permissions: readonly Permission[];
  /**
   * Alert rule types (ee/alerting) that report the same problems. While the
   * reader may read alerts and an enabled rule of one of these types watches
   * every host, the provider is left out: its problems are listed as alerts.
   */
  supersededBy?: readonly string[];
  /** The items for this reader; may return items without `source` (the registry sets it). */
  collect(context: AttentionContext): Promise<Omit<AttentionItem, "source">[]>;
}

export type AttentionSourceStatus = { id: string; label: string; status: "ok" | "error" | "timeout"; items: number };

export type AttentionView = {
  generatedAt: string;
  items: AttentionItem[];
  /** More items than are listed. */
  truncated: boolean;
  counts: Record<AttentionSeverity, number>;
  /** The providers the reader may see, and whether each answered. */
  sources: AttentionSourceStatus[];
  /** Whether alert issues are sent anywhere (an enabled rule with an enabled channel); null for readers of no alerts. */
  notifying: boolean | null;
};
