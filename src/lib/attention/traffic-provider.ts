/**
 * Attention provider: what the traffic of the last 24 hours shows
 * (src/lib/analytics/signals.ts), for readers of the analytics:
 *
 * - 5xx bursts: critical while still going on, a warning once over.
 * - Mitigation spikes: a warning when ten times the usual (or, for a host
 *   with nothing mitigated in the week before, ten times the spike
 *   threshold), information otherwise.
 * - Blocked-traffic concentrations: information.
 *
 * Each item links to the proxy host's page when the host is known and the
 * reader may open it, otherwise to the analytics with the matching filters,
 * and mitigation items to the matching security events when the reader may
 * see them (links.ts builds both).
 * Readers may dismiss these items (dismissals.ts): each says what the
 * traffic did, and once looked at there is nothing left to fix.
 * Times are in UTC, as everywhere in the REST API. The signals are cached
 * for 30 seconds, so the overview and its attention list share one set of
 * ClickHouse queries.
 */
import { can, type Access } from "@/src/lib/permissions";
import { allProxyHostDomains, visibleProxyHostDomains } from "@/src/lib/analytics/service";
import { SPIKE_MIN_MITIGATED, getTrafficSignals, type BlockedConcentration, type ErrorBurst, type MitigationSpike, type TrafficSignals } from "@/src/lib/analytics/signals";
import type { Outcome } from "@/src/lib/analytics/outcome";
import { analyticsHref, securityHref } from "@/src/lib/analytics/links";
import type { AttentionAction, AttentionItem, AttentionProvider } from "./types";

type Item = Omit<AttentionItem, "source" | "dismissible">;

/** How long the signals are reused. */
export const TRAFFIC_SIGNALS_CACHE_MS = 30_000;
/** Times the usual (or the spike threshold, without history) from which a spike is a warning. */
export const SPIKE_WARNING_FACTOR = 10;

type CacheEntry = { at: number; value: Promise<TrafficSignals> };
const store = globalThis as typeof globalThis & { __ingressiTrafficSignalsEntry?: { entry: CacheEntry | null } };
const cache = (store.__ingressiTrafficSignalsEntry ??= { entry: null });

/** Forgets the cached signals (tests, or after the analytics were reconfigured). */
export function clearTrafficSignalsCache(): void {
  cache.entry = null;
}

/** The traffic signals, reused for TRAFFIC_SIGNALS_CACHE_MS. */
export async function cachedTrafficSignals(now: number = Date.now()): Promise<TrafficSignals> {
  const hit = cache.entry;
  if (hit && now - hit.at >= 0 && now - hit.at < TRAFFIC_SIGNALS_CACHE_MS) return hit.value;
  const value = getTrafficSignals(await allProxyHostDomains());
  const entry = { at: now, value };
  cache.entry = entry;
  value.catch(() => {
    if (cache.entry === entry) cache.entry = null;
  });
  return value;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "09:02 UTC" today, "2 Oct 23:58 UTC" on another day (UTC). */
export function utcClock(unixSeconds: number, nowSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const today = new Date(nowSeconds * 1000);
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  const sameDay = date.toISOString().slice(0, 10) === today.toISOString().slice(0, 10);
  return sameDay ? `${time} UTC` : `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${time} UTC`;
}

function count(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function percent(fraction: number): string {
  const value = fraction * 100;
  return `${value >= 10 || value === 0 ? Math.round(value) : value.toFixed(1)}%`;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

let regionNames: Intl.DisplayNames | null | undefined;

/** "Germany" for DE; the local network for LAN; null for unknown (XX). */
export function countryName(code: string): string | null {
  const upper = code.toUpperCase();
  if (upper === "LAN") return "the local network";
  if (upper === "XX" || !/^[A-Z]{2}$/.test(upper)) return null;
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(upper) ?? upper;
  } catch {
    return upper;
  }
}

/** "From Hong Kong, India and 2 more countries" (at most four names). */
function countriesText(countries: BlockedConcentration["countries"]): string | null {
  const names = countries.map((entry) => countryName(entry.country)).filter((name): name is string => name !== null);
  if (names.length === 0) return countries.length > 0 ? "From addresses no country is known for" : null;
  const shown = names.slice(0, 4);
  const rest = names.length - shown.length;
  return rest > 0 ? `From ${shown.join(", ")} and ${rest} more` : `From ${joinNames(shown)}`;
}

const OUTCOME_NOUNS: Record<Exclude<Outcome, "served">, string> = {
  waf: "WAF blocks",
  geo: "geo rule blocks",
  access: "access rule refusals",
  auth: "sign-in redirects",
  rate_limit: "rate limit refusals",
};

function outcomeNoun(outcome: Outcome): string {
  return outcome === "served" ? "requests" : OUTCOME_NOUNS[outcome];
}

function concentrationTitle(outcome: Outcome, n: string, target: string): string {
  switch (outcome) {
    case "waf":
      return `The WAF blocked ${n} requests to ${target}`;
    case "geo":
      return `Geo rules blocked ${n} requests to ${target}`;
    case "access":
      return `Access rules refused ${n} requests to ${target}`;
    case "auth":
      return `${n} requests to ${target} were sent to sign in`;
    case "rate_limit":
      return `The rate limit refused ${n} requests to ${target}`;
    default:
      return `${n} requests to ${target} were mitigated`;
  }
}

type LinkContext = { visibleHostIds: ReadonlySet<number> | null; security: boolean };

function hostAction(proxyHostId: number | null, context: LinkContext): AttentionAction | null {
  if (proxyHostId === null || !context.visibleHostIds?.has(proxyHostId)) return null;
  return { label: "Open host", route: `/proxy-hosts/${proxyHostId}` };
}

function securityAction(context: LinkContext, kind: Outcome, host: string, path?: string): AttentionAction[] {
  if (!context.security) return [];
  const filters = [{ dim: "host" as const, value: host }, ...(path ? [{ dim: "path" as const, value: path }] : [])];
  return [{ label: "Security events", route: securityHref({ kind: kind === "served" ? undefined : kind, filters }) }];
}

export function burstItem(burst: ErrorBurst, now: number, context: LinkContext): Item {
  const errors = burst.status >= 500 ? String(burst.status) : "5xx";
  const where = burst.path ? ` to ${burst.method ? `${burst.method} ` : ""}${burst.path}` : "";
  const share = burst.requests > 0 ? percent(burst.count / burst.requests) : null;
  const title = burst.ongoing
    ? `${burst.host} is answering with server errors: ${count(burst.count)} since ${utcClock(burst.start, now)}`
    : `${burst.host} answered ${count(burst.count)} requests with server errors at ${utcClock(burst.start, now)}`;
  const detail = burst.ongoing
    ? `Mostly ${errors}${where}${share ? `, ${share} of its requests since then` : ""}. The last one was at ${utcClock(burst.end, now)}.`
    : `Mostly ${errors}${where}, until ${utcClock(burst.end, now)}${share ? ` (${share} of its requests in those minutes)` : ""}; normal again since.`;
  const host = hostAction(burst.proxyHostId, context);
  return {
    id: `burst:${burst.host}:${burst.start}`,
    severity: burst.ongoing ? "critical" : "warning",
    title,
    detail,
    actions: [
      ...(host ? [host] : []),
      { label: "Show requests", route: analyticsHref([{ dim: "host", value: burst.host }, { dim: "status", value: "5xx" }]) },
    ],
    at: new Date(burst.start * 1000).toISOString(),
  };
}

function factorText(factor: number): string {
  return factor >= 10 ? String(Math.round(factor)) : factor.toFixed(1).replace(/\.0$/, "");
}

export function spikeItem(spike: MitigationSpike, generatedAt: number, context: LinkContext): Item {
  const average = spike.baseline >= 10 ? count(spike.baseline) : spike.baseline.toFixed(1).replace(/\.0$/, "");
  const title = spike.factor === null
    ? `${count(spike.count)} mitigated requests to ${spike.host}, none in the week before`
    : `${count(spike.count)} mitigated requests to ${spike.host}, ${factorText(spike.factor)} times its daily average`;
  const detail = spike.factor === null
    ? `Mostly ${outcomeNoun(spike.topOutcome)}, all in the last 24 hours.`
    : `Mostly ${outcomeNoun(spike.topOutcome)} in the last 24 hours, against a daily average of ${average} over the 7 days before.`;
  const warning = spike.factor === null ? spike.count >= SPIKE_WARNING_FACTOR * SPIKE_MIN_MITIGATED : spike.factor >= SPIKE_WARNING_FACTOR;
  const host = hostAction(spike.proxyHostId, context);
  return {
    id: `spike:${spike.host}`,
    severity: warning ? "warning" : "info",
    title,
    detail,
    actions: [
      host ?? { label: "Show requests", route: analyticsHref([{ dim: "host", value: spike.host }, { dim: "outcome", op: "is_not", value: "served" }]) },
      ...securityAction(context, spike.topOutcome, spike.host),
    ],
    at: new Date(generatedAt * 1000).toISOString(),
  };
}

export function concentrationItem(concentration: BlockedConcentration, generatedAt: number, context: LinkContext): Item {
  const target = `${concentration.host}${concentration.path}`;
  const parts = [
    countriesText(concentration.countries),
    concentration.shareOfHost > 0 ? `${percent(concentration.shareOfHost)} of what was mitigated on this host in the last 24 hours` : null,
  ].filter((part): part is string => Boolean(part));
  let detail = parts.length > 0 ? `${parts.join(", ")}.` : "In the last 24 hours.";
  if (concentration.wafRuleId) detail += ` Mostly rule ${concentration.wafRuleId}.`;
  const host = hostAction(concentration.proxyHostId, context);
  const filters = [
    { dim: "host" as const, value: concentration.host },
    ...(concentration.path ? [{ dim: "path" as const, value: concentration.path }] : []),
    { dim: "outcome" as const, value: concentration.outcome },
  ];
  return {
    id: `blocked:${concentration.host}:${concentration.outcome}:${concentration.path}`,
    severity: "info",
    title: concentrationTitle(concentration.outcome, count(concentration.count), target),
    detail,
    actions: [
      host ?? { label: "Show requests", route: analyticsHref(filters) },
      ...securityAction(context, concentration.outcome, concentration.host, concentration.path || undefined),
    ],
    at: new Date(generatedAt * 1000).toISOString(),
  };
}

/** The items of `signals` for `access`. */
export async function trafficItems(access: Access, signals: TrafficSignals): Promise<Item[]> {
  if (signals.status !== "ok") return [];
  const context: LinkContext = {
    visibleHostIds: can(access, "proxy_hosts:read") ? new Set((await visibleProxyHostDomains(access)).map((host) => host.id)) : null,
    security: can(access, "waf:read"),
  };
  const now = signals.generatedAt;
  return [
    ...signals.errorBursts.map((burst) => burstItem(burst, now, context)),
    ...signals.mitigationSpikes.map((spike) => spikeItem(spike, now, context)),
    ...signals.blockedConcentrations.map((concentration) => concentrationItem(concentration, now, context)),
  ];
}

export const trafficAttentionProvider: AttentionProvider = {
  id: "traffic",
  label: "Traffic",
  permissions: ["analytics:read"],
  dismissible: true,
  async collect({ access, now }) {
    return trafficItems(access, await cachedTrafficSignals(now.getTime()));
  },
};
