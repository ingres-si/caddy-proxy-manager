"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/src/lib/auth";
import { applyCaddyConfig } from "@/src/lib/caddy";
import { ApiClientError } from "@/src/lib/api-errors";
import { getSetting, getWafSettings, saveWafSettings, clearSetting, setSetting, type WafSettings } from "@/src/lib/settings";
import { SettingsValidationError, validateSettingsGroup } from "@/src/lib/settings-validation";
import { withSettingsUpdateLock } from "@/src/lib/settings-update-lock";
import { logAuditEvent } from "@/src/lib/audit";
import { createWafExclusion, createWafExclusions, deleteWafExclusion, WafApplyError, type WafExclusion } from "@/src/lib/models/waf-exclusions";
import { readGlobalWafExclusionRows, restoreGlobalWafExclusionRows } from "@/src/lib/models/waf-exclusion-mirror";
import { setWafHostMode, type WafHostView } from "@/src/lib/waf-hosts";
import { isWafHostMode, type WafHostMode } from "@/src/lib/waf-host-mode";
import { explainWafEvent, type WafEventExplanation } from "@/src/lib/waf-event-explain";
import { WafExplainError } from "@/src/lib/waf-explain";
import { WAF_TUNING_KEYS } from "@/src/lib/waf-tuning";

export type WafActionResult<T = undefined> = { ok: true; value: T; message?: string } | { ok: false; error: string };

function failure(error: unknown, fallback: string): { ok: false; error: string } {
  if (error instanceof ApiClientError || error instanceof SettingsValidationError || error instanceof WafApplyError || error instanceof WafExplainError) {
    return { ok: false, error: error.message };
  }
  if (error instanceof Error && /not found$/i.test(error.message.trim())) return { ok: false, error: error.message };
  console.error(fallback, error);
  return { ok: false, error: fallback };
}

function revalidateWaf() {
  revalidatePath("/waf");
  revalidatePath("/security");
  revalidatePath("/proxy-hosts");
}

/** The global WAF settings as the settings page edits them (everything but the excluded rule list). */
export type WafSettingsInput = Omit<WafSettings, "excluded_rule_ids">;

const INPUT_KEYS = [
  "enabled",
  "mode",
  "load_owasp_crs",
  "custom_directives",
  "request_body_limit",
  "request_body_in_memory_limit",
  "request_body_limit_action",
  ...WAF_TUNING_KEYS,
] as const;

/**
 * Saves the global WAF settings and applies them. Validated like
 * PUT /api/v1/settings/waf; when Caddy refuses the configuration the
 * previous settings are put back. Rule exclusions are not touched.
 */
export async function saveWafSettingsAction(input: WafSettingsInput): Promise<WafActionResult<{ savedAt: string }>> {
  const session = await requirePermission("waf:write");
  const userId = Number(session.user.id);
  try {
    // Only known keys, and undefined ones left out, as the API takes them.
    const value: Record<string, unknown> = {};
    for (const key of INPUT_KEYS) {
      const field = (input as Record<string, unknown>)[key];
      if (field !== undefined && field !== null) value[key] = field;
    }
    return await withSettingsUpdateLock(async () => {
      const validated = validateSettingsGroup("waf", value, { previousWaf: await getWafSettings() }) as WafSettings;
      const previousValue = await getSetting<unknown>("waf");
      const previousExclusions = await readGlobalWafExclusionRows();
      await saveWafSettings(validated, { actorUserId: userId });
      try {
        await applyCaddyConfig();
      } catch (error) {
        if (previousValue === null) await clearSetting("waf");
        else await setSetting("waf", previousValue);
        await restoreGlobalWafExclusionRows(previousExclusions);
        await applyCaddyConfig().catch(() => undefined);
        console.error("WAF settings were not applied:", error);
        return { ok: false as const, error: "Caddy did not accept the new configuration, so the previous WAF settings were put back." };
      }
      await logAuditEvent({ userId, action: "update", entityType: "waf_settings", summary: "Updated the global WAF settings", data: validated });
      revalidateWaf();
      return { ok: true as const, value: { savedAt: new Date().toISOString() }, message: "WAF settings saved and applied." };
    });
  } catch (error) {
    return failure(error, "Could not save the WAF settings.");
  }
}

export async function setWafHostModeAction(hostId: number, mode: WafHostMode): Promise<WafActionResult<WafHostView>> {
  const session = await requirePermission("waf:write");
  try {
    if (!Number.isSafeInteger(hostId) || hostId < 1) return { ok: false, error: "Unknown proxy host." };
    if (!isWafHostMode(mode)) return { ok: false, error: "Unknown WAF mode." };
    const view = await setWafHostMode(hostId, mode, Number(session.user.id));
    revalidateWaf();
    return { ok: true, value: view };
  } catch (error) {
    return failure(error, "Could not change the host's WAF mode.");
  }
}

export type WafExclusionActionInput = {
  ruleId: number;
  proxyHostId: number | null;
  path?: string | null;
  pathMatch?: "exact" | "prefix" | null;
  variable?: string | null;
  reason?: string;
};

export async function createWafExclusionAction(input: WafExclusionActionInput): Promise<WafActionResult<WafExclusion>> {
  const session = await requirePermission("waf:write");
  try {
    const exclusion = await createWafExclusion(
      {
        ruleId: input.ruleId,
        proxyHostId: input.proxyHostId,
        path: input.path || null,
        pathMatch: input.path ? input.pathMatch ?? undefined : undefined,
        variable: input.variable || null,
        reason: input.reason ?? "",
      },
      Number(session.user.id),
      { apply: applyCaddyConfig }
    );
    revalidateWaf();
    return { ok: true, value: exclusion, message: `Rule ${exclusion.ruleId} excluded.` };
  } catch (error) {
    return failure(error, "Could not add the exclusion.");
  }
}

/** Adds several exclusions with one apply (the suggestions of a WAF event): all or none. */
export async function createWafExclusionsAction(inputs: WafExclusionActionInput[]): Promise<WafActionResult<WafExclusion[]>> {
  const session = await requirePermission("waf:write");
  try {
    const exclusions = await createWafExclusions(
      inputs.map((input) => ({
        ruleId: input.ruleId,
        proxyHostId: input.proxyHostId,
        path: input.path || null,
        pathMatch: input.path ? input.pathMatch ?? undefined : undefined,
        variable: input.variable || null,
        reason: input.reason ?? "",
      })),
      Number(session.user.id),
      { apply: applyCaddyConfig }
    );
    revalidateWaf();
    return {
      ok: true,
      value: exclusions,
      message: exclusions.length === 1 ? `Rule ${exclusions[0].ruleId} excluded.` : `${exclusions.length} rules excluded.`,
    };
  } catch (error) {
    return failure(error, "Could not add the exclusions.");
  }
}

export async function deleteWafExclusionAction(id: number): Promise<WafActionResult> {
  const session = await requirePermission("waf:write");
  try {
    await deleteWafExclusion(id, Number(session.user.id), { apply: applyCaddyConfig });
    revalidateWaf();
    return { ok: true, value: undefined, message: "Exclusion removed." };
  } catch (error) {
    return failure(error, "Could not remove the exclusion.");
  }
}

export async function explainWafEventAction(eventId: string): Promise<WafActionResult<WafEventExplanation>> {
  await requirePermission("waf:read");
  try {
    const explanation = await explainWafEvent(eventId);
    if (!explanation) return { ok: false, error: "This event is no longer stored." };
    return { ok: true, value: explanation };
  } catch (error) {
    return failure(error, "Could not read this event's audit record.");
  }
}
