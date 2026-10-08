import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { applyCaddyConfig } from "@/src/lib/caddy";
import { createWafExclusions, type WafExclusionInput } from "@/src/lib/models/waf-exclusions";
import { onlyFields, readJsonObject, WAF_NO_STORE, wafErrorResponse } from "@/src/lib/waf-api";

/**
 * Adds several exclusions (such as the suggested ones of a WAF event) with one
 * apply: all of them or none.
 */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "waf:write");
    const body = await readJsonObject(request);
    onlyFields(body, ["exclusions"]);
    if (!Array.isArray(body.exclusions)) throw new ApiValidationError("exclusions must be an array");
    const inputs = body.exclusions.map((entry: unknown, index: number) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ApiValidationError(`exclusions[${index}] must be an object`);
      onlyFields(entry as Record<string, unknown>, ["ruleId", "proxyHostId", "path", "pathMatch", "variable", "reason"]);
      return entry as WafExclusionInput;
    });
    const exclusions = await createWafExclusions(inputs, userId, { apply: applyCaddyConfig });
    return NextResponse.json({ exclusions }, { status: 201, headers: WAF_NO_STORE });
  } catch (error) {
    return wafErrorResponse(error);
  }
}
