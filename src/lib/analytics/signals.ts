/**
 * Traffic signals for the overview's figures, each proxy host's page and
 * GET /api/v1/analytics/signals:
 *
 * - 5xx bursts: in the last 24 hours, runs of minutes in which a host
 *   answered with 5xx, at least BURST_MIN_ERRORS of them and at least
 *   BURST_MIN_SHARE of its requests in those minutes (gaps of up to
 *   BURST_GAP_MINUTES join runs). Each comes with its count, first and last
 *   5xx, the busiest path, status and method among them, and whether it is
 *   still going on.
 * - Mitigation spikes: hosts with at least SPIKE_MIN_MITIGATED mitigated
 *   requests in the last 24 hours and SPIKE_FACTOR times their daily average
 *   over the 7 days before.
 * - Blocked-traffic concentrations: in the last 24 hours, host + path +
 *   outcome groups with at least CONCENTRATION_MIN mitigated requests, with
 *   the countries they came from (and the WAF rule, for WAF blocks).
 *
 * Spikes and concentrations leave out sign-in redirects (outcome "auth"): a
 * login page doing its job is no blocked traffic, however busy it is.
 */
import { COUNTRY_SQL, MITIGATED_SQL, OUTCOME_SQL, PATH_SQL } from './dimensions';

/** Mitigated, and not a sign-in redirect. */
const BLOCKED_SQL = `${MITIGATED_SQL} AND (${OUTCOME_SQL}) != 'auth'`;
import { isOutcome, type Outcome } from './outcome';
import { num, ratio, selectRows, withAnalytics, type AnalyticsStatus } from './run';
import { proxyHostForName, type ProxyHostDomains } from './scope';

export const BURST_MIN_ERRORS = 10;
export const BURST_MIN_SHARE = 0.1;
export const BURST_GAP_MINUTES = 2;
/** A burst whose last 5xx is older than this is over ("then normal again"). */
export const BURST_ONGOING_SECONDS = 300;
export const SPIKE_MIN_MITIGATED = 50;
export const SPIKE_FACTOR = 3;
export const CONCENTRATION_MIN = 50;
const MAX_SIGNALS = 5;
const DAY = 86_400;

export type ErrorBurst = {
  host: string;
  proxyHostId: number | null;
  count: number;
  /** Requests in the burst's minutes, 5xx included. */
  requests: number;
  start: number;
  end: number;
  ongoing: boolean;
  /** The most frequent 5xx of the burst. */
  status: number;
  method: string;
  path: string;
};

export type MitigationSpike = {
  host: string;
  proxyHostId: number | null;
  /** Mitigated requests in the last 24 hours. */
  count: number;
  /** Daily average over the 7 days before. */
  baseline: number;
  /** count / baseline; null when the baseline is 0. */
  factor: number | null;
  /** The outcome behind most of the mitigated requests. */
  topOutcome: Outcome;
};

export type BlockedConcentration = {
  host: string;
  proxyHostId: number | null;
  path: string;
  outcome: Outcome;
  count: number;
  /** Share of all mitigated requests to the host in the last 24 hours. */
  shareOfHost: number;
  countries: { country: string; count: number }[];
  /** WAF blocks: the rule behind most of them (0 when unknown). */
  wafRuleId: number | null;
};

export type TrafficSignals = {
  status: AnalyticsStatus;
  generatedAt: number;
  errorBursts: ErrorBurst[];
  mitigationSpikes: MitigationSpike[];
  blockedConcentrations: BlockedConcentration[];
};

type MinuteRow = { host: string; m: unknown; total: unknown; e5: unknown };

/** Joins a host's minutes with 5xx into runs; keeps the runs that qualify as bursts. */
export function findBursts(rows: MinuteRow[]): { host: string; start: number; end: number; count: number; requests: number }[] {
  const byHost = new Map<string, { m: number; total: number; e5: number }[]>();
  for (const row of rows) {
    const list = byHost.get(row.host) ?? [];
    list.push({ m: num(row.m), total: num(row.total), e5: num(row.e5) });
    byHost.set(row.host, list);
  }
  const bursts: { host: string; start: number; end: number; count: number; requests: number }[] = [];
  for (const [host, minutes] of byHost) {
    minutes.sort((a, b) => a.m - b.m);
    let run: { start: number; end: number; count: number; requests: number } | null = null;
    const close = () => {
      if (run && run.count >= BURST_MIN_ERRORS && ratio(run.count, run.requests) >= BURST_MIN_SHARE) bursts.push({ host, ...run });
      run = null;
    };
    for (const minute of minutes) {
      if (minute.e5 <= 0) continue;
      if (run && minute.m - run.end <= BURST_GAP_MINUTES * 60) {
        run.end = minute.m;
        run.count += minute.e5;
        run.requests += minute.total;
      } else {
        close();
        run = { start: minute.m, end: minute.m, count: minute.e5, requests: minute.total };
      }
    }
    close();
  }
  return bursts.sort((a, b) => b.count - a.count).slice(0, MAX_SIGNALS);
}

/**
 * The signals for every host. `proxyHosts` (id and domains of every proxy
 * host) links each stored host name to its proxy host.
 */
export async function getTrafficSignals(
  proxyHosts: readonly ProxyHostDomains[] = [],
  now = Math.floor(Date.now() / 1000)
): Promise<TrafficSignals> {
  const empty = { generatedAt: now, errorBursts: [], mitigationSpikes: [], blockedConcentrations: [] };
  return withAnalytics('traffic signals', empty, async () => {
    const day = now - DAY;
    const params = { p_day: day, p_week: day - 7 * DAY, p_now: now + 60 };
    const owner = (host: string) => proxyHostForName(host, proxyHosts);

    const [minutes, spikes, concentrations] = await Promise.all([
      selectRows<MinuteRow>(
        `SELECT host, toUInt32(toStartOfMinute(ts)) AS m, count() AS total, countIf(status >= 500) AS e5
         FROM traffic_events
         WHERE ts >= toDateTime({p_day:UInt32}) AND ts < toDateTime({p_now:UInt32})
         GROUP BY host, m HAVING e5 > 0`,
        params
      ),
      selectRows<{ host: string; cur: unknown; before: unknown; top: unknown }>(
        `SELECT host, countIf(ts >= toDateTime({p_day:UInt32})) AS cur, countIf(ts < toDateTime({p_day:UInt32})) AS before,
                topKIf(1)(${OUTCOME_SQL}, ts >= toDateTime({p_day:UInt32})) AS top
         FROM traffic_events
         WHERE ts >= toDateTime({p_week:UInt32}) AND ts < toDateTime({p_now:UInt32}) AND ${BLOCKED_SQL}
         GROUP BY host HAVING cur >= {p_spike_min:UInt32}`,
        { ...params, p_spike_min: SPIKE_MIN_MITIGATED }
      ),
      selectRows<Record<string, unknown>>(
        `SELECT host, ${PATH_SQL} AS path, ${OUTCOME_SQL} AS o, count() AS c,
                sumMap([${COUNTRY_SQL}], [toUInt64(1)]) AS by_country, topKIf(1)(waf_rule_id, waf_rule_id != 0) AS rule,
                sum(count()) OVER (PARTITION BY host) AS host_total
         FROM traffic_events
         WHERE ts >= toDateTime({p_day:UInt32}) AND ts < toDateTime({p_now:UInt32}) AND ${BLOCKED_SQL}
         GROUP BY host, path, o
         ORDER BY c DESC LIMIT {p_max:UInt32}`,
        { ...params, p_max: 50 }
      ),
    ]);

    const bursts = findBursts(minutes);
    const errorBursts: ErrorBurst[] = [];
    for (const burst of bursts) {
      const [detail] = await selectRows<Record<string, unknown>>(
        `SELECT status, method, ${PATH_SQL} AS path, count() AS c,
                toUInt32(min(min(ts)) OVER ()) AS first, toUInt32(max(max(ts)) OVER ()) AS last
         FROM traffic_events
         WHERE host = {p_host:String} AND ts >= toDateTime({p_start:UInt32}) AND ts < toDateTime({p_end:UInt32}) AND status >= 500
         GROUP BY status, method, path ORDER BY c DESC, status, path LIMIT 1`,
        { p_host: burst.host, p_start: burst.start, p_end: burst.end + 60 }
      );
      const end = num(detail?.last) || burst.end + 59;
      errorBursts.push({
        host: burst.host,
        proxyHostId: owner(burst.host),
        count: burst.count,
        requests: burst.requests,
        start: num(detail?.first) || burst.start,
        end,
        ongoing: now - end < BURST_ONGOING_SECONDS,
        status: num(detail?.status),
        method: String(detail?.method ?? ''),
        path: String(detail?.path ?? ''),
      });
    }

    const mitigationSpikes: MitigationSpike[] = spikes
      .map((row) => {
        const count = num(row.cur);
        const baseline = num(row.before) / 7;
        const top = Array.isArray(row.top) ? String(row.top[0] ?? '') : '';
        return {
          host: row.host,
          proxyHostId: owner(row.host),
          count,
          baseline,
          factor: baseline > 0 ? count / baseline : null,
          topOutcome: (isOutcome(top) ? top : 'geo') as Outcome,
        };
      })
      .filter((spike) => spike.baseline === 0 || spike.count >= SPIKE_FACTOR * spike.baseline)
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_SIGNALS);

    const blockedConcentrations: BlockedConcentration[] = concentrations
      .filter((row) => num(row.c) >= CONCENTRATION_MIN && isOutcome(row.o))
      .slice(0, MAX_SIGNALS)
      .map((row) => {
        const host = String(row.host ?? '');
        const outcome = row.o as Outcome;
        const rule = Array.isArray(row.rule) ? num(row.rule[0]) : 0;
        return {
          host,
          proxyHostId: owner(host),
          path: String(row.path ?? ''),
          outcome,
          count: num(row.c),
          shareOfHost: ratio(num(row.c), num(row.host_total)),
          countries: countryBreakdown(row.by_country),
          wafRuleId: outcome === 'waf' ? rule : null,
        };
      });

    return { generatedAt: now, errorBursts, mitigationSpikes, blockedConcentrations };
  });
}

function countryBreakdown(value: unknown): { country: string; count: number }[] {
  const pair = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
  const [countries, counts] = pair as [unknown, unknown];
  if (!Array.isArray(countries) || !Array.isArray(counts)) return [];
  return countries
    .map((country, i) => ({ country: String(country), count: num(counts[i]) }))
    .sort((a, b) => b.count - a.count || a.country.localeCompare(b.country))
    .slice(0, 6);
}
