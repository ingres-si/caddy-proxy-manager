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
  /** The reader may hide it from their own list (POST /api/v1/overview/attention/dismissals; filled in by the registry). */
  dismissible: boolean;
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
   * Readers may hide its items from their own list for a while
   * (dismissals.ts). Meant for items that say what happened, not for
   * states that stay until someone fixes them.
   */
  dismissible?: boolean;
  /** The items for this reader; may return items without `source` and `dismissible` (the registry sets them). */
  collect(context: AttentionContext): Promise<Omit<AttentionItem, "source" | "dismissible">[]>;
}

export type AttentionSourceStatus = { id: string; label: string; status: "ok" | "error" | "timeout"; items: number };

export type AttentionView = {
  generatedAt: string;
  items: AttentionItem[];
  /** More items than are listed. */
  truncated: boolean;
  counts: Record<AttentionSeverity, number>;
  /** Items the reader dismissed that would otherwise be listed (not in items or counts). */
  dismissed: number;
  /** The providers the reader may see, and whether each answered. */
  sources: AttentionSourceStatus[];
};
