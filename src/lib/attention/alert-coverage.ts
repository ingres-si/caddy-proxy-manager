/**
 * What the alert rules (ee/alerting) already cover, for the attention
 * registry: the rule types an enabled rule watches for every host (providers
 * superseded by them are left out), and whether any enabled rule notifies an
 * enabled channel.
 */
import { eq } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { alertChannels, alertRules } from "@/src/lib/db/schema";

export type AlertCoverage = { types: ReadonlySet<string>; notifying: boolean };

function parseIds(value: string): number[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isSafeInteger(id)) : [];
  } catch {
    return [];
  }
}

function watchesEveryHost(scope: string): boolean {
  try {
    const parsed = JSON.parse(scope) as { type?: unknown } | null;
    return parsed?.type !== "hosts";
  } catch {
    return true;
  }
}

export async function loadAlertCoverage(): Promise<AlertCoverage> {
  const [rules, channels] = await Promise.all([
    appDb
      .select({ type: alertRules.type, scope: alertRules.scope, channelIds: alertRules.channelIds })
      .from(alertRules)
      .where(eq(alertRules.enabled, true)),
    appDb.select({ id: alertChannels.id }).from(alertChannels).where(eq(alertChannels.enabled, true)),
  ]);
  const enabledChannels = new Set(channels.map((channel) => channel.id));
  return {
    types: new Set(rules.filter((rule) => watchesEveryHost(rule.scope)).map((rule) => rule.type)),
    notifying: rules.some((rule) => parseIds(rule.channelIds).some((id) => enabledChannels.has(id))),
  };
}
