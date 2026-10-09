/**
 * The dimensions, metrics and groupings the analytics query layer accepts,
 * as fixed allow-lists. Every SQL fragment here is a constant written in
 * this file: callers pick fragments by name, and values only ever reach
 * ClickHouse as bound parameters (filters.ts).
 */
import { isIP } from 'node:net';
import { ApiValidationError } from '../api-errors';
import { OUTCOMES, isOutcome } from './outcome';

// ── SQL expressions over traffic_events ─────────────────────────────────

/**
 * Outcome of a row. Rows ingested before the outcome column existed have an
 * empty outcome: they count as rate_limit or geo from the flags the parser
 * set then, and as served otherwise.
 */
export const OUTCOME_SQL =
  "if(outcome != '', toString(outcome), multiIf(is_rate_limited, 'rate_limit', is_blocked, 'geo', 'served'))";

/** True for a mitigated row (any outcome but served). */
export const MITIGATED_SQL = `(${OUTCOME_SQL}) != 'served'`;

/** The request path: the URI without its query string. */
export const PATH_SQL = "splitByChar('?', uri)[1]";

/** Same, for waf_events (whose URI already has credentials redacted). */
export const WAF_PATH_SQL = PATH_SQL;

/**
 * Private, loopback, link-local and shared (CGNAT) addresses: GeoIP has no
 * country for them, the analytics call them "LAN".
 */
const PRIVATE_IP_PATTERN =
  '^(10[.]|127[.]|192[.]168[.]|172[.](1[6-9]|2[0-9]|3[01])[.]|169[.]254[.]|100[.](6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])[.]|::1$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)';

/** Country code of a row: the GeoIP country, "LAN" for private addresses, "XX" when unknown. */
export const COUNTRY_SQL = `multiIf(coalesce(country_code, '') != '', coalesce(country_code, ''), match(client_ip, '${PRIVATE_IP_PATTERN}'), 'LAN', 'XX')`;

/** Same, for waf_events. */
export const WAF_COUNTRY_SQL = COUNTRY_SQL;

/** User-agent family; rows ingested before it existed fall back to the start of the header. */
export const UA_SQL = "if(ua_family != '', toString(ua_family), if(user_agent = '', '(none)', substring(user_agent, 1, 64)))";

/** Status class label. */
export const STATUS_CLASS_SQL = "multiIf(status >= 500, '5xx', status >= 400, '4xx', status >= 300, '3xx', status >= 200, '2xx', 'other')";

/** The stored Host as a bare lowercase name: no port, no trailing dot. */
export const HOST_NAME_SQL = "replaceRegexpOne(lower(host), '[.]?(:[0-9]{1,5})?$', '')";

// ── Dimensions ───────────────────────────────────────────────────────────

export const DIMENSIONS = [
  'host',
  'path',
  'country',
  'asn',
  'status',
  'method',
  'protocol',
  'ip',
  'user_agent',
  'outcome',
  'waf_rule',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export function isDimension(value: unknown): value is Dimension {
  return typeof value === 'string' && (DIMENSIONS as readonly string[]).includes(value);
}

type DimensionSpec = {
  label: string;
  /** SQL grouping expression (top lists); its value is returned as a string. */
  groupSql: string;
  /**
   * Turns a filter value into the SQL expression to compare, the ClickHouse
   * type of its bound parameter and the value to bind, or throws
   * ApiValidationError.
   */
  compare: (value: string) => { sql: string; type: string; value: string | number };
};

const MAX_TEXT_VALUE = 512;

function text(column: string, max = MAX_TEXT_VALUE) {
  return (value: string) => {
    if (value.length > max) throw new ApiValidationError(`Filter value is longer than ${max} characters`);
    return { sql: column, type: 'String', value };
  };
}

export const DIMENSION_SPECS: Record<Dimension, DimensionSpec> = {
  host: { label: 'Host', groupSql: 'host', compare: text('host', 255) },
  path: { label: 'Path', groupSql: PATH_SQL, compare: text(PATH_SQL) },
  country: {
    label: 'Country',
    groupSql: COUNTRY_SQL,
    compare: (value) => {
      const code = value.toUpperCase();
      if (!/^([A-Z]{2}|LAN)$/.test(code)) throw new ApiValidationError('Country must be a two-letter code, LAN or XX');
      return { sql: COUNTRY_SQL, type: 'String', value: code };
    },
  },
  asn: {
    label: 'Network (ASN)',
    groupSql: 'toString(asn)',
    compare: (value) => {
      const match = /^(?:AS)?(\d{1,10})$/i.exec(value.trim());
      const number = match ? Number(match[1]) : NaN;
      if (!Number.isInteger(number) || number < 0 || number > 0xffffffff) {
        throw new ApiValidationError('ASN must be a number such as 13335 or AS13335');
      }
      return { sql: 'asn', type: 'UInt32', value: number };
    },
  },
  status: {
    label: 'Status',
    groupSql: 'toString(status)',
    compare: (value) => {
      const v = value.trim().toLowerCase();
      if (/^[1-5]xx$/.test(v)) return { sql: 'intDiv(status, 100)', type: 'UInt16', value: Number(v[0]) };
      if (/^\d{1,3}$/.test(v) && Number(v) <= 999) return { sql: 'status', type: 'UInt16', value: Number(v) };
      throw new ApiValidationError('Status must be a code such as 404 or a class such as 5xx');
    },
  },
  method: {
    label: 'Method',
    groupSql: 'method',
    compare: (value) => {
      if (!/^[A-Za-z0-9_.!#$%&'*+^`|~-]{1,32}$/.test(value)) throw new ApiValidationError('Method must be an HTTP method token');
      return { sql: 'method', type: 'String', value: value.toUpperCase() };
    },
  },
  protocol: {
    label: 'HTTP version',
    groupSql: 'proto',
    compare: (value) => {
      if (!/^[A-Za-z0-9./-]{1,16}$/.test(value)) throw new ApiValidationError('Protocol must look like HTTP/2.0');
      return { sql: 'proto', type: 'String', value };
    },
  },
  ip: {
    label: 'Source IP',
    groupSql: 'client_ip',
    compare: (value) => {
      const v = value.trim();
      if (isIP(v) === 0) throw new ApiValidationError('Source IP must be an IPv4 or IPv6 address');
      return { sql: 'client_ip', type: 'String', value: v };
    },
  },
  user_agent: { label: 'User agent', groupSql: UA_SQL, compare: text(UA_SQL, 256) },
  outcome: {
    label: 'Outcome',
    groupSql: OUTCOME_SQL,
    compare: (value) => {
      if (!isOutcome(value)) throw new ApiValidationError(`Outcome must be one of ${OUTCOMES.join(', ')}`);
      return { sql: OUTCOME_SQL, type: 'String', value };
    },
  },
  waf_rule: {
    label: 'WAF rule',
    groupSql: 'toString(waf_rule_id)',
    compare: (value) => {
      if (!/^\d{1,10}$/.test(value.trim()) || Number(value) > 0xffffffff) throw new ApiValidationError('WAF rule must be a rule id');
      return { sql: 'waf_rule_id', type: 'UInt32', value: Number(value) };
    },
  },
};

/**
 * Dimensions a filter can match by part of their text ("contains"), and the
 * text each one searches: the host name, the path, the user agent family and
 * the client address.
 */
export const SEARCHABLE_SQL: Partial<Record<Dimension, string>> = {
  host: 'host',
  path: PATH_SQL,
  user_agent: UA_SQL,
  ip: 'client_ip',
};

export function isSearchableDimension(dim: Dimension): boolean {
  return SEARCHABLE_SQL[dim] !== undefined;
}

/** Longest text a "contains" filter searches for. */
export const MAX_CONTAINS_LENGTH = 256;

// ── Metrics ──────────────────────────────────────────────────────────────

export const METRICS = ['requests', 'bytes', 'visitors', 'mitigated', 'errors'] as const;
export type Metric = (typeof METRICS)[number];

/** Aggregate of each metric over traffic_events. */
export const METRIC_SQL: Record<Metric, string> = {
  requests: 'count()',
  bytes: 'sum(bytes_sent)',
  visitors: 'uniq(client_ip)',
  mitigated: `countIf(${MITIGATED_SQL})`,
  errors: 'countIf(status >= 400)',
};

export function parseMetric(value: unknown): Metric {
  if (value === undefined || value === null || value === '') return 'requests';
  if (value === 'bandwidth') return 'bytes';
  if (typeof value === 'string' && (METRICS as readonly string[]).includes(value)) return value as Metric;
  throw new ApiValidationError(`Metric must be one of ${METRICS.join(', ')}`);
}

// ── Grouping ─────────────────────────────────────────────────────────────

export const GROUPINGS = ['none', 'outcome', 'status', 'host'] as const;
export type Grouping = (typeof GROUPINGS)[number];

/** Grouping when none is asked for: what the analytics chart shows for each metric. */
export const DEFAULT_GROUPING: Record<Metric, Grouping> = {
  requests: 'outcome',
  bytes: 'none',
  visitors: 'none',
  mitigated: 'outcome',
  errors: 'status',
};

export function parseGrouping(value: unknown, metric: Metric): Grouping {
  if (value === undefined || value === null || value === '') return DEFAULT_GROUPING[metric];
  if (typeof value === 'string' && (GROUPINGS as readonly string[]).includes(value)) return value as Grouping;
  throw new ApiValidationError(`Group by must be one of ${GROUPINGS.join(', ')}`);
}

/** The series key of the "every other host" group. */
export const OTHER_HOSTS = '__other__';
