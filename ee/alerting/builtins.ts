// SPDX-License-Identifier: Elastic-2.0
/**
 * Built-in alert rules: what every install watches without setting anything
 * up. They are ordinary rules (alert_rules rows with a `builtIn` key) that
 * start enabled and notify nobody, so what they find is listed as an issue on
 * the overview and the Alerts page until a channel is added to them. They can
 * be changed and disabled, not deleted.
 *
 * Each built-in has the version of BUILT_IN_RULES_VERSION that introduced it.
 * ensureBuiltInAlertRules() adds those newer than the version stored in the
 * settings, then stores the current one, so a later release can add rules and
 * a rule someone disabled stays as they left it. On an install that already
 * has a rule of the same type, that built-in is not added.
 */
import { appDb, nowIso } from "@/src/lib/db";
import { alertRules } from "@/src/lib/db/schema";
import { getSetting, setSetting } from "@/src/lib/settings";
import { DEFAULT_RULE_PARAMS, type RuleParams, type RuleType } from "./types";

export const BUILT_IN_RULES_VERSION = 1;
const VERSION_SETTING = "alerting_built_in_rules_version";

export type BuiltInRule<T extends RuleType = RuleType> = {
  key: string;
  type: T;
  name: string;
  enabled: boolean;
  params: RuleParams[T];
  forMinutes: number;
  /** The BUILT_IN_RULES_VERSION that introduced it. */
  since: number;
};

function rule<T extends RuleType>(definition: BuiltInRule<T>): BuiltInRule {
  return definition as unknown as BuiltInRule;
}

export const BUILT_IN_RULES: readonly BuiltInRule[] = [
  rule({ key: "certificates", type: "cert_expiring", name: "Certificates expiring or not renewed", enabled: true, params: DEFAULT_RULE_PARAMS.cert_expiring, forMinutes: 0, since: 1 }),
  rule({ key: "caddy_apply", type: "caddy_apply_failed", name: "Configuration not applied to Caddy", enabled: true, params: {}, forMinutes: 0, since: 1 }),
  rule({ key: "error_rate", type: "error_rate", name: "Server errors", enabled: true, params: DEFAULT_RULE_PARAMS.error_rate, forMinutes: 0, since: 1 }),
  // Two minutes, so one failed health check during a restart does not open an issue.
  rule({ key: "upstreams", type: "upstream_down", name: "Upstream failing", enabled: true, params: DEFAULT_RULE_PARAMS.upstream_down, forMinutes: 2, since: 1 }),
  rule({ key: "backups", type: "backup_failed", name: "Scheduled backup failed", enabled: true, params: DEFAULT_RULE_PARAMS.backup_failed, forMinutes: 0, since: 1 }),
  rule({ key: "instance_sync", type: "instance_sync_failed", name: "Instance sync failed", enabled: true, params: {}, forMinutes: 0, since: 1 }),
  rule({ key: "fleet_rollout", type: "fleet_rollout_failed", name: "Fleet rollout failed", enabled: true, params: {}, forMinutes: 0, since: 1 }),
  rule({ key: "fleet_drift", type: "fleet_drift", name: "Fleet instance drifted", enabled: true, params: {}, forMinutes: 0, since: 1 }),
  // Off: on a host open to the internet the WAF blocks scans all day; turn it on with a threshold that fits.
  rule({ key: "waf_spike", type: "waf_spike", name: "WAF block spike", enabled: false, params: DEFAULT_RULE_PARAMS.waf_spike, forMinutes: 0, since: 1 }),
];

const store = globalThis as typeof globalThis & { __ingressiBuiltInRules?: { done: boolean } };
const state = (store.__ingressiBuiltInRules ??= { done: false });

/** Adds the built-in rules this install does not have yet; returns how many were added. */
export async function ensureBuiltInAlertRules(): Promise<number> {
  const stored = await getSetting<number>(VERSION_SETTING);
  const from = typeof stored === "number" && Number.isSafeInteger(stored) ? stored : 0;
  if (from >= BUILT_IN_RULES_VERSION) return 0;
  const rows = await appDb.select({ type: alertRules.type, builtIn: alertRules.builtIn }).from(alertRules);
  const keys = new Set(rows.map((row) => row.builtIn).filter((key): key is string => key !== null));
  const types = new Set(rows.map((row) => row.type));
  const now = nowIso();
  let added = 0;
  for (const definition of BUILT_IN_RULES) {
    if (definition.since <= from || keys.has(definition.key) || types.has(definition.type)) continue;
    const inserted = await appDb
      .insert(alertRules)
      .values({
        builtIn: definition.key,
        name: definition.name,
        type: definition.type,
        enabled: definition.enabled,
        params: JSON.stringify(definition.params),
        channelIds: "[]",
        cooldownMinutes: 60,
        notifyOnResolve: true,
        explain: false,
        scope: '{"type":"all"}',
        forMinutes: definition.forMinutes,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: alertRules.builtIn })
      .returning({ id: alertRules.id });
    added += inserted.length;
  }
  await setSetting(VERSION_SETTING, BUILT_IN_RULES_VERSION);
  return added;
}

/** ensureBuiltInAlertRules() once per process; a failure is retried on the next call. */
export async function ensureBuiltInAlertRulesOnce(): Promise<void> {
  if (state.done) return;
  await ensureBuiltInAlertRules();
  state.done = true;
}

/** Forgets that the built-in rules were checked (tests). */
export function resetBuiltInAlertRulesCheck(): void {
  state.done = false;
}
