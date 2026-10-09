/**
 * Searching the values of the analytics dimensions: what the filter box on
 * the Analytics page offers while typing. For each searchable dimension
 * (host, path, user agent, source IP) the values containing the text, most
 * requested first, within the range and the filters already applied.
 */
import { ApiValidationError } from '../api-errors';
import { DIMENSION_SPECS, MAX_CONTAINS_LENGTH, SEARCHABLE_SQL, type Dimension } from './dimensions';
import { buildFilterSql, type AnalyticsFilter } from './filters';
import type { ResolvedRange } from './range';
import { num, selectRows, withAnalytics, type AnalyticsStatus, type QueryParams } from './run';
import { scopeSql, type HostScope } from './scope';

export const SEARCH_DIMENSIONS = ['host', 'path', 'ip', 'user_agent'] as const satisfies readonly Dimension[];
export const MAX_VALUE_RESULTS = 8;

export type ValueMatch = { value: string; count: number };
export type DimensionMatches = { dimension: Dimension; label: string; values: ValueMatch[] };
export type ValueSearchResult = { status: AnalyticsStatus; query: string; dimensions: DimensionMatches[] };

/** The search text: trimmed, 1 to MAX_CONTAINS_LENGTH characters. */
export function parseValueQuery(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new ApiValidationError('q is required');
  if (text.length > MAX_CONTAINS_LENGTH) throw new ApiValidationError(`q is at most ${MAX_CONTAINS_LENGTH} characters`);
  return text;
}

export function parseValueLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return 5;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_VALUE_RESULTS) throw new ApiValidationError(`limit must be from 1 to ${MAX_VALUE_RESULTS}`);
  return limit;
}

export async function searchDimensionValues(
  input: { range: ResolvedRange; filters: AnalyticsFilter[]; query: string; limit: number },
  scope: HostScope = null
): Promise<ValueSearchResult> {
  const empty = {
    query: input.query,
    dimensions: SEARCH_DIMENSIONS.map((dimension) => ({ dimension, label: DIMENSION_SPECS[dimension].label, values: [] as ValueMatch[] })),
  };
  return withAnalytics('value search', empty, async () => {
    const scoped = scopeSql(scope);
    const filtered = buildFilterSql(input.filters);
    const params: QueryParams = {
      ...scoped.params,
      ...filtered.params,
      p_from: input.range.start,
      p_to: input.range.end,
      p_q: input.query,
      p_limit: input.limit,
    };
    const where = `ts >= toDateTime({p_from:UInt32}) AND ts < toDateTime({p_to:UInt32}) AND ${scoped.sql} AND ${filtered.sql}`;
    const dimensions = await Promise.all(
      SEARCH_DIMENSIONS.map(async (dimension): Promise<DimensionMatches> => {
        const column = SEARCHABLE_SQL[dimension]!;
        const rows = await selectRows<{ value: unknown; c: unknown }>(
          `SELECT ${column} AS value, count() AS c FROM traffic_events
           WHERE ${where} AND positionCaseInsensitiveUTF8(${column}, {p_q:String}) > 0
           GROUP BY value ORDER BY c DESC, value LIMIT {p_limit:UInt32}`,
          params
        );
        return {
          dimension,
          label: DIMENSION_SPECS[dimension].label,
          values: rows.map((row) => ({ value: String(row.value ?? ''), count: num(row.c) })).filter((row) => row.value !== ''),
        };
      })
    );
    return { query: input.query, dimensions };
  });
}
