import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { analyticsParams } from "@/src/lib/analytics/http";
import { parseFilters } from "@/src/lib/analytics/filters";
import { resolveRange } from "@/src/lib/analytics/range";
import { parseValueLimit, parseValueQuery, searchDimensionValues } from "@/src/lib/analytics/values";

/** Values of the searchable dimensions containing `q`, most requested first, within the range and filters. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "analytics:read");
    const params = analyticsParams(request.nextUrl.searchParams);
    return NextResponse.json(
      await searchDimensionValues({
        range: resolveRange(params),
        filters: parseFilters(params.filters),
        query: parseValueQuery(request.nextUrl.searchParams.get("q")),
        limit: parseValueLimit(params.limit),
      })
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
