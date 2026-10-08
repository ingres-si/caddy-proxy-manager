/**
 * The attention providers and how their items are collected for a reader.
 * Each provider runs only when the reader holds one of its permissions, with
 * its own time limit; a provider that fails or is slow is reported as such
 * and never hides the others. Items the reader dismissed (dismissals.ts) are
 * left out. Items come back most severe first, then newest first.
 */
import { can, type Access } from "@/src/lib/permissions";
import { dismissalKey, hides, loadAttentionDismissals, type AttentionDismissal } from "./dismissals";
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

/** The items `access` may see, from every registered provider. */
export async function collectAttention(access: Access, options: { now?: Date; timeoutMs?: number } = {}): Promise<AttentionView> {
  const now = options.now ?? new Date();
  const readable = listAttentionProviders().filter((provider) => mayRead(provider, access));
  // Without its dismissals the reader sees every item rather than none.
  const dismissals: Promise<Map<string, AttentionDismissal>> = readable.some((provider) => provider.dismissible)
    ? loadAttentionDismissals(access.userId, now).catch(() => new Map())
    : Promise.resolve(new Map());
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
          dismissible: provider.dismissible === true,
        }));
      } catch {
        sources.push({ id: provider.id, label: provider.label, status: "error", items: 0 });
        return [];
      }
    })
  );
  const hidden = await dismissals;
  const all = results.flat();
  const listed = all.filter((item) => !item.dismissible || !hides(hidden.get(dismissalKey(item.source, item.id)), item));
  const items = listed.sort((a, b) => RANK[a.severity] - RANK[b.severity] || (b.at ?? "").localeCompare(a.at ?? ""));
  const counts: Record<AttentionSeverity, number> = { critical: 0, warning: 0, info: 0 };
  for (const item of items) counts[item.severity] += 1;
  return {
    generatedAt: now.toISOString(),
    items: items.slice(0, MAX_ATTENTION_ITEMS),
    truncated: items.length > MAX_ATTENTION_ITEMS,
    counts,
    dismissed: all.length - listed.length,
    sources: sources.sort((a, b) => a.id.localeCompare(b.id)),
  };
}
