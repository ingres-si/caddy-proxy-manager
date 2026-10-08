import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, getApiAccess, requireApiUser } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { listAttentionProviders } from "@/src/lib/attention";
import { mayRead } from "@/src/lib/attention/registry";
import {
  dismissAttentionItem,
  listAttentionDismissals,
  parseDismissalInput,
  requireKey,
  restoreAttentionItems,
} from "@/src/lib/attention/dismissals";

const NO_STORE = { "Cache-Control": "no-store" };

/** The caller's own dismissals in effect. Any signed-in user. */
export async function GET(request: NextRequest) {
  try {
    const { userId } = await requireApiUser(request);
    return NextResponse.json({ dismissals: await listAttentionDismissals(userId) }, { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** {source, id}: hides that item from the caller's own list (only items the caller is shown, of providers that allow it). */
export async function POST(request: NextRequest) {
  try {
    const access = await getApiAccess(await requireApiUser(request));
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiValidationError("Request body must be JSON");
    }
    const providers = listAttentionProviders().filter((provider) => mayRead(provider, access));
    return NextResponse.json(await dismissAttentionItem(access, parseDismissalInput(body), providers), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** ?source=&id=: lists that item again; with neither, every item the caller dismissed. */
export async function DELETE(request: NextRequest) {
  try {
    const { userId } = await requireApiUser(request);
    const params = request.nextUrl.searchParams;
    const source = params.get("source");
    const id = params.get("id");
    if ((source === null) !== (id === null)) throw new ApiValidationError("Give both source and id, or neither");
    const item = source !== null && id !== null ? { source: requireKey(source, "source"), id: requireKey(id, "id") } : undefined;
    return NextResponse.json({ restored: await restoreAttentionItems(userId, item) }, { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
