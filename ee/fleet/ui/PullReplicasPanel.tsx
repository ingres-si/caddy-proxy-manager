// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { Copy, KeyRound, Plus, Satellite, Trash2, Ban } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pagination, useUrlPage } from "@/components/ui/Pagination";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot, type StatusTone } from "@/components/ui/StatusDot";
import { Textarea } from "@/components/ui/textarea";
import { formatVersion } from "@/src/lib/app-version";
import { formatDateTimeUtc } from "@/src/lib/date-format";
import { paginate } from "@/src/lib/pagination";
import type { IssuedPullCredential, PullCheckIn, PullReplicaView } from "@/ee/fleet/types";

type Props = {
  replicas: PullReplicaView[];
  /** The role holds fleet:replicas. */
  canManage: boolean;
  /** This instance is a master; pull replicas poll masters only. */
  isMaster: boolean;
  /** Called after a change, to refresh what the page around the panel shows (the panel updates itself). */
  onChanged?: () => void;
  /** Shows the panel's own "Add pull replica" button. Off where the page has one (Fleet). Default true. */
  showAddButton?: boolean;
  /** Controls the add dialog from outside (the Fleet page's header button). */
  adding?: boolean;
  onAddingChange?: (open: boolean) => void;
  className?: string;
};

type Confirm = { kind: "rotate" | "revoke" | "delete"; replica: PullReplicaView };

const CHECK_IN_LABELS: Record<PullCheckIn, { label: string; tone: StatusTone }> = {
  ok: { label: "Checking in", tone: "ok" },
  missed: { label: "Not checking in", tone: "warn" },
  never: { label: "Never checked in", tone: "off" },
};

async function readError(response: Response): Promise<string> {
  try {
    const data = await response.json();
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // fall through
  }
  return `Request failed (HTTP ${response.status})`;
}

async function send<T>(url: string, init: RequestInit): Promise<T | null> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(await readError(response));
  return response.status === 204 ? null : ((await response.json()) as T);
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      <Copy className="h-4 w-4" /> {copied ? "Copied" : label}
    </Button>
  );
}

/** The credential and the replica's environment, shown once. */
function IssuedCredentialDialog({ issued, onClose }: { issued: IssuedPullCredential | null; onClose: () => void }) {
  return (
    <AppDialog
      open={issued !== null}
      onClose={onClose}
      title={issued ? `Credential of "${issued.replica.name}"` : "Credential"}
      maxWidth="lg"
      actions={<Button onClick={onClose}>Done</Button>}
    >
      {issued && (
        <div className="space-y-3 text-sm">
          <Banner tone="warn">Copy it now: it is not shown again. Set these variables on the replica and restart it.</Banner>
          <div className="space-y-1.5">
            <Label htmlFor="pull-credential">Credential (INSTANCE_PULL_TOKEN)</Label>
            <div className="flex gap-2">
              <Input id="pull-credential" readOnly value={issued.credential} className="font-mono text-xs" />
              <CopyButton text={issued.credential} label="Copy" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pull-env">Environment of the replica</Label>
            <Textarea id="pull-env" readOnly value={issued.env} rows={7} className="font-mono text-xs" />
            <CopyButton text={issued.env} label="Copy all" />
          </div>
          <p className="text-xs text-soft">The replica keeps its own SESSION_SECRET.</p>
        </div>
      )}
    </AppDialog>
  );
}

/**
 * Pull replicas on the master: adding one (its credential and environment
 * are shown once), their last check-in, and rotating or revoking the
 * credential. Used on the Fleet page and on the Instance sync page.
 */
export default function PullReplicasPanel({
  replicas,
  canManage,
  isMaster,
  onChanged,
  showAddButton = true,
  adding: controlledAdding,
  onAddingChange,
  className,
}: Props) {
  // The replicas as changed here, until the page passes new ones.
  const [local, setLocal] = useState({ source: replicas, items: replicas });
  if (local.source !== replicas) setLocal({ source: replicas, items: replicas });
  const items = local.source === replicas ? local.items : replicas;
  const { page, hrefFor } = useUrlPage("replicas");
  const shown = paginate(items, page);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [ownAdding, setOwnAdding] = useState(false);
  const adding = controlledAdding ?? ownAdding;
  const setAdding = (open: boolean) => {
    if (controlledAdding === undefined) setOwnAdding(open);
    onAddingChange?.(open);
  };
  const [name, setName] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedPullCredential | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  function openAdd() {
    setAddError(null);
    setAdding(true);
  }

  function closeAdd() {
    setAddError(null);
    setAdding(false);
  }

  function add() {
    setAddError(null);
    startTransition(async () => {
      try {
        const result = await send<IssuedPullCredential>("/api/v1/fleet/pull-replicas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, ...(publicKey.trim() ? { syncPublicKey: publicKey.trim() } : {}) }),
        });
        setAdding(false);
        setName("");
        setPublicKey("");
        if (result) {
          setIssued(result);
          setLocal((current) => ({ ...current, items: [...current.items, result.replica].sort((a, b) => a.name.localeCompare(b.name)) }));
        }
        onChanged?.();
      } catch (error) {
        setAddError((error as Error).message);
      }
    });
  }

  function runConfirmed() {
    if (!confirm) return;
    const { kind, replica } = confirm;
    setConfirmError(null);
    startTransition(async () => {
      try {
        const replace = (next: PullReplicaView) =>
          setLocal((current) => ({ ...current, items: current.items.map((item) => (item.id === next.id ? next : item)) }));
        if (kind === "rotate") {
          const result = await send<IssuedPullCredential>(`/api/v1/fleet/pull-replicas/${replica.id}/credential`, { method: "POST" });
          if (result) {
            setIssued(result);
            replace(result.replica);
          }
        } else if (kind === "revoke") {
          const result = await send<PullReplicaView>(`/api/v1/fleet/pull-replicas/${replica.id}/credential`, { method: "DELETE" });
          if (result) replace(result);
          setMessage({ ok: true, text: `Revoked the credential of "${replica.name}". Its polls are refused until you issue a new one.` });
        } else {
          await send(`/api/v1/fleet/pull-replicas/${replica.id}`, { method: "DELETE" });
          setLocal((current) => ({ ...current, items: current.items.filter((item) => item.id !== replica.id) }));
          setMessage({ ok: true, text: `Deleted pull replica "${replica.name}".` });
        }
        setConfirm(null);
        onChanged?.();
      } catch (error) {
        setConfirmError((error as Error).message);
      }
    });
  }

  const confirmTitle = confirm
    ? confirm.kind === "rotate"
      ? `Issue a new credential for "${confirm.replica.name}"?`
      : confirm.kind === "revoke"
        ? `Revoke the credential of "${confirm.replica.name}"?`
        : `Delete pull replica "${confirm.replica.name}"?`
    : "";

  const addButton =
    canManage && showAddButton ? (
      <Button size="sm" variant="outline" disabled={pending || !isMaster} onClick={() => openAdd()}>
        <Plus className="h-4 w-4" /> Add pull replica
      </Button>
    ) : null;

  return (
    <SectionCard
      title="Pull replicas"
      count={items.length}
      actions={addButton}
      className={className}
    >
      <div className="flex flex-col">
        {!isMaster || message ? (
          <div className="flex flex-col gap-2 px-[18px] pt-3.5">
            {!isMaster && <Banner tone="info">Pull replicas poll a master; this instance is not one.</Banner>}
            {message && (
              <Banner tone={message.ok ? "ok" : "bad"} live onDismiss={() => setMessage(null)}>
                {message.text}
              </Banner>
            )}
          </div>
        ) : null}
        {items.length === 0 ? (
          <EmptyState
            compact
            icon={Satellite}
            title="No pull replicas"
            description="Add one for a node this master cannot reach, for example behind NAT."
          />
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
            {shown.items.map((replica) => {
              const checkIn = CHECK_IN_LABELS[replica.checkIn];
              return (
                <li key={replica.id} className="flex flex-col gap-3 px-[18px] py-3.5">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                    <span className="font-semibold [overflow-wrap:anywhere]">{replica.name}</span>
                    <StatusDot tone={checkIn.tone} label={checkIn.label} />
                    {!replica.enabled && <Badge variant="muted">Disabled</Badge>}
                    {replica.caddy && !replica.caddy.ok && <Badge variant="destructive">Caddy apply failed</Badge>}
                    {replica.resyncPending && <Badge variant="info">Re-sync pending</Badge>}
                  </div>
                  <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3.5 gap-y-1.5 text-[13px]">
                    <dt className="text-soft">Last check-in</dt>
                    <dd className="m-0">
                      {replica.lastSeenAt ? (
                        <span className="num">
                          {formatDateTimeUtc(replica.lastSeenAt)}
                          {replica.pollIntervalSeconds ? `, every ${replica.pollIntervalSeconds} s` : ""}
                        </span>
                      ) : (
                        <span className="text-soft">Never</span>
                      )}
                      {replica.lastSeenAddress && (
                        <span className="block text-xs text-soft">
                          from <span className="num">{replica.lastSeenAddress}</span>
                        </span>
                      )}
                    </dd>
                    <dt className="text-soft">Reports</dt>
                    <dd className="m-0">
                      {replica.reportedVersion ? <span className="num">{formatVersion(replica.reportedVersion)}</span> : <span className="text-soft">Nothing yet</span>}
                      {replica.caddy && (
                        <span className={replica.caddy.ok ? undefined : "text-bad"}>
                          {replica.caddy.ok
                            ? `, Caddy applied ${replica.deliveredRevisionId === null ? "the live configuration" : `#${replica.deliveredRevisionId}`}`
                            : `, Caddy rejected the configuration${replica.caddy.code ? ` (${replica.caddy.code})` : ""}`}
                        </span>
                      )}
                      {replica.lastSyncError && <span className="block text-xs text-bad [overflow-wrap:anywhere]">{replica.lastSyncError}</span>}
                    </dd>
                    <dt className="text-soft">Credential</dt>
                    <dd className="m-0">
                      {replica.hasCredential ? (
                        <>
                          <span className="num">{replica.credentialPrefix}…</span>
                          {replica.credentialCreatedAt && (
                            <span className="block text-xs text-soft">issued {formatDateTimeUtc(replica.credentialCreatedAt)}</span>
                          )}
                        </>
                      ) : (
                        <Badge variant="destructive">Revoked</Badge>
                      )}
                    </dd>
                    <dt className="text-soft">Sync key</dt>
                    <dd className="m-0">
                      {replica.syncKeyPin?.keyId ? (
                        <span title={replica.syncKeyPin.publicKey}>
                          Pinned · <span className="num">{replica.syncKeyPin.keyId}</span>
                        </span>
                      ) : replica.syncKeyPin ? (
                        <span className="text-bad">Unreadable pin</span>
                      ) : (
                        <span className="text-soft">Pinned on first contact</span>
                      )}
                    </dd>
                  </dl>
                  {canManage && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={pending}
                        onClick={() => { setConfirmError(null); setConfirm({ kind: "rotate", replica }); }}
                      >
                        <KeyRound className="h-4 w-4" /> {replica.hasCredential ? "Rotate credential" : "Issue credential"}
                      </Button>
                      {replica.hasCredential && (
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={pending}
                          onClick={() => { setConfirmError(null); setConfirm({ kind: "revoke", replica }); }}
                        >
                          <Ban className="h-4 w-4" /> Revoke
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete pull replica ${replica.name}`}
                        disabled={pending}
                        onClick={() => { setConfirmError(null); setConfirm({ kind: "delete", replica }); }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="border-t border-line px-[18px] py-3 empty:hidden">
          <Pagination page={shown.page} perPage={shown.perPage} total={shown.total} noun="pull replicas" label="Pages of pull replicas" hrefFor={hrefFor} />
        </div>
      </div>

      <AppDialog open={adding} onClose={closeAdd} title="Add pull replica" submitLabel="Add" onSubmit={add} isSubmitting={pending}>
        <div className="space-y-3 text-sm">
          <div className="space-y-1.5">
            <Label htmlFor="pull-replica-name">Name</Label>
            <Input id="pull-replica-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Branch office" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pull-replica-key">Replica&apos;s sync public key (optional)</Label>
            <Input
              id="pull-replica-key"
              value={publicKey}
              onChange={(event) => setPublicKey(event.target.value)}
              placeholder="44 characters of base64, from the replica's Instance Sync settings"
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
            />
            <p className="text-xs text-soft">
              Pins the key now. Without it, the first key the replica proves is pinned.
            </p>
          </div>
          {addError && (
            <Banner tone="bad" live>
              {addError}
            </Banner>
          )}
        </div>
      </AppDialog>

      <AppDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirmTitle}
        submitLabel={confirm?.kind === "rotate" ? "Issue" : confirm?.kind === "revoke" ? "Revoke" : "Delete"}
        onSubmit={runConfirmed}
        isSubmitting={pending}
      >
        <div className="space-y-2 text-sm">
          {confirm?.kind === "rotate" && (
            <p>The current credential stops working at once. Set the new one on the replica; its key pin stays.</p>
          )}
          {confirm?.kind === "revoke" && (
            <p>The replica&apos;s polls are refused until you issue a new credential. It keeps the configuration it has.</p>
          )}
          {confirm?.kind === "delete" && (
            <p>The replica, its credential, its key pin and its fleet records are removed. It keeps the configuration it has.</p>
          )}
          {confirmError && (
            <Banner tone="bad" live>
              {confirmError}
            </Banner>
          )}
        </div>
      </AppDialog>

      <IssuedCredentialDialog issued={issued} onClose={() => setIssued(null)} />
    </SectionCard>
  );
}
