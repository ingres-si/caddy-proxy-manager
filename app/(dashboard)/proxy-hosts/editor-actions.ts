"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/src/lib/auth";
import { previewProxyHostChange, submitProxyHostChange, type HostChangeResult } from "@/src/lib/proxy-host-changes";
import type { HostChangePreview } from "@/ee/approvals/requests";
import { CaddyApplyError } from "@/src/lib/caddy-apply-error";

export type HostEditorSaveState = HostChangeResult | { status: "error"; message: string };
export type HostEditorPreviewState =
  | { status: "ok"; preview: HostChangePreview & { warning: string | null } }
  | { status: "error"; message: string };

function hostId(id: unknown): number | null {
  if (id === null) return null;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw new Error("Proxy host not found");
  return id;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The host editor's save: creates the host (id null) or updates it, or
 * submits the change for approval when a change approval policy covers it.
 */
export async function saveProxyHostEditorAction(id: number | null, payload: unknown): Promise<HostEditorSaveState> {
  try {
    const session = await requirePermission("proxy_hosts:write");
    const result = await submitProxyHostChange(session.access, Number(session.user.id), hostId(id), payload);
    revalidatePath("/proxy-hosts");
    if (result.status === "submitted") revalidatePath("/approvals");
    return result;
  } catch (error) {
    // Stored, but Caddy did not take it: the change is saved and applied once an apply succeeds.
    const storedId = error instanceof CaddyApplyError ? id ?? error.proxyHostId ?? null : null;
    if (error instanceof CaddyApplyError && storedId !== null) {
      revalidatePath("/proxy-hosts");
      return {
        status: "saved",
        hostId: storedId,
        message: `Saved, but not live yet: ${error.message}. Caddy keeps serving its previous configuration until an apply succeeds.`,
      };
    }
    console.error(`Failed to save proxy host ${id ?? "(new)"}:`, error);
    return { status: "error", message: errorMessage(error, "The proxy host could not be saved. Check the logs for details.") };
  }
}

/** The host editor's review: the approval policy that applies, the field changes and the impact. Stores nothing. */
export async function previewProxyHostEditorAction(id: number | null, payload: unknown): Promise<HostEditorPreviewState> {
  try {
    const session = await requirePermission("proxy_hosts:write");
    return { status: "ok", preview: await previewProxyHostChange(session.access, hostId(id), payload) };
  } catch (error) {
    return { status: "error", message: errorMessage(error, "The change could not be checked.") };
  }
}
