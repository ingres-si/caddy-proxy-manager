// SPDX-License-Identifier: Elastic-2.0
"use server";

import { revalidatePath } from "next/cache";
import { requirePermission, type PermissionSession } from "@/src/lib/auth";
import { ApiClientError } from "@/src/lib/api-errors";
import { createAlertChannel, deleteAlertChannel, updateAlertChannel } from "@/ee/alerting/channels";
import { createAlertRule, deleteAlertRule, updateAlertRule } from "@/ee/alerting/rules";
import { createAlertSilence, deleteAlertSilence } from "@/ee/alerting/silences";
import { testAlertChannel, testAlertChannelDraft } from "@/ee/alerting/test-channel";
import { clearAiSettings, saveAiSettings } from "@/ee/ai/settings";
import { testAiProvider } from "@/ee/ai/explain";
import { saveQuestionSettings } from "@/ee/ai/questions/settings";

export type AlertActionResult = { ok: true; message?: string } | { ok: false; error: string };

/**
 * Runs an admin action for a session that passed its permission check (each
 * action checks its own: alerts:write or ai:write). Client-safe errors come
 * back as { ok: false }.
 */
async function run(
  session: PermissionSession,
  operation: (userId: number) => Promise<string | void>
): Promise<AlertActionResult> {
  try {
    const message = await operation(Number(session.user.id));
    revalidatePath("/alerts");
    return message ? { ok: true, message } : { ok: true };
  } catch (error) {
    if (error instanceof ApiClientError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function saveAlertChannelAction(id: number | null, input: unknown): Promise<AlertActionResult> {
  return run(await requirePermission("alerts:write"), async (userId) => {
    if (id === null) await createAlertChannel(input, userId);
    else await updateAlertChannel(id, input, userId);
  });
}

export async function setAlertChannelEnabledAction(id: number, enabled: boolean): Promise<AlertActionResult> {
  return run(await requirePermission("alerts:write"), async (userId) => {
    await updateAlertChannel(id, { enabled }, userId);
  });
}

export async function deleteAlertChannelAction(id: number): Promise<AlertActionResult> {
  return run(await requirePermission("alerts:write"), (userId) => deleteAlertChannel(id, userId));
}

/** Sends a test notification to the channel being added or edited, without saving it. */
export async function testAlertChannelDraftAction(id: number | null, input: unknown): Promise<AlertActionResult> {
  const session = await requirePermission("alerts:write");
  try {
    const result = await testAlertChannelDraft(id, input, Number(session.user.id));
    return result.ok ? { ok: true, message: "Test notification sent" } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ApiClientError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function testAlertChannelAction(id: number): Promise<AlertActionResult> {
  const session = await requirePermission("alerts:write");
  try {
    const result = await testAlertChannel(id, Number(session.user.id));
    revalidatePath("/alerts");
    return result.ok ? { ok: true, message: "Test notification sent" } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ApiClientError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function saveAlertRuleAction(id: number | null, input: unknown): Promise<AlertActionResult> {
  return run(await requirePermission("alerts:write"), async (userId) => {
    if (id === null) await createAlertRule(input, userId);
    else await updateAlertRule(id, input, userId);
  });
}

export async function setAlertRuleEnabledAction(id: number, enabled: boolean): Promise<AlertActionResult> {
  return run(await requirePermission("alerts:write"), async (userId) => {
    await updateAlertRule(id, { enabled }, userId);
  });
}

export async function deleteAlertRuleAction(id: number): Promise<AlertActionResult> {
  return run(await requirePermission("alerts:write"), (userId) => deleteAlertRule(id, userId));
}

/** Dismisses an alert or mutes a rule ({ ruleId, subjectKey?, durationMinutes?, note? }). */
export async function silenceAlertAction(input: unknown): Promise<AlertActionResult> {
  return run(await requirePermission("alerts:write"), async (userId) => {
    await createAlertSilence(input, userId);
  });
}

/** Undoes a dismissal or mute. */
export async function endAlertSilenceAction(id: number): Promise<AlertActionResult> {
  return run(await requirePermission("alerts:write"), (userId) => deleteAlertSilence(id, userId));
}

export async function saveAiSettingsAction(input: unknown): Promise<AlertActionResult> {
  return run(await requirePermission("ai:write"), async (userId) => {
    await saveAiSettings(input, userId);
  });
}

/** Removes the provider and its key. */
export async function removeAiSettingsAction(): Promise<AlertActionResult> {
  return run(await requirePermission("ai:write"), async (userId) => {
    await clearAiSettings(userId);
  });
}

export async function testAiProviderAction(): Promise<AlertActionResult> {
  const session = await requirePermission("ai:write");
  try {
    const result = await testAiProvider(Number(session.user.id));
    return result.ok ? { ok: true, message: result.explanation ?? "" } : { ok: false, error: result.error ?? "The model call failed" };
  } catch (error) {
    if (error instanceof ApiClientError) return { ok: false, error: error.message };
    throw error;
  }
}

/** Analytics question settings. */
export async function saveQuestionSettingsAction(input: unknown): Promise<AlertActionResult> {
  return run(await requirePermission("ai:write"), async (userId) => {
    await saveQuestionSettings(input, userId);
  });
}
