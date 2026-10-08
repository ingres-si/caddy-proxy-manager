// SPDX-License-Identifier: Elastic-2.0
/**
 * Alert history (firing and resolved transitions).
 */
import { and, count, eq, gt, inArray, lt, max } from "drizzle-orm";
import { appDb, toIso } from "@/src/lib/db";
import { alertEvents, alertRules, alertRuleStates } from "@/src/lib/db/schema";
import { isRuleType, type AlertEventView, type FiringAlertView, type RuleType, type Severity } from "./types";
import { issueLinks } from "./links";
import { asc, desc } from "@/src/lib/db/ops";
import { loadActiveSilences, silenceViewsByTarget, subjectId } from "./silences";

type EventRow = typeof alertEvents.$inferSelect;

export const ALERT_EVENT_RETENTION_DAYS = 90;

function parseDeliveries(value: string | null): AlertEventView["deliveries"] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        channelId: Number(item.channelId),
        channelName: String(item.channelName ?? ""),
        ok: item.ok === true,
        error: typeof item.error === "string" ? item.error : null,
      }));
  } catch {
    return [];
  }
}

export function toAlertEventView(row: EventRow, resolvedAt: string | null = null): AlertEventView {
  return {
    id: row.id,
    ruleId: row.ruleId,
    ruleName: row.ruleName,
    ruleType: row.ruleType,
    subjectKey: row.subjectKey,
    status: row.status === "resolved" ? "resolved" : "firing",
    severity: (["critical", "warning", "info"].includes(row.severity) ? row.severity : "warning") as Severity,
    title: row.title,
    message: row.message,
    explanation: row.explanation ?? null,
    notified: row.notified,
    deliveries: parseDeliveries(row.deliveries),
    createdAt: toIso(row.createdAt)!,
    resolvedAt: row.status === "firing" ? resolvedAt : null,
    silenced: row.silenced === "muted" || row.silenced === "dismissed" ? row.silenced : null,
  };
}

/** For each firing event, when the same rule and subject next resolved (the end of that episode). */
async function resolutionsOf(rows: EventRow[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  for (const row of rows) {
    if (row.status !== "firing") continue;
    const [next] = await appDb
      .select({ status: alertEvents.status, createdAt: alertEvents.createdAt })
      .from(alertEvents)
      .where(and(eq(alertEvents.ruleId, row.ruleId), eq(alertEvents.subjectKey, row.subjectKey), gt(alertEvents.id, row.id)))
      .orderBy(asc(alertEvents.id))
      .limit(1);
    if (next?.status === "resolved") result.set(row.id, toIso(next.createdAt)!);
  }
  return result;
}

export async function listAlertEvents(options: { page: number; perPage: number; ruleId?: number }): Promise<{
  events: AlertEventView[];
  total: number;
  page: number;
  perPage: number;
}> {
  const where = options.ruleId !== undefined ? eq(alertEvents.ruleId, options.ruleId) : undefined;
  const [rows, [{ value: total }]] = await Promise.all([
    appDb
      .select()
      .from(alertEvents)
      .where(where)
      .orderBy(desc(alertEvents.createdAt), desc(alertEvents.id))
      .limit(options.perPage)
      .offset((options.page - 1) * options.perPage),
    appDb.select({ value: count() }).from(alertEvents).where(where),
  ]);
  const resolutions = await resolutionsOf(rows);
  return { events: rows.map((row) => toAlertEventView(row, resolutions.get(row.id) ?? null)), total, page: options.page, perPage: options.perPage };
}

/** The stored facts of an event; {} when there are none or they cannot be read. */
function parseFacts(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Every subject firing now, with the event that started it and its
 * dismissal or mute: the ones neither dismissed nor muted first, then most
 * severe and newest first.
 */
export async function listFiringAlerts(): Promise<FiringAlertView[]> {
  const states = await appDb
    .select({
      ruleId: alertRuleStates.ruleId,
      subjectKey: alertRuleStates.subjectKey,
      title: alertRuleStates.title,
      firedAt: alertRuleStates.firedAt,
      ruleName: alertRules.name,
      ruleType: alertRules.type,
      notifyOnResolve: alertRules.notifyOnResolve,
    })
    .from(alertRuleStates)
    .innerJoin(alertRules, eq(alertRules.id, alertRuleStates.ruleId))
    .where(and(eq(alertRuleStates.status, "firing"), eq(alertRules.enabled, true)));
  if (states.length === 0) return [];
  const ruleIds = [...new Set(states.map((state) => state.ruleId))];
  const events = await appDb
    .select()
    .from(alertEvents)
    .where(and(inArray(alertEvents.ruleId, ruleIds), eq(alertEvents.status, "firing")))
    .orderBy(desc(alertEvents.id));
  const latest = new Map<string, EventRow>();
  for (const event of events) {
    const key = subjectId(event.ruleId, event.subjectKey);
    if (!latest.has(key)) latest.set(key, event);
  }
  const silences = await silenceViewsByTarget();
  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  const quiet = (alert: FiringAlertView) => (alert.dismissal || alert.mute ? 1 : 0);
  return states
    .filter((state) => isRuleType(state.ruleType))
    .map((state): FiringAlertView => {
      const event = latest.get(subjectId(state.ruleId, state.subjectKey));
      const view = event ? toAlertEventView(event) : null;
      return {
        ruleId: state.ruleId,
        ruleName: state.ruleName,
        ruleType: state.ruleType as FiringAlertView["ruleType"],
        subjectKey: state.subjectKey,
        severity: view?.severity ?? "warning",
        title: view?.title ?? state.title ?? state.subjectKey,
        message: view?.message ?? "",
        firedAt: state.firedAt ? toIso(state.firedAt) : view?.createdAt ?? null,
        deliveries: view?.deliveries ?? [],
        silenced: view?.silenced ?? null,
        eventId: view?.id ?? null,
        notifyOnResolve: state.notifyOnResolve,
        dismissal: silences.dismissals.get(subjectId(state.ruleId, state.subjectKey)) ?? null,
        mute: silences.mutes.get(state.ruleId) ?? null,
        links: issueLinks(state.ruleType as RuleType, state.subjectKey, parseFacts(event?.facts ?? null)),
      };
    })
    .sort((a, b) => quiet(a) - quiet(b) || rank[a.severity] - rank[b.severity] || (b.firedAt ?? "").localeCompare(a.firedAt ?? ""));
}

/**
 * Alerts firing now that are neither dismissed nor muted (the sidebar badge
 * and "Needs attention" leave the others out).
 */
export async function countFiringAlertsNeedingAttention(now: Date = new Date()): Promise<number> {
  const states = await appDb
    .select({ ruleId: alertRuleStates.ruleId, subjectKey: alertRuleStates.subjectKey })
    .from(alertRuleStates)
    .innerJoin(alertRules, eq(alertRules.id, alertRuleStates.ruleId))
    .where(and(eq(alertRuleStates.status, "firing"), eq(alertRules.enabled, true)));
  if (states.length === 0) return 0;
  const silences = await loadActiveSilences(now);
  return states.filter((state) => !silences.mutes.has(state.ruleId) && !silences.dismissals.has(subjectId(state.ruleId, state.subjectKey))).length;
}

/** When each rule last fired (its newest firing event in the kept history), by rule id. */
export async function lastFiredAtByRule(ruleIds?: number[]): Promise<Map<number, string>> {
  if (ruleIds && ruleIds.length === 0) return new Map();
  const rows = await appDb
    .select({ ruleId: alertEvents.ruleId, at: max(alertEvents.createdAt) })
    .from(alertEvents)
    .where(and(eq(alertEvents.status, "firing"), ruleIds ? inArray(alertEvents.ruleId, ruleIds) : undefined))
    .groupBy(alertEvents.ruleId);
  const map = new Map<number, string>();
  for (const row of rows) {
    if (row.at) map.set(row.ruleId, toIso(row.at)!);
  }
  return map;
}

export async function pruneAlertEvents(now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - ALERT_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await appDb.delete(alertEvents).where(lt(alertEvents.createdAt, cutoff));
}
