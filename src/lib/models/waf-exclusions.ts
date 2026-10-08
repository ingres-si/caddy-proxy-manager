/**
 * WAF rule exclusions as records (table waf_rule_exclusions): which rule, for
 * the global settings or one proxy host, optionally limited to a path and/or
 * a variable, with a reason, who added it and when. The directives they
 * become are built in src/lib/waf-exclusions.ts.
 *
 * Legacy lists. Before records existed, excluded rules were plain id lists:
 * `excluded_rule_ids` in the "waf" setting and in each host's meta.waf. They
 * stay as a mirror of the whole-scope exclusions (no path, no variable), kept
 * in step on every change, so the REST fields that carry them keep working,
 * replicas on older releases keep the exclusions, and a downgrade loses none.
 * Writes through those lists (the settings and proxy host APIs) are applied
 * to the records with replaceWholeScopeExclusions; importLegacyWafExclusions
 * copies list entries without a record into the table (at start-up and after
 * a configuration import or restore) and is idempotent.
 *
 * Everything here runs inside one transaction (database work only), so a
 * record and its mirror never disagree.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { appDb, nowIso } from "../db";
import { proxyHosts, users, wafRuleExclusions } from "../db/schema";
import type { DbTransaction } from "../config-content";
import { logAuditEvent } from "../audit";
import { ApiClientError, ApiConflictError, ApiValidationError } from "../api-errors";
import {
  MAX_EXCLUSION_REASON_LENGTH,
  parseWafExclusionMatch,
  WafExclusionInputError,
  type WafExclusionMatch,
  type WafExclusionPathMatch,
} from "../waf-exclusions";
import { assertHostUpdateApproved } from "@/ee/approvals/guard";
import { parseStoredTags } from "../host-tags";
import { syncWafExclusionMirror } from "./waf-exclusion-mirror";
import { asc, first } from "@/src/lib/db/ops";

export {
  deleteWafExclusionsForHost,
  importLegacyWafExclusions,
  importLegacyWafExclusionsNow,
  LEGACY_EXCLUSION_REASON,
  LIST_EXCLUSION_REASON,
  replaceWholeScopeExclusions,
  syncWafExclusionMirror,
} from "./waf-exclusion-mirror";

export type WafExclusionRow = typeof wafRuleExclusions.$inferSelect;

/** An exclusion as the API and the dashboard show it. */
export type WafExclusion = {
  id: number;
  ruleId: number;
  scope: "global" | "host";
  proxyHostId: number | null;
  /** The host's name and domains; null for global exclusions (and a host that no longer exists). */
  host: { id: number; name: string; domains: string[] } | null;
  pathMatch: WafExclusionPathMatch | null;
  path: string | null;
  variable: string | null;
  reason: string;
  /** Who added it; null when unknown (migrated from a rule list, synced from a master, or the user was deleted). */
  createdBy: { id: number; name: string } | null;
  createdAt: string;
  updatedAt: string;
};

export type WafExclusionInput = {
  ruleId?: unknown;
  /** Null or absent: the global WAF settings. */
  proxyHostId?: unknown;
  path?: unknown;
  pathMatch?: unknown;
  variable?: unknown;
  reason?: unknown;
};

function parseReason(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ApiValidationError("reason must be a string");
  const reason = value.trim();
  if (reason.length > MAX_EXCLUSION_REASON_LENGTH) {
    throw new ApiValidationError(`reason must be at most ${MAX_EXCLUSION_REASON_LENGTH} characters`);
  }
  // A reason is shown in tables and the audit log: one line, no control characters.
  if ([...reason].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new ApiValidationError("reason must be one line without control characters");
  }
  return reason;
}

function parseMatch(input: WafExclusionInput): WafExclusionMatch {
  try {
    return parseWafExclusionMatch(input);
  } catch (error) {
    if (error instanceof WafExclusionInputError) throw new ApiValidationError(error.message);
    throw error;
  }
}

function parseHostId(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ApiValidationError("proxyHostId must be a proxy host id or null");
  }
  return value;
}

// ── Reading ────────────────────────────────────────────────────────────────

/** Every exclusion record, oldest first: what the Caddy config is built from. */
export async function listWafExclusionRows(): Promise<WafExclusionRow[]> {
  return appDb.select().from(wafRuleExclusions).orderBy(asc(wafRuleExclusions.id));
}

type HostInfo = { id: number; name: string; domains: string[] };

function toView(row: WafExclusionRow, hostsById: Map<number, HostInfo>, usersById: Map<number, string>): WafExclusion {
  const createdByName = row.createdBy !== null ? usersById.get(row.createdBy) : undefined;
  return {
    id: row.id,
    ruleId: row.ruleId,
    scope: row.proxyHostId === null ? "global" : "host",
    proxyHostId: row.proxyHostId,
    host: row.proxyHostId !== null ? hostsById.get(row.proxyHostId) ?? null : null,
    pathMatch: row.path ? (row.pathMatch === "prefix" ? "prefix" : "exact") : null,
    path: row.path || null,
    variable: row.variable || null,
    reason: row.reason,
    createdBy: row.createdBy !== null && createdByName ? { id: row.createdBy, name: createdByName } : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function viewsOf(rows: WafExclusionRow[]): Promise<WafExclusion[]> {
  const hostIds = [...new Set(rows.map((row) => row.proxyHostId).filter((id): id is number => id !== null))];
  const userIds = [...new Set(rows.map((row) => row.createdBy).filter((id): id is number => id !== null))];
  const [hostRows, userRows] = await Promise.all([
    hostIds.length > 0
      ? appDb.select({ id: proxyHosts.id, name: proxyHosts.name, domains: proxyHosts.domains }).from(proxyHosts).where(inArray(proxyHosts.id, hostIds))
      : Promise.resolve([]),
    userIds.length > 0
      ? appDb.select({ id: users.id, name: users.name, username: users.username }).from(users).where(inArray(users.id, userIds))
      : Promise.resolve([]),
  ]);
  const hostsById = new Map<number, HostInfo>(
    hostRows.map((host) => {
      let domains: string[];
      try {
        const parsed = JSON.parse(host.domains) as unknown;
        domains = Array.isArray(parsed) ? parsed.filter((domain): domain is string => typeof domain === "string") : [];
      } catch {
        domains = [];
      }
      return [host.id, { id: host.id, name: host.name, domains }];
    })
  );
  // The sign-in name or display name; never the e-mail address, which a role
  // that only reads the WAF has no business seeing.
  const usersById = new Map(userRows.map((user) => [user.id, user.username || user.name || `User ${user.id}`]));
  return rows.map((row) => toView(row, hostsById, usersById));
}

export type WafExclusionFilter = {
  /** null: global exclusions only; a number: that host's only. */
  proxyHostId?: number | null;
  ruleId?: number;
};

export async function listWafExclusions(filter: WafExclusionFilter = {}): Promise<WafExclusion[]> {
  const conditions = [];
  if (filter.proxyHostId === null) conditions.push(isNull(wafRuleExclusions.proxyHostId));
  else if (filter.proxyHostId !== undefined) conditions.push(eq(wafRuleExclusions.proxyHostId, filter.proxyHostId));
  if (filter.ruleId !== undefined) conditions.push(eq(wafRuleExclusions.ruleId, filter.ruleId));
  const rows = await appDb
    .select()
    .from(wafRuleExclusions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(wafRuleExclusions.id));
  return viewsOf(rows);
}

export async function getWafExclusion(id: number): Promise<WafExclusion | null> {
  const row = await first(appDb.select().from(wafRuleExclusions).where(eq(wafRuleExclusions.id, id)).limit(1));
  return row ? (await viewsOf([row]))[0] : null;
}

// ── Writing ────────────────────────────────────────────────────────────────

function sameMatch(row: WafExclusionRow, match: WafExclusionMatch): boolean {
  return (
    row.ruleId === match.ruleId &&
    (row.path || null) === match.path &&
    (row.path ? row.pathMatch : null) === match.pathMatch &&
    (row.variable || null) === match.variable
  );
}

function scopeLabel(host: { name: string } | null): string {
  return host ? `proxy host "${host.name}"` : "the global WAF settings";
}

function describeMatch(match: WafExclusionMatch): string {
  const parts = [`rule ${match.ruleId}`];
  if (match.path) parts.push(`${match.pathMatch === "prefix" ? "paths under" : "path"} ${match.path}`);
  if (match.variable) parts.push(`variable ${match.variable}`);
  return parts.join(", ");
}

/**
 * The proxy host a host-scoped write targets. A host a change approval policy
 * protects is refused (409) here, as every other change to it outside a
 * change request is.
 */
async function hostForWrite(tx: DbTransaction, proxyHostId: number): Promise<{ id: number; name: string }> {
  const host = await first(tx.select().from(proxyHosts).where(eq(proxyHosts.id, proxyHostId)).limit(1));
  if (!host) throw new ApiClientError("Proxy host not found", 404);
  await assertHostUpdateApproved(
    "proxy_host",
    { id: host.id, name: host.name, enabled: host.enabled, tags: parseStoredTags(host.tags) },
    { waf: {} }
  );
  return { id: host.id, name: host.name };
}

/** The Caddy configuration did not apply after a change; the change was undone. */
export class WafApplyError extends Error {
  constructor(readonly cause: unknown) {
    super("Caddy did not accept the new configuration, so the change was undone");
    this.name = "WafApplyError";
  }
}

/** How a write is applied: usually applyCaddyConfig. Without one, the change is only stored. */
export type WafWriteOptions = { apply?: () => Promise<unknown> };

/**
 * Applies a stored change. When applying fails the change is undone (and the
 * previous configuration applied again, best effort), so a record never
 * stays behind that Caddy refused; WafApplyError says so.
 */
async function applyOrUndo(options: WafWriteOptions, undo: (tx: DbTransaction) => Promise<void>): Promise<void> {
  if (!options.apply) return;
  try {
    await options.apply();
  } catch (error) {
    await appDb.transaction(async (tx) => await undo(tx));
    await options.apply().catch(() => undefined);
    throw new WafApplyError(error);
  }
}

/** Adds an exclusion. Refuses an exact duplicate of an existing one (409). */
export async function createWafExclusion(
  input: WafExclusionInput,
  actorUserId: number | null,
  options: WafWriteOptions = {}
): Promise<WafExclusion> {
  const match = parseMatch(input);
  const proxyHostId = parseHostId(input.proxyHostId);
  const reason = parseReason(input.reason);
  const { id, host } = await appDb.transaction(async (tx) => {
    const host = proxyHostId === null ? null : await hostForWrite(tx, proxyHostId);
    const scope = proxyHostId === null ? isNull(wafRuleExclusions.proxyHostId) : eq(wafRuleExclusions.proxyHostId, proxyHostId);
    const duplicate = (await tx
      .select()
      .from(wafRuleExclusions)
      .where(and(scope, eq(wafRuleExclusions.ruleId, match.ruleId))))
      .find((row) => sameMatch(row, match));
    if (duplicate) throw new ApiConflictError(`This exclusion already exists (id ${duplicate.id})`);
    const now = nowIso();
    const [row] = await tx
      .insert(wafRuleExclusions)
      .values({ ...match, proxyHostId, reason, createdBy: actorUserId, createdAt: now, updatedAt: now })
      .returning();
    await syncWafExclusionMirror(tx, proxyHostId);
    return { id: row.id, host };
  });
  await applyOrUndo(options, async (tx) => {
    await tx.delete(wafRuleExclusions).where(eq(wafRuleExclusions.id, id));
    await syncWafExclusionMirror(tx, proxyHostId);
  });
  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "waf_exclusion",
    entityId: id,
    summary: `Excluded ${describeMatch(match)} for ${scopeLabel(host)}`,
    data: { ...match, proxyHostId, reason },
  });
  return (await getWafExclusion(id))!;
}

/** The most exclusions one batch adds. */
export const MAX_WAF_EXCLUSION_BATCH = 50;

/**
 * Adds several exclusions at once (the rules that added to one WAF event's
 * score, say): all of them or none, with one apply. Refuses the batch when
 * one of them exists already or is given twice (409).
 */
export async function createWafExclusions(
  inputs: readonly WafExclusionInput[],
  actorUserId: number | null,
  options: WafWriteOptions = {}
): Promise<WafExclusion[]> {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new ApiValidationError("exclusions must list at least one exclusion");
  if (inputs.length > MAX_WAF_EXCLUSION_BATCH) throw new ApiValidationError(`exclusions takes at most ${MAX_WAF_EXCLUSION_BATCH} at once`);
  const parsed = inputs.map((input, index) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiValidationError(`exclusions[${index}] must be an object`);
    return { match: parseMatch(input), proxyHostId: parseHostId(input.proxyHostId), reason: parseReason(input.reason) };
  });
  parsed.forEach((entry, index) => {
    const twice = parsed.findIndex(
      (other, i) =>
        i < index &&
        other.proxyHostId === entry.proxyHostId &&
        other.match.ruleId === entry.match.ruleId &&
        other.match.path === entry.match.path &&
        other.match.pathMatch === entry.match.pathMatch &&
        other.match.variable === entry.match.variable
    );
    if (twice !== -1) throw new ApiValidationError(`exclusions[${index}] is the same as exclusions[${twice}]`);
  });

  const created = await appDb.transaction(async (tx) => {
    const hosts = new Map<number, { id: number; name: string }>();
    for (const { proxyHostId } of parsed) {
      if (proxyHostId !== null && !hosts.has(proxyHostId)) hosts.set(proxyHostId, await hostForWrite(tx, proxyHostId));
    }
    const now = nowIso();
    const rows: { id: number; proxyHostId: number | null }[] = [];
    for (const { match, proxyHostId, reason } of parsed) {
      const scope = proxyHostId === null ? isNull(wafRuleExclusions.proxyHostId) : eq(wafRuleExclusions.proxyHostId, proxyHostId);
      const duplicate = (await tx
        .select()
        .from(wafRuleExclusions)
        .where(and(scope, eq(wafRuleExclusions.ruleId, match.ruleId))))
        .find((row) => sameMatch(row, match));
      if (duplicate) throw new ApiConflictError(`The exclusion of ${describeMatch(match)} already exists (id ${duplicate.id})`);
      const [row] = await tx
        .insert(wafRuleExclusions)
        .values({ ...match, proxyHostId, reason, createdBy: actorUserId, createdAt: now, updatedAt: now })
        .returning();
      rows.push({ id: row.id, proxyHostId });
    }
    for (const scope of new Set(parsed.map((entry) => entry.proxyHostId))) await syncWafExclusionMirror(tx, scope);
    return { rows, hosts };
  });
  const ids = created.rows.map((row) => row.id);
  await applyOrUndo(options, async (tx) => {
    await tx.delete(wafRuleExclusions).where(inArray(wafRuleExclusions.id, ids));
    for (const scope of new Set(parsed.map((entry) => entry.proxyHostId))) await syncWafExclusionMirror(tx, scope);
  });
  for (const [index, { match, proxyHostId, reason }] of parsed.entries()) {
    await logAuditEvent({
      userId: actorUserId,
      action: "create",
      entityType: "waf_exclusion",
      entityId: ids[index],
      summary: `Excluded ${describeMatch(match)} for ${scopeLabel(proxyHostId === null ? null : created.hosts.get(proxyHostId) ?? null)}`,
      data: { ...match, proxyHostId, reason },
    });
  }
  return (await Promise.all(ids.map((id) => getWafExclusion(id)))).filter((exclusion): exclusion is WafExclusion => exclusion !== null);
}

/**
 * Changes an exclusion's reason, path or variable (its rule and scope stay:
 * a different rule or scope is a different exclusion).
 */
export async function updateWafExclusion(
  id: number,
  input: WafExclusionInput,
  actorUserId: number | null,
  options: WafWriteOptions = {}
): Promise<WafExclusion> {
  for (const key of ["ruleId", "proxyHostId"] as const) {
    if (input[key] !== undefined) throw new ApiValidationError(`${key} cannot be changed; delete the exclusion and add a new one`);
  }
  const { previous, match, host, reason } = await appDb.transaction(async (tx) => {
    const row = await first(tx.select().from(wafRuleExclusions).where(eq(wafRuleExclusions.id, id)).limit(1));
    if (!row) throw new ApiClientError("WAF exclusion not found", 404);
    const host = row.proxyHostId === null ? null : await hostForWrite(tx, row.proxyHostId);
    const match = parseMatch({
      ruleId: row.ruleId,
      path: input.path !== undefined ? input.path : row.path,
      pathMatch: input.pathMatch !== undefined ? input.pathMatch : input.path !== undefined ? undefined : row.path ? row.pathMatch : undefined,
      variable: input.variable !== undefined ? input.variable : row.variable,
    });
    const reason = input.reason !== undefined ? parseReason(input.reason) : row.reason;
    const scope = row.proxyHostId === null ? isNull(wafRuleExclusions.proxyHostId) : eq(wafRuleExclusions.proxyHostId, row.proxyHostId);
    const duplicate = (await tx
      .select()
      .from(wafRuleExclusions)
      .where(and(scope, eq(wafRuleExclusions.ruleId, match.ruleId))))
      .find((other) => other.id !== id && sameMatch(other, match));
    if (duplicate) throw new ApiConflictError(`This exclusion already exists (id ${duplicate.id})`);
    await tx.update(wafRuleExclusions)
      .set({ pathMatch: match.pathMatch, path: match.path, variable: match.variable, reason, updatedAt: nowIso() })
      .where(eq(wafRuleExclusions.id, id));
    await syncWafExclusionMirror(tx, row.proxyHostId);
    return { previous: row, match, host, reason };
  });
  await applyOrUndo(options, async (tx) => {
    const { id: _id, ...fields } = previous;
    void _id;
    await tx.update(wafRuleExclusions).set(fields).where(eq(wafRuleExclusions.id, id));
    await syncWafExclusionMirror(tx, previous.proxyHostId);
  });
  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "waf_exclusion",
    entityId: id,
    summary: `Changed the exclusion of ${describeMatch(match)} for ${scopeLabel(host)}`,
    data: { ...match, reason },
  });
  return (await getWafExclusion(id))!;
}

/** Removes an exclusion. Never checks an approval: removing one only makes the WAF stricter. */
export async function deleteWafExclusion(id: number, actorUserId: number | null, options: WafWriteOptions = {}): Promise<void> {
  const deleted = await appDb.transaction(async (tx) => {
    const row = await first(tx.select().from(wafRuleExclusions).where(eq(wafRuleExclusions.id, id)).limit(1));
    if (!row) throw new ApiClientError("WAF exclusion not found", 404);
    const host = row.proxyHostId === null
      ? null
      : await first(tx.select({ name: proxyHosts.name }).from(proxyHosts).where(eq(proxyHosts.id, row.proxyHostId)).limit(1)) ?? null;
    await tx.delete(wafRuleExclusions).where(eq(wafRuleExclusions.id, id));
    await syncWafExclusionMirror(tx, row.proxyHostId);
    return { row, host };
  });
  await applyOrUndo(options, async (tx) => {
    await tx.insert(wafRuleExclusions).values(deleted.row);
    await syncWafExclusionMirror(tx, deleted.row.proxyHostId);
  });
  const match = {
    ruleId: deleted.row.ruleId,
    path: deleted.row.path || null,
    pathMatch: deleted.row.path ? (deleted.row.pathMatch as WafExclusionPathMatch) : null,
    variable: deleted.row.variable || null,
  };
  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "waf_exclusion",
    entityId: id,
    summary: `Removed the exclusion of ${describeMatch(match)} for ${scopeLabel(deleted.host)}`,
    data: { ...match, proxyHostId: deleted.row.proxyHostId },
  });
}

/** Counts of exclusions per scope key ("global" or the host id), for summaries. */
export async function countWafExclusionsByScope(): Promise<Map<number | "global", number>> {
  const rows = await appDb.select({ proxyHostId: wafRuleExclusions.proxyHostId }).from(wafRuleExclusions);
  const counts = new Map<number | "global", number>();
  for (const row of rows) {
    const key = row.proxyHostId ?? "global";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
