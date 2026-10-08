/**
 * Saving a proxy host from the host editor (/proxy-hosts/new and
 * the tabs of /proxy-hosts/[id]) and previewing what saving would do.
 *
 * The editor sends the host's fields as JSON, in the shape of the REST API's
 * POST and PUT bodies: every field for a new host, the changed top-level
 * fields for an existing one. The same checks as the REST API and the older
 * form actions run before anything is stored: the caller's scope (tags,
 * domains of other scopes, certificates, access lists, custom Caddy JSON,
 * mTLS trust), forward-auth grants, then the change approval gate
 * (ee/approvals), which turns a protected change into a change request or
 * applies it as an emergency change. The model functions validate the rest.
 */
import { getProxyHostInScope, assertDomainsFreeOutsideScope, assertForwardAuthAccessAllowed, assertProxyHostWriteAllowed, tagsForWrite } from "./access-scope";
import { ApiValidationError } from "./api-errors";
import type { Access } from "./permissions";
import { createProxyHost, updateProxyHost, type ProxyHost, type ProxyHostInput } from "./models/proxy-hosts";
import { getCertificate } from "./models/certificates";
import { getForwardAuthAccessForHost, setForwardAuthAccess } from "./models/forward-auth";
import { gateHostChange, previewHostChange, type HostChange, type HostChangePreview } from "@/ee/approvals/requests";

/** Most users or groups one host's forward auth may name in one request. */
const MAX_GRANTS = 1000;

export type HostChangePayload = {
  /** The host's fields: all of them for a new host, the changed ones for an existing host. */
  host: Partial<ProxyHostInput>;
  /** Users and groups allowed through the built-in forward auth; absent leaves them as they are. */
  forwardAuthAccess?: { userIds: number[]; groupIds: number[] };
  /** Shown to approvers when the change needs approval. */
  note?: string;
  /** Applies a protected change at once as an emergency change. */
  emergencyReason?: string;
};

export type HostChangeResult =
  | { status: "saved"; hostId: number; message: string }
  | {
      status: "submitted";
      /** pending: waiting for approval; applied: applied as an emergency change. */
      requestStatus: "pending" | "applied";
      requestId: number;
      /** The host, when it exists (an update, or an applied create). */
      hostId: number | null;
      message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readIds(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length > MAX_GRANTS || !value.every((id) => Number.isSafeInteger(id) && (id as number) > 0)) {
    throw new ApiValidationError(`${field} must be a list of ids`);
  }
  return [...new Set(value as number[])].sort((a, b) => a - b);
}

function readOptionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ApiValidationError(`${field} must be a string`);
  return value;
}

/** Checks the shape of a request; the model and the approval gate validate the values. */
export function parseHostChangePayload(raw: unknown, creating: boolean): HostChangePayload {
  if (!isRecord(raw) || !isRecord(raw.host)) throw new ApiValidationError("The change must contain the host's fields");
  const host = { ...raw.host } as Record<string, unknown>;
  if (creating || host.name !== undefined) {
    if (typeof host.name !== "string" || !host.name.trim()) throw new ApiValidationError("Name is required");
  }
  for (const field of ["domains", "upstreams"] as const) {
    if (creating || host[field] !== undefined) {
      if (!Array.isArray(host[field]) || !(host[field] as unknown[]).every((item) => typeof item === "string")) {
        throw new ApiValidationError(`${field} must be a list of strings`);
      }
    }
  }
  const payload: HostChangePayload = { host: host as Partial<ProxyHostInput> };
  if (raw.forwardAuthAccess !== undefined && raw.forwardAuthAccess !== null) {
    if (!isRecord(raw.forwardAuthAccess)) throw new ApiValidationError("forwardAuthAccess must be an object");
    payload.forwardAuthAccess = {
      userIds: readIds(raw.forwardAuthAccess.userIds ?? [], "forwardAuthAccess.userIds"),
      groupIds: readIds(raw.forwardAuthAccess.groupIds ?? [], "forwardAuthAccess.groupIds"),
    };
  }
  const note = readOptionalText(raw.note, "note");
  if (note !== undefined) payload.note = note;
  const emergencyReason = readOptionalText(raw.emergencyReason, "emergencyReason");
  if (emergencyReason !== undefined) payload.emergencyReason = emergencyReason;
  return payload;
}

type Prepared = {
  existing: ProxyHost | null;
  host: Partial<ProxyHostInput>;
  forwardAuthAccess?: { userIds: number[]; groupIds: number[] };
  warning?: string;
};

async function currentGrants(hostId: number): Promise<{ userIds: number[]; groupIds: number[] }> {
  const grants = await getForwardAuthAccessForHost(hostId);
  return {
    userIds: grants.filter((entry) => entry.userId !== null).map((entry) => entry.userId!),
    groupIds: grants.filter((entry) => entry.groupId !== null).map((entry) => entry.groupId!),
  };
}

/** The scope checks of the REST API and the form actions, in the same order. */
async function prepare(access: Access, id: number | null, payload: HostChangePayload): Promise<Prepared> {
  const existing = id === null ? null : await getProxyHostInScope(access, id);
  const host: Partial<ProxyHostInput> = { ...payload.host };
  let warning: string | undefined;

  // A certificate deleted since the form was opened: Caddy manages the host's certificate instead.
  if (typeof host.certificateId === "number" && host.certificateId !== existing?.certificateId) {
    if (!(await getCertificate(host.certificateId))) {
      warning = `The chosen certificate no longer exists, so Caddy manages this host's certificate.`;
      host.certificateId = null;
    }
  }

  const tags = tagsForWrite(access, "proxy_hosts", host.tags, existing?.tags ?? null);
  if (tags !== undefined) host.tags = tags;
  else delete host.tags;
  await assertProxyHostWriteAllowed(access, host, existing);
  await assertDomainsFreeOutsideScope(access, Array.isArray(host.domains) ? host.domains : undefined, existing?.id ?? null);
  if (payload.forwardAuthAccess) {
    const current = existing ? await currentGrants(existing.id) : { userIds: [], groupIds: [] };
    await assertForwardAuthAccessAllowed(access, payload.forwardAuthAccess, current);
  }
  return { existing, host, forwardAuthAccess: payload.forwardAuthAccess, warning };
}

function changeOf(prepared: Prepared): HostChange {
  return {
    targetType: "proxy_host",
    kind: prepared.existing ? "update" : "create",
    target: prepared.existing,
    input: { host: prepared.host, ...(prepared.forwardAuthAccess ? { forwardAuthAccess: prepared.forwardAuthAccess } : {}) },
  };
}

/**
 * Creates (id null) or updates a proxy host, or submits the change for
 * approval. Throws on anything invalid or out of scope, with the message to
 * show (the editor maps known messages to their fields).
 */
export async function submitProxyHostChange(
  access: Access,
  actorUserId: number,
  id: number | null,
  raw: unknown
): Promise<HostChangeResult> {
  const payload = parseHostChangePayload(raw, id === null);
  const prepared = await prepare(access, id, payload);
  const gate = await gateHostChange({
    access,
    change: changeOf(prepared),
    note: payload.note,
    emergencyReason: payload.emergencyReason,
  });
  if (gate) {
    return {
      status: "submitted",
      requestStatus: gate.status,
      requestId: gate.request.id,
      hostId: prepared.existing?.id ?? gate.request.targetId ?? null,
      message: gate.message,
    };
  }

  const suffix = prepared.warning ? ` ${prepared.warning}` : "";
  if (prepared.existing) {
    await updateProxyHost(prepared.existing.id, prepared.host, actorUserId);
    if (prepared.forwardAuthAccess) await setForwardAuthAccess(prepared.existing.id, prepared.forwardAuthAccess, actorUserId);
    return { status: "saved", hostId: prepared.existing.id, message: `Saved ${prepared.host.name ?? prepared.existing.name}.${suffix}` };
  }
  const created = await createProxyHost(prepared.host as ProxyHostInput, actorUserId);
  const grants = prepared.forwardAuthAccess;
  if (grants && created.ingressiForwardAuth?.enabled && (grants.userIds.length > 0 || grants.groupIds.length > 0)) {
    await setForwardAuthAccess(created.id, grants, actorUserId);
  }
  return { status: "saved", hostId: created.id, message: `Created ${created.name}.${suffix}` };
}

/**
 * What submitting the change would do: the approval policy that applies, the
 * field changes and the impact. Runs the same scope checks as a save, so a
 * change the caller may not make fails here already; stores nothing.
 */
export async function previewProxyHostChange(
  access: Access,
  id: number | null,
  raw: unknown
): Promise<HostChangePreview & { warning: string | null }> {
  const payload = parseHostChangePayload(raw, id === null);
  const prepared = await prepare(access, id, payload);
  const preview = await previewHostChange({ access, change: changeOf(prepared) });
  return { ...preview, warning: prepared.warning ?? null };
}
