// SPDX-License-Identifier: Elastic-2.0
/**
 * Alert rules: what to watch, where to send it, how often at most.
 */
import { eq, inArray } from "drizzle-orm";
import { appDb, nowIso, toIso } from "@/src/lib/db";
import { alertRules, alertRuleStates, proxyHosts } from "@/src/lib/db/schema";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { getChannelTypes } from "./channels";
import { lastFiredAtByRule } from "./events";
import { deleteRuleDismissalsUntilResolved, deleteRuleSilences, silenceViewsByTarget } from "./silences";
import {
  DEFAULT_RULE_PARAMS,
  FOR_DURATION_RULE_TYPES,
  MAX_FOR_MINUTES,
  MAX_SCOPE_HOSTS,
  RULE_TYPE_LABELS,
  RULE_TYPES,
  SCOPED_RULE_TYPES,
  isRuleType,
  type AlertRuleView,
  type AlertSilenceView,
  type CertExpiringParams,
  type ErrorRateParams,
  type RuleParams,
  type RuleScope,
  type RuleType,
} from "./types";
import {
  parseChannelIds,
  parseJsonObject,
  readBoolean,
  readInteger,
  readName,
  rejectUnknownKeys,
  requireObject,
} from "./validation";
import { asc } from "@/src/lib/db/ops";

type RuleRow = typeof alertRules.$inferSelect;

export type StoredRule = {
  id: number;
  name: string;
  type: RuleType;
  enabled: boolean;
  params: RuleParams[RuleType];
  channelIds: number[];
  cooldownMinutes: number;
  notifyOnResolve: boolean;
  explain: boolean;
  scope: RuleScope;
  forMinutes: number;
};

const MAX_CHANNELS_PER_RULE = 20;
const MAX_COOLDOWN_MINUTES = 7 * 24 * 60;
const RULE_FIELDS = ["name", "type", "enabled", "params", "channelIds", "cooldownMinutes", "notifyOnResolve", "explain", "scope", "forMinutes"];

/** A number from min to max, rounded to one decimal. */
function readPercent(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ApiValidationError(`${field} must be a number from ${min} to ${max}`);
  const rounded = Math.round(value * 10) / 10;
  if (rounded < min || rounded > max) throw new ApiValidationError(`${field} must be a number from ${min} to ${max}`);
  return rounded;
}

const ALL: RuleScope = { type: "all" };

/** A stored scope; anything unreadable watches every host, as before scopes existed. */
export function parseStoredScope(value: string | null | undefined): RuleScope {
  const raw = parseJsonObject(value);
  if (raw.type === "hosts" && Array.isArray(raw.proxyHostIds)) {
    const ids = [...new Set(raw.proxyHostIds.filter((id): id is number => Number.isSafeInteger(id) && (id as number) > 0))];
    return { type: "hosts", proxyHostIds: ids.slice(0, MAX_SCOPE_HOSTS) };
  }
  return ALL;
}

/** Validates a scope for rule type `type`; hosts must exist. */
export async function readScope(type: RuleType, value: unknown, fallback: RuleScope = ALL): Promise<RuleScope> {
  if (value === undefined) return fallback;
  const record = requireObject(value, "scope");
  if (record.type === "all") {
    rejectUnknownKeys(record, ["type"], "scope");
    return ALL;
  }
  if (record.type !== "hosts") throw new ApiValidationError('scope.type must be "all" or "hosts"');
  if (!SCOPED_RULE_TYPES.includes(type)) {
    throw new ApiValidationError(`A ${RULE_TYPE_LABELS[type]} rule cannot be limited to chosen hosts; use {"type":"all"}`);
  }
  rejectUnknownKeys(record, ["type", "proxyHostIds"], "scope");
  if (!Array.isArray(record.proxyHostIds) || record.proxyHostIds.length === 0) {
    throw new ApiValidationError("scope.proxyHostIds must list at least one proxy host id");
  }
  if (record.proxyHostIds.length > MAX_SCOPE_HOSTS) throw new ApiValidationError(`scope.proxyHostIds may list at most ${MAX_SCOPE_HOSTS} hosts`);
  const ids = [...new Set(record.proxyHostIds.map((id) => {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw new ApiValidationError("scope.proxyHostIds must be proxy host ids");
    return id;
  }))].sort((a, b) => a - b);
  const found = new Set((await appDb.select({ id: proxyHosts.id }).from(proxyHosts).where(inArray(proxyHosts.id, ids))).map((row) => row.id));
  const missing = ids.find((id) => !found.has(id));
  if (missing !== undefined) throw new ApiValidationError(`scope.proxyHostIds: proxy host ${missing} does not exist`);
  return { type: "hosts", proxyHostIds: ids };
}

function readForMinutes(type: RuleType, value: unknown, fallback: number): number {
  const minutes = readInteger(value, "forMinutes", 0, MAX_FOR_MINUTES, fallback);
  if (minutes > 0 && !FOR_DURATION_RULE_TYPES.includes(type)) {
    throw new ApiValidationError(`A ${RULE_TYPE_LABELS[type]} rule fires at once; forMinutes must be 0`);
  }
  return minutes;
}

/** What a rule watches, in words. */
export function describeRuleScope(type: RuleType, scope: RuleScope, params: Record<string, unknown>): string {
  const hosts = scope.type === "hosts" ? scope.proxyHostIds.length : 0;
  const some = `${hosts} proxy host${hosts === 1 ? "" : "s"}`;
  switch (type) {
    case "cert_expiring":
      return scope.type === "hosts"
        ? `Certificates of ${some}`
        : (params as Partial<CertExpiringParams>).includeClientCertificates === false
          ? "All certificates"
          : "All certificates, client certificates too";
    case "upstream_down":
      return scope.type === "hosts" ? `Upstreams of ${some}` : "Every upstream with passive health checks";
    case "waf_spike":
      return scope.type === "hosts" ? some : "All hosts";
    case "error_rate":
      return (params as Partial<ErrorRateParams>).perHost === false
        ? scope.type === "hosts" ? `${some} together` : "All proxy hosts together"
        : scope.type === "hosts" ? `Each of ${some}` : "Each proxy host";
    case "instance_sync_failed":
      return "Every slave instance";
    case "caddy_apply_failed":
      return "This node";
    case "backup_failed":
      return "Every enabled backup destination";
    case "approval_pending":
      return "Protected hosts";
    case "access_review_started":
    case "access_review_overdue":
      return "Every access review";
    case "fleet_drift":
      return "Every fleet instance";
    case "fleet_rollout_failed":
      return "Every fleet environment";
  }
}

function notFound(): ApiClientError {
  return new ApiClientError("Alert rule not found", 404);
}

/** Validates rule parameters (merged over `existing` on update); unknown keys are rejected. */
export function normalizeRuleParams(type: RuleType, raw: unknown, existing?: Record<string, unknown>): RuleParams[RuleType] {
  const input = { ...DEFAULT_RULE_PARAMS[type], ...(existing ?? {}), ...requireObject(raw ?? {}, "params") } as Record<string, unknown>;
  switch (type) {
    case "cert_expiring":
      rejectUnknownKeys(input, ["days", "includeClientCertificates", "includeManagedCertificates"], "params");
      return {
        days: readInteger(input.days, "params.days", 1, 365),
        includeClientCertificates: readBoolean(input.includeClientCertificates, "params.includeClientCertificates", true),
        includeManagedCertificates: readBoolean(input.includeManagedCertificates, "params.includeManagedCertificates", true),
      };
    case "upstream_down":
      rejectUnknownKeys(input, ["minFails"], "params");
      return { minFails: readInteger(input.minFails, "params.minFails", 1, 1000) };
    case "waf_spike":
      rejectUnknownKeys(input, ["threshold", "windowMinutes"], "params");
      return {
        threshold: readInteger(input.threshold, "params.threshold", 1, 10_000_000),
        windowMinutes: readInteger(input.windowMinutes, "params.windowMinutes", 1, 24 * 60),
      };
    case "error_rate":
      rejectUnknownKeys(input, ["thresholdPercent", "windowMinutes", "minRequests", "perHost"], "params");
      return {
        thresholdPercent: readPercent(input.thresholdPercent, "params.thresholdPercent", 0.1, 100),
        windowMinutes: readInteger(input.windowMinutes, "params.windowMinutes", 1, 24 * 60),
        minRequests: readInteger(input.minRequests, "params.minRequests", 1, 10_000_000),
        perHost: readBoolean(input.perHost, "params.perHost", true),
      };
    case "backup_failed":
      rejectUnknownKeys(input, ["minFailures"], "params");
      return { minFailures: readInteger(input.minFailures, "params.minFailures", 1, 100) };
    case "instance_sync_failed":
    case "caddy_apply_failed":
    case "approval_pending":
    case "access_review_started":
    case "access_review_overdue":
    case "fleet_drift":
    case "fleet_rollout_failed":
      rejectUnknownKeys(input, [], "params");
      return {};
  }
}

function readRuleType(value: unknown): RuleType {
  if (!isRuleType(value)) throw new ApiValidationError(`type must be one of: ${RULE_TYPES.join(", ")}`);
  return value;
}

function readChannelIds(value: unknown): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ApiValidationError("channelIds must be an array of channel ids");
  if (value.length > MAX_CHANNELS_PER_RULE) throw new ApiValidationError(`A rule can notify at most ${MAX_CHANNELS_PER_RULE} channels`);
  for (const id of value) {
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
      throw new ApiValidationError("channelIds must be an array of channel ids");
    }
  }
  return [...new Set(value as number[])];
}

export function toStoredRule(row: RuleRow): StoredRule | null {
  if (!isRuleType(row.type)) return null;
  let params: RuleParams[RuleType];
  try {
    params = normalizeRuleParams(row.type, {}, parseJsonObject(row.params));
  } catch {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    params,
    channelIds: parseChannelIds(row.channelIds),
    cooldownMinutes: row.cooldownMinutes,
    notifyOnResolve: row.notifyOnResolve,
    explain: row.explain,
    scope: SCOPED_RULE_TYPES.includes(row.type) ? parseStoredScope(row.scope) : ALL,
    forMinutes: FOR_DURATION_RULE_TYPES.includes(row.type) ? Math.max(0, Math.min(MAX_FOR_MINUTES, row.forMinutes ?? 0)) : 0,
  };
}

type RuleStatesView = { firing: AlertRuleView["firing"]; pending: AlertRuleView["pending"] };
const NO_STATES: RuleStatesView = { firing: [], pending: [] };

function toView(row: RuleRow, states: RuleStatesView, lastFiredAt: string | null = null, mute: AlertSilenceView | null = null): AlertRuleView {
  const type = isRuleType(row.type) ? row.type : "caddy_apply_failed";
  const params = parseJsonObject(row.params);
  const scope = SCOPED_RULE_TYPES.includes(type) ? parseStoredScope(row.scope) : ALL;
  return {
    id: row.id,
    builtIn: row.builtIn ?? null,
    name: row.name,
    type,
    enabled: row.enabled,
    params,
    channelIds: parseChannelIds(row.channelIds),
    cooldownMinutes: row.cooldownMinutes,
    notifyOnResolve: row.notifyOnResolve,
    explain: row.explain,
    scope,
    scopeLabel: describeRuleScope(type, scope, params),
    forMinutes: row.forMinutes ?? 0,
    firing: states.firing,
    pending: states.pending,
    lastFiredAt,
    mute,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

async function firingByRule(): Promise<Map<number, RuleStatesView>> {
  const rows = await appDb
    .select({
      ruleId: alertRuleStates.ruleId,
      subjectKey: alertRuleStates.subjectKey,
      status: alertRuleStates.status,
      title: alertRuleStates.title,
      firedAt: alertRuleStates.firedAt,
      pendingSince: alertRuleStates.pendingSince,
    })
    .from(alertRuleStates)
    .where(inArray(alertRuleStates.status, ["firing", "pending"]))
    .orderBy(alertRuleStates.id);
  const map = new Map<number, RuleStatesView>();
  for (const row of rows) {
    const entry = map.get(row.ruleId) ?? { firing: [], pending: [] };
    if (row.status === "firing") {
      entry.firing.push({ subjectKey: row.subjectKey, title: row.title, firedAt: row.firedAt ? toIso(row.firedAt) : null });
    } else {
      entry.pending.push({ subjectKey: row.subjectKey, title: row.title, since: row.pendingSince ? toIso(row.pendingSince) : null });
    }
    map.set(row.ruleId, entry);
  }
  return map;
}

async function getRuleRow(id: number): Promise<RuleRow | null> {
  const [row] = await appDb.select().from(alertRules).where(eq(alertRules.id, id));
  return row ?? null;
}

export async function listAlertRules(): Promise<AlertRuleView[]> {
  const [rows, firing, lastFired, silences] = await Promise.all([
    appDb.select().from(alertRules).orderBy(asc(alertRules.name), asc(alertRules.id)),
    firingByRule(),
    lastFiredAtByRule(),
    silenceViewsByTarget(),
  ]);
  // Rows of a rule type that no longer exists stay stored but are not listed.
  return rows
    .filter((row) => isRuleType(row.type))
    .map((row) => toView(row, firing.get(row.id) ?? NO_STATES, lastFired.get(row.id) ?? null, silences.mutes.get(row.id) ?? null));
}

export async function getAlertRule(id: number): Promise<AlertRuleView | null> {
  const row = await getRuleRow(id);
  if (!row || !isRuleType(row.type)) return null;
  return toView(
    row,
    (await firingByRule()).get(id) ?? NO_STATES,
    (await lastFiredAtByRule([id])).get(id) ?? null,
    (await silenceViewsByTarget()).mutes.get(id) ?? null
  );
}

export async function createAlertRule(body: unknown, actorUserId: number): Promise<AlertRuleView> {
  const record = requireObject(body, "Request body");
  const type = readRuleType(record.type);
  const channelIds = readChannelIds(record.channelIds);
  await getChannelTypes(channelIds);
  const explain = readBoolean(record.explain, "explain", false);

  rejectUnknownKeys(record, RULE_FIELDS, "the rule");
  const name = readName(record.name);
  const params = normalizeRuleParams(type, record.params);
  const enabled = readBoolean(record.enabled, "enabled", true);
  const cooldownMinutes = readInteger(record.cooldownMinutes, "cooldownMinutes", 0, MAX_COOLDOWN_MINUTES, 60);
  const notifyOnResolve = readBoolean(record.notifyOnResolve, "notifyOnResolve", true);
  const scope = await readScope(type, record.scope);
  const forMinutes = readForMinutes(type, record.forMinutes, 0);
  const now = nowIso();
  const [row] = await appDb
    .insert(alertRules)
    .values({
      name,
      type,
      enabled,
      params: JSON.stringify(params),
      channelIds: JSON.stringify(channelIds),
      cooldownMinutes,
      notifyOnResolve,
      explain,
      scope: JSON.stringify(scope),
      forMinutes,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await logAuditEvent({
    userId: actorUserId,
    action: "alert_rule_created",
    entityType: "alert_rule",
    entityId: row.id,
    summary: `Created ${RULE_TYPE_LABELS[type]} alert rule "${name}"`,
    data: { type, name, enabled, params, channelIds, cooldownMinutes, notifyOnResolve, explain, scope, forMinutes },
  });
  return toView(row, NO_STATES);
}

export async function updateAlertRule(id: number, body: unknown, actorUserId: number): Promise<AlertRuleView> {
  const row = await getRuleRow(id);
  if (!row || !isRuleType(row.type)) throw notFound();
  const type = row.type;
  const record = requireObject(body, "Request body");
  if (record.type !== undefined && record.type !== type) {
    throw new ApiValidationError("The type of an alert rule cannot be changed; create a new rule instead");
  }
  const channelIds = record.channelIds !== undefined ? readChannelIds(record.channelIds) : parseChannelIds(row.channelIds);
  await getChannelTypes(channelIds);
  const explain = readBoolean(record.explain, "explain", row.explain);

  rejectUnknownKeys(record, RULE_FIELDS, "the rule");
  const name = record.name !== undefined ? readName(record.name) : row.name;
  const params = normalizeRuleParams(type, record.params, parseJsonObject(row.params));
  const enabled = readBoolean(record.enabled, "enabled", row.enabled);
  const cooldownMinutes = readInteger(record.cooldownMinutes, "cooldownMinutes", 0, MAX_COOLDOWN_MINUTES, row.cooldownMinutes);
  const notifyOnResolve = readBoolean(record.notifyOnResolve, "notifyOnResolve", row.notifyOnResolve);
  const scope = await readScope(type, record.scope, SCOPED_RULE_TYPES.includes(type) ? parseStoredScope(row.scope) : ALL);
  const forMinutes = readForMinutes(type, record.forMinutes, FOR_DURATION_RULE_TYPES.includes(type) ? row.forMinutes ?? 0 : 0);
  const [updated] = await appDb
    .update(alertRules)
    .set({
      name,
      enabled,
      params: JSON.stringify(params),
      channelIds: JSON.stringify(channelIds),
      cooldownMinutes,
      notifyOnResolve,
      explain,
      scope: JSON.stringify(scope),
      forMinutes,
      updatedAt: nowIso(),
    })
    .where(eq(alertRules.id, id))
    .returning();
  if (!enabled) {
    // A disabled rule stops watching: forget what was firing (no resolve
    // notice), and so the dismissals that last until those alerts resolve.
    await appDb.delete(alertRuleStates).where(eq(alertRuleStates.ruleId, id));
    await deleteRuleDismissalsUntilResolved(id);
  }
  await logAuditEvent({
    userId: actorUserId,
    action: "alert_rule_updated",
    entityType: "alert_rule",
    entityId: id,
    summary: `Updated ${RULE_TYPE_LABELS[type]} alert rule "${name}"`,
    data: { type, name, enabled, params, channelIds, cooldownMinutes, notifyOnResolve, explain, scope, forMinutes },
  });
  return toView(
    updated,
    enabled ? (await firingByRule()).get(id) ?? NO_STATES : NO_STATES,
    (await lastFiredAtByRule([id])).get(id) ?? null,
    (await silenceViewsByTarget()).mutes.get(id) ?? null
  );
}

export async function deleteAlertRule(id: number, actorUserId: number): Promise<void> {
  const row = await getRuleRow(id);
  if (!row) throw notFound();
  if (row.builtIn) throw new ApiClientError("Built-in alert rules cannot be deleted; disable the rule instead", 409);
  // A rule of a type that no longer exists can still be deleted.
  const type = row.type;
  const label = isRuleType(type) ? RULE_TYPE_LABELS[type] : type;
  // Foreign-key cascades are not enforced: delete the state rows, mutes and
  // dismissals explicitly. History (alert_events) is kept.
  await appDb.delete(alertRuleStates).where(eq(alertRuleStates.ruleId, id));
  await deleteRuleSilences(id);
  await appDb.delete(alertRules).where(eq(alertRules.id, id));
  await logAuditEvent({
    userId: actorUserId,
    action: "alert_rule_deleted",
    entityType: "alert_rule",
    entityId: id,
    summary: `Deleted ${label} alert rule "${row.name}"`,
    data: { type, name: row.name },
  });
}

/** Enabled rules for the evaluator; rows of a removed rule type are skipped. */
export async function listEnabledRules(): Promise<StoredRule[]> {
  const rows = await appDb.select().from(alertRules).where(eq(alertRules.enabled, true)).orderBy(asc(alertRules.id));
  return rows.map(toStoredRule).filter((rule): rule is StoredRule => rule !== null);
}
