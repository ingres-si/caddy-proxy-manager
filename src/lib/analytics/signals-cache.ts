/**
 * The traffic signals of the last 24 hours (signals.ts), reused for 30
 * seconds so the overview's sections share one set of ClickHouse queries.
 */
import { allProxyHostDomains } from "./service";
import { getTrafficSignals, type TrafficSignals } from "./signals";

/** How long the signals are reused. */
export const TRAFFIC_SIGNALS_CACHE_MS = 30_000;

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
