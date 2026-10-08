// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { testAlertChannelDraft } from "@/ee/alerting/test-channel";
import { readJsonBody } from "@/ee/alerting/http";

/** Sends a test notification to a channel that is not saved yet (body: as for POST /api/v1/alert-channels). */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "alerts:write");
    return NextResponse.json(await testAlertChannelDraft(null, await readJsonBody(request), userId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
