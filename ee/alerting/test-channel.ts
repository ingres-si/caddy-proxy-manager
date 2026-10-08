// SPDX-License-Identifier: Elastic-2.0
import { logAuditEvent } from "@/src/lib/audit";
import { ChannelSecretsUnavailableError, draftChannelRow, getChannelRowForTest, recordChannelDelivery, resolveChannel } from "./channels";
import { deliverToChannel, type DeliveryResult } from "./deliver";
import { testNotification } from "./format";
import { CHANNEL_TYPE_LABELS, isChannelType } from "./types";

/** Sends a test notification. */
export async function testAlertChannel(id: number, actorUserId: number): Promise<DeliveryResult> {
  const row = await getChannelRowForTest(id);
  let result: DeliveryResult;
  try {
    result = await deliverToChannel(resolveChannel(row), testNotification());
  } catch (error) {
    result = {
      ok: false,
      error: error instanceof ChannelSecretsUnavailableError ? error.message : "The test notification could not be sent",
    };
  }
  await recordChannelDelivery(row.id, result.error);
  await logAuditEvent({
    userId: actorUserId,
    action: "alert_channel_tested",
    entityType: "alert_channel",
    entityId: row.id,
    summary: `Sent a test notification to ${isChannelType(row.type) ? CHANNEL_TYPE_LABELS[row.type] : row.type} alert channel "${row.name}": ${result.ok ? "delivered" : "failed"}`,
    data: { ok: result.ok },
  });
  return result;
}

/**
 * Sends a test notification to a channel as it would be saved from `body`
 * (a new channel when `id` is null, otherwise the changes to channel `id`),
 * without saving it; a stored channel's last delivery is not changed.
 */
export async function testAlertChannelDraft(id: number | null, body: unknown, actorUserId: number): Promise<DeliveryResult> {
  const row = await draftChannelRow(id, body);
  let result: DeliveryResult;
  try {
    result = await deliverToChannel(resolveChannel(row), testNotification());
  } catch (error) {
    result = {
      ok: false,
      error: error instanceof ChannelSecretsUnavailableError ? error.message : "The test notification could not be sent",
    };
  }
  const label = isChannelType(row.type) ? CHANNEL_TYPE_LABELS[row.type] : row.type;
  await logAuditEvent({
    userId: actorUserId,
    action: "alert_channel_tested",
    entityType: "alert_channel",
    entityId: id,
    summary: `Sent a test notification to ${id === null ? `an unsaved ${label} alert channel` : `${label} alert channel "${row.name}" with unsaved changes`}: ${result.ok ? "delivered" : "failed"}`,
    data: { ok: result.ok, draft: true },
  });
  return result;
}
