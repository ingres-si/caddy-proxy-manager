/**
 * The attention providers and how their items are collected for a reader.
 * Each provider runs only when the reader holds one of its permissions, with
 * its own time limit; a provider that fails or is slow is reported as such
 * and never hides the others. Items come back most severe first, then
 * newest first.
 */
import { can, type Access } from "@/src/lib/permissions";
import { loadAlertCoverage, type AlertCoverage } from "./alert-coverage";
import type { AttentionItem, AttentionProvider, AttentionSeverity, AttentionSourceStatus, AttentionView } from "./types";

export const ATTENTION_PROVIDER_TIMEOUT_MS = 4_000;
export const MAX_ATTENTION_ITEMS = 50;
const MAX_TEXT = 500;

const store = globalThis as typeof globalThis & { __ingressiAttentionProviders?: Map<string, AttentionProvider> };
const providers = (store.__ingressiAttentionProviders ??= new Map<string, AttentionProvider>());

/** Registers (or replaces) a provider by its id. */
export function registerAttentionProvider(provider: AttentionProvider): void {
  providers.set(provider.id, provider);
}

export function unregisterAttentionProvider(id: string): void {
  providers.delete(id);
}

export function listAttentionProviders(): AttentionProvider[] {
  return [...providers.values()];
}

/** Whether `access` may see the provider's items. */
export function mayRead(provider: AttentionProvider, access: Access): boolean {
  return provider.permissions.length === 0 || provider.permissions.some((permission) => can(access, permission));
}

const RANK: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 };

function clean(text: string): string {
  return text.replace(/\p{Cc}+/gu, " ").slice(0, MAX_TEXT);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
      (timer as { unref?: () => void }).unref?.();
    }),
  ]);
}

/** Whether the alert rules report what `provider` reports, for this reader. */
function superseded(provider: AttentionProvider, coverage: AlertCoverage | null): boolean {
  return coverage !== null && (provider.supersededBy?.some((type) => coverage.types.has(type)) ?? false);
}

/**
 * The items `access` may see, from every registered provider. A provider
 * whose problems an enabled alert rule reports (supersededBy) is left out for
 * readers of the alerts, who see them as alerts instead.
 */
export async function collectAttention(
  access: Access,
  options: { now?: Date; timeoutMs?: number; coverage?: () => Promise<AlertCoverage> } = {}
): Promise<AttentionView> {
  const now = options.now ?? new Date();
  // Without the coverage every provider runs: a problem listed twice beats one not listed.
  const coverage = can(access, "alerts:read") ? await (options.coverage ?? loadAlertCoverage)().catch(() => null) : null;
  const readable = listAttentionProviders().filter((provider) => mayRead(provider, access) && !superseded(provider, coverage));
  const sources: AttentionSourceStatus[] = [];
  const results = await Promise.all(
    readable.map(async (provider) => {
      try {
        const result = await withTimeout(provider.collect({ access, now }), options.timeoutMs ?? ATTENTION_PROVIDER_TIMEOUT_MS);
        if (result === "timeout") {
          sources.push({ id: provider.id, label: provider.label, status: "timeout", items: 0 });
          return [];
        }
        sources.push({ id: provider.id, label: provider.label, status: "ok", items: result.length });
        return result.map((item): AttentionItem => ({
          ...item,
          source: provider.id,
          title: clean(item.title),
          detail: clean(item.detail),
          actions: item.actions.slice(0, 3),
        }));
      } catch {
        sources.push({ id: provider.id, label: provider.label, status: "error", items: 0 });
        return [];
      }
    })
  );
  const items = results.flat().sort((a, b) => RANK[a.severity] - RANK[b.severity] || (b.at ?? "").localeCompare(a.at ?? ""));
  const counts: Record<AttentionSeverity, number> = { critical: 0, warning: 0, info: 0 };
  for (const item of items) counts[item.severity] += 1;
  return {
    generatedAt: now.toISOString(),
    items: items.slice(0, MAX_ATTENTION_ITEMS),
    truncated: items.length > MAX_ATTENTION_ITEMS,
    counts,
    sources: sources.sort((a, b) => a.id.localeCompare(b.id)),
    notifying: coverage?.notifying ?? null,
  };
}
