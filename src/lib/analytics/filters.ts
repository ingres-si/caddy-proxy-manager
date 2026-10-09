/**
 * Analytics filters: `[{ dim, op, value }]` with op "is", "is_not",
 * "contains" or "not_contains". The dimension comes from the allow-list in
 * dimensions.ts and picks a constant SQL expression; the value is validated
 * for its dimension and bound as a query parameter, never written into the
 * SQL. "contains" matches part of the text, ignoring case, on the searchable
 * dimensions (host, path, user agent, source IP).
 *
 * Several "is" and "contains" filters on one dimension match any of them;
 * "is_not" and "not_contains" filters exclude each; filters on different
 * dimensions all apply.
 */
import { ApiValidationError } from '../api-errors';
import { DIMENSION_SPECS, isDimension, MAX_CONTAINS_LENGTH, SEARCHABLE_SQL, type Dimension } from './dimensions';

export const FILTER_OPS = ['is', 'is_not', 'contains', 'not_contains'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export type AnalyticsFilter = { dim: Dimension; op: FilterOp; value: string };

export const MAX_FILTERS = 20;

/** A WHERE fragment and the parameters it binds. */
export type SqlFragment = { sql: string; params: Record<string, unknown> };

function parseOp(value: unknown): FilterOp {
  if (value === undefined || value === null || value === 'is') return 'is';
  if (value === 'is_not' || value === 'is not' || value === 'not') return 'is_not';
  if (value === 'contains') return 'contains';
  if (value === 'not_contains' || value === 'does not contain' || value === 'does_not_contain') return 'not_contains';
  throw new ApiValidationError('Filter op must be "is", "is_not", "contains" or "not_contains"');
}

/** True for the ops that match part of the text. */
export function isContainsOp(op: FilterOp): op is 'contains' | 'not_contains' {
  return op === 'contains' || op === 'not_contains';
}

/**
 * Validates filters given as an array or as its JSON text (a query string
 * parameter). Throws ApiValidationError for anything off the allow-list.
 */
export function parseFilters(input: unknown): AnalyticsFilter[] {
  if (input === undefined || input === null || input === '') return [];
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new ApiValidationError('filters must be a JSON array');
    }
  }
  if (!Array.isArray(raw)) throw new ApiValidationError('filters must be an array');
  if (raw.length > MAX_FILTERS) throw new ApiValidationError(`At most ${MAX_FILTERS} filters`);
  const seen = new Set<string>();
  const filters: AnalyticsFilter[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ApiValidationError('Each filter must be an object');
    const { dim, op, value } = item as Record<string, unknown>;
    if (!isDimension(dim)) throw new ApiValidationError(`Unknown filter dimension: ${String(dim).slice(0, 40)}`);
    if (typeof value !== 'string' && typeof value !== 'number') throw new ApiValidationError('Filter value must be a string');
    const text = String(value);
    if (text.length === 0) throw new ApiValidationError('Filter value must not be empty');
    const filter: AnalyticsFilter = { dim, op: parseOp(op), value: text };
    if (isContainsOp(filter.op)) {
      if (SEARCHABLE_SQL[dim] === undefined) throw new ApiValidationError(`${DIMENSION_SPECS[dim].label} cannot be matched by part of its text`);
      if (text.length > MAX_CONTAINS_LENGTH) throw new ApiValidationError(`A "contains" value is at most ${MAX_CONTAINS_LENGTH} characters`);
    } else {
      // Validates the value now, so a bad filter is a 400 before any query runs.
      DIMENSION_SPECS[dim].compare(text);
    }
    const key = `${filter.dim}\u0000${filter.op}\u0000${filter.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    filters.push(filter);
  }
  return filters;
}

/**
 * The WHERE fragment of `filters` (or "1" when there are none). Parameter
 * names are `${prefix}0`, `${prefix}1`, ...
 */
export function buildFilterSql(filters: readonly AnalyticsFilter[], prefix = 'f'): SqlFragment {
  const params: Record<string, unknown> = {};
  const include = new Map<Dimension, string[]>();
  const exclude: string[] = [];
  filters.forEach((filter, index) => {
    const name = `${prefix}${index}`;
    const condition = filterCondition(filter, name, params);
    if (filter.op === 'is' || filter.op === 'contains') {
      const list = include.get(filter.dim) ?? [];
      list.push(condition);
      include.set(filter.dim, list);
    } else {
      exclude.push(`NOT (${condition})`);
    }
  });
  const clauses = [...[...include.values()].map((list) => `(${list.join(' OR ')})`), ...exclude];
  return { sql: clauses.length > 0 ? clauses.join(' AND ') : '1', params };
}

/**
 * The condition one filter matches, without its negation: equality for
 * "is"/"is_not", a case-insensitive substring for "contains"/"not_contains".
 * Binds its value as `name` in `params`.
 */
export function filterCondition(filter: AnalyticsFilter, name: string, params: Record<string, unknown>, column?: string): string {
  if (isContainsOp(filter.op)) {
    params[name] = filter.value;
    return `positionCaseInsensitiveUTF8(${column ?? SEARCHABLE_SQL[filter.dim]}, {${name}:String}) > 0`;
  }
  const { sql, type, value } = DIMENSION_SPECS[filter.dim].compare(filter.value);
  params[name] = value;
  return `(${sql}) = {${name}:${type}}`;
}
