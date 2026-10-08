/**
 * Items of "Needs attention" a reader hid from their own overview
 * (attention_dismissals). Only providers that declare `dismissible` take
 * dismissals: their items say what happened (a burst of 5xx, a mitigation
 * spike), not a state someone still has to fix.
 *
 * - A dismissal belongs to one account and hides one item (provider and item
 *   id) from that account only, for ATTENTION_DISMISS_HOURS.
 * - The item comes back sooner when it becomes more severe than it was when
 *   it was dismissed (a spike from information to warning, a burst that is
 *   going on again).
 * - Dismissing the same item again starts the time again. Rows that ended are
 *   removed when the account dismisses or reads its dismissals.
 *
 * Per dashboard, like users: not synced to slaves, not audited (it changes
 * only what the account itself sees).
 */
import { and, eq, gt, lte } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { asc } from "@/src/lib/db/ops";
import { attentionDismissals } from "@/src/lib/db/schema";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import type { Access } from "@/src/lib/permissions";
import type { AttentionItem, AttentionProvider, AttentionSeverity } from "./types";

export const ATTENTION_DISMISS_HOURS = 24;
const MAX_KEY_LENGTH = 500;

const RANK: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 };

function isSeverity(value: string): value is AttentionSeverity {
  return value === "critical" || value === "warning" || value === "info";
}

export type AttentionDismissal = {
  source: string;
  id: string;
  /** The item's severity when it was dismissed; a more severe item is listed again. */
  severity: AttentionSeverity;
  until: string;
  createdAt: string;
};

/** The key of an item in the map below. */
export function dismissalKey(source: string, id: string): string {
  return `${source}\u0000${id}`;
}

/** The account's dismissals in effect at `now`, by dismissalKey. */
export async function loadAttentionDismissals(userId: number, now: Date = new Date()): Promise<Map<string, AttentionDismissal>> {
  const rows = await appDb
    .select()
    .from(attentionDismissals)
    .where(and(eq(attentionDismissals.userId, userId), gt(attentionDismissals.until, now.toISOString())))
    .orderBy(asc(attentionDismissals.until), asc(attentionDismissals.id));
  const map = new Map<string, AttentionDismissal>();
  for (const row of rows) {
    map.set(dismissalKey(row.source, row.itemId), {
      source: row.source,
      id: row.itemId,
      severity: isSeverity(row.severity) ? row.severity : "critical",
      until: row.until,
      createdAt: row.createdAt,
    });
  }
  return map;
}

/** Whether `dismissal` still hides `item` (it has not become more severe). */
export function hides(dismissal: AttentionDismissal | undefined, item: Pick<AttentionItem, "severity">): boolean {
  return dismissal !== undefined && RANK[item.severity] >= RANK[dismissal.severity];
}

/** The account's dismissals in effect, the ones ending soonest first. */
export async function listAttentionDismissals(userId: number, now: Date = new Date()): Promise<AttentionDismissal[]> {
  await appDb.delete(attentionDismissals).where(and(eq(attentionDismissals.userId, userId), lte(attentionDismissals.until, now.toISOString())));
  return [...(await loadAttentionDismissals(userId, now)).values()];
}

/** Reads {source, id}; unknown fields are refused. */
export function parseDismissalInput(body: unknown): { source: string; id: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new ApiValidationError("Request body must be a JSON object");
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "source" && key !== "id") throw new ApiValidationError(`Unknown field "${key.slice(0, 40)}"`);
  }
  return { source: requireKey(record.source, "source"), id: requireKey(record.id, "id") };
}

/** A source or item id from a request: a non-empty string of at most MAX_KEY_LENGTH characters. */
export function requireKey(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ApiValidationError(`${name} must be a non-empty string`);
  if (value.length > MAX_KEY_LENGTH) throw new ApiValidationError(`${name} must be at most ${MAX_KEY_LENGTH} characters`);
  return value;
}

/**
 * Hides an item from the reader's list. The item must be listed for the
 * reader now (its provider is asked again), so its severity is known and a
 * reader can never dismiss what they may not see.
 */
export async function dismissAttentionItem(
  access: Access,
  input: { source: string; id: string },
  providers: readonly AttentionProvider[],
  now: Date = new Date()
): Promise<AttentionDismissal> {
  const provider = providers.find((candidate) => candidate.id === input.source);
  if (!provider) throw new ApiClientError("No such item needs attention", 404);
  if (!provider.dismissible) throw new ApiValidationError(`Items of ${provider.label} cannot be dismissed`);
  const item = (await provider.collect({ access, now })).find((candidate) => candidate.id === input.id);
  if (!item) throw new ApiClientError("No such item needs attention", 404);

  const createdAt = nowIso();
  const until = new Date(now.getTime() + ATTENTION_DISMISS_HOURS * 3_600_000).toISOString();
  await appDb.transaction(async (tx) => {
    await tx.delete(attentionDismissals).where(and(eq(attentionDismissals.userId, access.userId), lte(attentionDismissals.until, now.toISOString())));
    await tx.insert(attentionDismissals)
      .values({ userId: access.userId, source: input.source, itemId: input.id, severity: item.severity, until, createdAt })
      .onConflictDoUpdate({
        target: [attentionDismissals.userId, attentionDismissals.source, attentionDismissals.itemId],
        set: { severity: item.severity, until, createdAt },
      });
  });
  return { source: input.source, id: input.id, severity: item.severity, until, createdAt };
}

/** Lists one item again, or with no item every item the account dismissed. Returns how many dismissals ended. */
export async function restoreAttentionItems(userId: number, item?: { source: string; id: string }): Promise<number> {
  const where = item
    ? and(eq(attentionDismissals.userId, userId), eq(attentionDismissals.source, item.source), eq(attentionDismissals.itemId, item.id))
    : eq(attentionDismissals.userId, userId);
  const removed = await appDb.delete(attentionDismissals).where(where).returning({ id: attentionDismissals.id });
  return removed.length;
}
