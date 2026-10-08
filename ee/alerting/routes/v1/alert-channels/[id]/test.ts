// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { testAlertChannel, testAlertChannelDraft } from "@/ee/alerting/test-channel";
import { readJsonBody } from "@/ee/alerting/http";
import { parseId } from "@/ee/alerting/validation";

type Params = { params: Promise<{ id: string }> };

/**
 * Sends a test notification to the channel. Without a body it is the stored
 * channel; with one (name and config fields, as for PATCH) it is the channel
 * with those changes, which are not saved.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiPermission(request, "alerts:write");
    const id = parseId((await params).id);
    const hasBody = (request.headers.get("content-length") ?? "0") !== "0" || request.headers.get("transfer-encoding") !== null;
    const result = hasBody ? await testAlertChannelDraft(id, await readJsonBody(request), userId) : await testAlertChannel(id, userId);
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
