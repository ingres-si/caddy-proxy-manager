import { NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { getUserPreferences, parsePreferencesInput, updateUserPreferences } from "@/src/lib/preferences";

const NO_STORE = { "Cache-Control": "no-store" };

/** The caller's interface preferences: theme, time zone, number format and list ordering. A token with scopes is refused. */
export async function GET(request: NextRequest) {
  try {
    const { userId } = await requireApiUser(request);
    return NextResponse.json(await getUserPreferences(userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Changes any interface preference; fields left out keep their values. */
export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiUser(request);
    const body = await request.json().catch(() => {
      throw new ApiValidationError("Request body must be a JSON object");
    });
    return NextResponse.json(await updateUserPreferences(userId, parsePreferencesInput(body)), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
