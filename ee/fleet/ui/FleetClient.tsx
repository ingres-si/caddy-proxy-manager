// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Activity, ArrowRight, ArrowUp, GitCompare, MoreHorizontal, Pencil, Plus, RefreshCw, RotateCcw, Server, Square, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Label } from "@/components/ui/label";
import { Pagination, useUrlPage } from "@/components/ui/Pagination";
import { SearchField } from "@/components/ui/SearchField";
import { SectionCard } from "@/components/ui/SectionCard";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { StatusDot, type StatusTone } from "@/components/ui/StatusDot";
import { AppDialog } from "@/components/ui/AppDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { DEFAULT_PAGE_SIZE, paginate } from "@/src/lib/pagination";
import type { RevisionDiff } from "@/ee/fleet/revisions";
import type { EnvironmentView, FleetInstanceView, FleetOverview, PullReplicaView, RevisionView, RolloutView } from "@/ee/fleet/types";
import PullReplicasPanel from "@/ee/fleet/ui/PullReplicasPanel";
import { DiffView, EnvironmentDialog, PromoteDialog, jsonInit, readError, requestJson } from "./FleetDialogs";
import { RolloutPanel } from "./RolloutPanel";
import {
  PHASE_LABELS,
  compareVersions,
  formatClock,
  formatVersion,
  formatWhen,
  isBehind,
  joinNames,
  lastDriftCheck,
  nodeConfiguration,
  nodeDrift,
  nodeHealth,
  nodeStorage,
  reportedVersion,
  revisionLabel,
  rolloutTarget,
  sameStorage,
  storageLabel,
} from "./fleet-view";

/** One page of a list the server pages (rollouts, revisions). */
export type ServerPage<T> = { items: T[]; total: number; page: number };

type Props = {
  overview: FleetOverview;
  /** The page of rollouts the table shows (?rollouts=); the overview's latest ones when omitted. */
  rolloutPage?: ServerPage<RolloutView>;
  /** The page of revisions the table shows (?revisions=); the overview's latest ones when omitted. */
  revisionPage?: ServerPage<RevisionView>;
  /** What the user's role allows besides reading (custom roles); everything when omitted. */
  allowed?: { write: boolean; promote: boolean; replicas?: boolean };
  /** When the server read the overview (ISO), so server and browser render the same times. */
  now?: string;
};

type Message = { ok: boolean; text: string };

const NO_ENVIRONMENT = "none";
const ALL = "all";
const POLL_INTERVAL_MS = 5000;
/** Nodes shown in an environment card before "N more". */
const MEMBERS_SHOWN = 12;

const ROLLOUT_OUTCOME: Record<RolloutView["status"], { tone: StatusTone; label: string }> = {
  running: { tone: "info", label: "Running" },
  succeeded: { tone: "ok", label: "Succeeded" },
  failed: { tone: "bad", label: "Failed" },
  aborted: { tone: "off", label: "Aborted" },
};

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Two lines in a table cell: the value, and a caption under it. */
function Cell({ children, note, noteClassName }: { children: ReactNode; note?: ReactNode; noteClassName?: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span>{children}</span>
      {note ? <span className={cn("text-xs text-soft", noteClassName)}>{note}</span> : null}
    </span>
  );
}

const TH = "border-y border-line px-2.5 py-2 text-left text-xs font-medium text-soft first:pl-[18px] last:pr-[18px]";
const TD = "px-2.5 py-3 align-middle first:pl-[18px] last:pr-[18px]";

export default function FleetClient({
  overview,
  rolloutPage,
  revisionPage,
  allowed = { write: true, promote: true, replicas: true },
  now: renderedAt,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<Message | null>(null);
  const [editing, setEditing] = useState<EnvironmentView | "new" | null>(null);
  const [deleting, setDeleting] = useState<EnvironmentView | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [promoting, setPromoting] = useState<EnvironmentView | null>(null);
  const [addingReplica, setAddingReplica] = useState(false);
  const [nodeFilter, setNodeFilter] = useState<string>(ALL);
  const [nodeSearch, setNodeSearch] = useState("");
  const nodePages = useUrlPage("nodes");
  const rolloutPages = useUrlPage("rollouts");
  const revisionPages = useUrlPage("revisions");
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const [against, setAgainst] = useState("previous");
  const [revisionDiff, setRevisionDiff] = useState<RevisionDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [now, setNow] = useState(() => (renderedAt ? Date.parse(renderedAt) : Date.now()));

  const isMaster = overview.mode === "master";
  const { environments, instances, rollouts } = overview;
  const running = useMemo(() => rollouts.filter((rollout) => rollout.status === "running"), [rollouts]);
  const observing = running.some((rollout) => rollout.phase === "observing");
  const environmentById = useMemo(() => new Map(environments.map((environment) => [environment.id, environment])), [environments]);
  const instanceNames = useMemo(() => new Map(instances.map((instance) => [instance.id, instance.name])), [instances]);
  const replicaById = useMemo(() => new Map(overview.pullReplicas.map((replica) => [replica.id, replica])), [overview.pullReplicas]);
  const runningByEnvironment = useMemo(() => new Map(running.map((rollout) => [rollout.environmentId, rollout])), [running]);
  const unassigned = instances.filter((instance) => instance.environmentId === null);
  const nextPosition = environments.reduce((highest, environment) => Math.max(highest, environment.position + 1), 0);
  const latestByEnvironment = useMemo(() => {
    const latest = new Map<number, RolloutView>();
    for (const rollout of rollouts) {
      const current = latest.get(rollout.environmentId);
      if (!current || rollout.id > current.id) latest.set(rollout.environmentId, rollout);
    }
    return latest;
  }, [rollouts]);
  const lastCheck = lastDriftCheck(instances);

  // While a rollout runs, show its progress as it happens.
  useEffect(() => {
    if (running.length === 0) return;
    const timer = setInterval(() => router.refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [running.length, router]);

  // The canary's countdown.
  useEffect(() => {
    if (!observing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [observing]);

  useEffect(() => {
    if (selectedRevision === null) return;
    let cancelled = false;
    setDiffError(null);
    requestJson<RevisionDiff>(`/api/v1/fleet/revisions/${selectedRevision}/diff?against=${encodeURIComponent(against)}`)
      .then((result) => {
        if (!cancelled) setRevisionDiff(result);
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setRevisionDiff(null);
          setDiffError(error.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRevision, against]);

  function run(action: () => Promise<string | null>) {
    setMessage(null);
    startTransition(async () => {
      try {
        const text = await action();
        if (text) setMessage({ ok: true, text });
        router.refresh();
      } catch (error) {
        setMessage({ ok: false, text: (error as Error).message });
      }
    });
  }

  function assign(instance: FleetInstanceView, value: string) {
    const environmentId = value === NO_ENVIRONMENT ? null : Number(value);
    if (environmentId === instance.environmentId) return;
    run(async () => {
      await requestJson(`/api/v1/fleet/instances/${instance.id}/environment`, jsonInit("PUT", { environmentId }));
      return environmentId === null
        ? `Took "${instance.name}" out of its environment.`
        : `Moved "${instance.name}" to "${environmentById.get(environmentId)?.name ?? environmentId}".`;
    });
  }

  function resync(instance: FleetInstanceView) {
    run(async () => {
      const result = await requestJson<{ ok: boolean; error: string | null; revisionId: number | null; pending?: boolean }>(
        `/api/v1/fleet/instances/${instance.id}/resync`,
        { method: "POST" }
      );
      if (!result.ok) throw new Error(`Re-syncing "${instance.name}" failed: ${result.error ?? "unknown error"}`);
      const what = result.revisionId === null ? "the master's configuration" : `revision #${result.revisionId}`;
      return result.pending
        ? `Asked pull replica "${instance.name}" to take ${what} with its next poll.`
        : `Re-synced "${instance.name}" with ${what}. Changes made on it were replaced.`;
    });
  }

  function checkDrift() {
    run(async () => {
      await requestJson("/api/v1/fleet/drift", { method: "POST" });
      return "Checked every enabled replica.";
    });
  }

  function abort(rollout: RolloutView) {
    run(async () => {
      await requestJson(`/api/v1/fleet/rollouts/${rollout.id}/abort`, { method: "POST" });
      return `Aborted rollout #${rollout.id}.`;
    });
  }

  function rollback(rollout: RolloutView) {
    run(async () => {
      const result = await requestJson<RolloutView>(`/api/v1/fleet/rollouts/${rollout.id}/rollback`, { method: "POST" });
      return `Started rollback #${result.id} to revision #${result.revisionId}.`;
    });
  }

  function deleteEnvironment() {
    if (!deleting) return;
    const target = deleting;
    setDeleteError(null);
    startTransition(async () => {
      try {
        const response = await fetch(`/api/v1/fleet/environments/${target.id}`, { method: "DELETE" });
        if (!response.ok) throw new Error(await readError(response));
        setDeleting(null);
        setMessage({ ok: true, text: `Deleted environment "${target.name}".` });
        router.refresh();
      } catch (error) {
        setDeleteError((error as Error).message);
      }
    });
  }

  function showDiff(revisionId: number, base: string) {
    setAgainst(base);
    setSelectedRevision(revisionId);
    requestAnimationFrame(() => document.getElementById("revisions")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  const drifted = instances.filter((instance) => instance.enabled && instance.drift.status === "drifted");

  // ── Nodes table ─────────────────────────────────────────────────────

  const filterOptions = [
    { value: ALL, label: <>All <span className="num text-muted-foreground">{instances.length}</span></>, ariaLabel: `All, ${instances.length}` },
    ...environments.map((environment) => {
      const count = instances.filter((instance) => instance.environmentId === environment.id).length;
      return {
        value: String(environment.id),
        label: (
          <>
            {environment.name} <span className="num text-muted-foreground">{count}</span>
          </>
        ),
        ariaLabel: `${environment.name}, ${count}`,
      };
    }),
    ...(unassigned.length > 0
      ? [
          {
            value: NO_ENVIRONMENT,
            label: (
              <>
                No environment <span className="num text-muted-foreground">{unassigned.length}</span>
              </>
            ),
            ariaLabel: `No environment, ${unassigned.length}`,
          },
        ]
      : []),
  ];
  const filter = filterOptions.some((option) => option.value === nodeFilter) ? nodeFilter : ALL;
  const nodeNeedle = nodeSearch.trim().toLowerCase();
  const shownInstances = instances.filter(
    (instance) =>
      (filter === ALL ? true : filter === NO_ENVIRONMENT ? instance.environmentId === null : instance.environmentId === Number(filter)) &&
      (!nodeNeedle || instance.name.toLowerCase().includes(nodeNeedle) || hostOf(instance.baseUrl).toLowerCase().includes(nodeNeedle))
  );
  const nodePage = paginate(shownInstances, nodePages.page);

  /** A new filter or search starts the nodes on their first page. */
  function firstNodePage() {
    if (nodePages.page > 1) router.replace(nodePages.hrefFor(1), { scroll: false });
  }

  /** Shows the nodes of one environment in the table (the "N more" of an environment card). */
  function showNodesOf(value: string) {
    setNodeFilter(value);
    setNodeSearch("");
    firstNodePage();
    requestAnimationFrame(() => document.getElementById("nodes")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function nodeRow(instance: FleetInstanceView) {
    const environment = instance.environmentId === null ? null : (environmentById.get(instance.environmentId) ?? null);
    const rollout = environment ? (runningByEnvironment.get(environment.id) ?? null) : null;
    const locked = rollout !== null;
    const replica: PullReplicaView | undefined = replicaById.get(instance.id);
    const target = rolloutTarget(rollout, instance.id);
    const isCanary = target?.role === "canary";
    const version = reportedVersion(instance, replica);
    const versionOrder = version ? compareVersions(version, overview.master.version) : null;
    const configuration = nodeConfiguration(instance, environment, rollout);
    const health = nodeHealth(instance, replica, now);
    const drift = nodeDrift(instance, now);
    const behind = isBehind(instance, environment, rollout);
    const storage = nodeStorage(instance, overview);
    const incoming = rollout && target?.status === "pending" ? (overview.revisionStorage[String(rollout.revisionId)] ?? null) : null;
    const attention = drift.attention || behind;
    const canResync = allowed.promote && isMaster && instance.enabled && !locked;
    const showMenu = allowed.write || allowed.promote;
    const syncError = instance.lastSyncError;
    return (
      <tr key={instance.id} className={cn("border-b border-line last:border-b-0", attention ? "bg-warn-tint" : "hover:bg-panel2")}>
        <td className={TD}>
          <Cell
            note={
              <>
                {environment?.name ?? "No environment"}
                {!instance.enabled ? " · disabled" : ""}
              </>
            }
          >
            <span className="font-semibold [overflow-wrap:anywhere]">{instance.name}</span>
          </Cell>
        </td>
        <td className={TD}>
          <span className="flex flex-wrap gap-1">
            <Badge variant="outline">Replica</Badge>
            {isCanary && (
              <Badge variant="info" className="font-semibold">
                Canary
              </Badge>
            )}
          </span>
        </td>
        <td className={TD}>
          {instance.pull ? (
            <Cell
              note={
                <>
                  {instance.pull.pollIntervalSeconds ? (
                    <>
                      every <span className="num">{instance.pull.pollIntervalSeconds} s</span> ·{" "}
                    </>
                  ) : null}
                  {instance.pull.lastSeenAt ? (
                    <>
                      checked in <span className="num">{formatWhen(instance.pull.lastSeenAt, now)}</span>
                    </>
                  ) : (
                    "never checked in"
                  )}
                  {instance.pull.checkIn === "missed" && <span className="text-warn"> (missed polls)</span>}
                </>
              }
            >
              Pull agent
            </Cell>
          ) : (
            <Cell
              note={
                <span className="num" title={instance.baseUrl}>
                  {hostOf(instance.baseUrl)}
                </span>
              }
            >
              Push from master
            </Cell>
          )}
        </td>
        <td className={TD}>
          {version ? (
            <Cell
              note={
                versionOrder === -1 ? (
                  <>
                    master runs <span className="num">{formatVersion(overview.master.version)}</span>
                  </>
                ) : versionOrder === 1 ? (
                  "newer than the master"
                ) : undefined
              }
            >
              <span className={cn("num", versionOrder === -1 && "font-semibold text-warn")}>{formatVersion(version)}</span>
            </Cell>
          ) : (
            <Cell note="not reported">
              <span className="text-soft">—</span>
            </Cell>
          )}
        </td>
        <td className={TD}>
          <Cell
            note={configuration.note}
            noteClassName={configuration.tone === "warn" ? "text-warn" : configuration.tone === "brand" ? "text-brand" : undefined}
          >
            <span className="whitespace-nowrap">
              {configuration.label}
              {configuration.revisionId !== null && (
                <>
                  {" "}
                  <span className="num">#{configuration.revisionId}</span>
                </>
              )}
            </span>
          </Cell>
        </td>
        <td className={TD}>
          <Cell
            note={
              syncError ? (
                <span className="text-bad [overflow-wrap:anywhere]" title={syncError}>
                  {syncError.length > 80 ? `${syncError.slice(0, 79)}…` : syncError}
                </span>
              ) : undefined
            }
          >
            {instance.lastSyncAt ? <span className="num whitespace-nowrap">{formatWhen(instance.lastSyncAt, now)}</span> : <span className="text-soft">Never</span>}
          </Cell>
        </td>
        <td className={TD}>
          <span title={health.title}>
            <Cell note={isCanary && rollout?.phase === "observing" && health.tone === "ok" ? "canary checks passing" : health.note}>
              <StatusDot tone={health.tone} label={health.label} className="whitespace-nowrap" />
            </Cell>
          </span>
        </td>
        <td className={TD}>
          <span title={drift.title}>
            <Cell note={drift.note}>
              <StatusDot tone={drift.tone} label={drift.label} className={cn("whitespace-nowrap", drift.attention && "font-semibold")} />
            </Cell>
          </span>
        </td>
        <td className={TD}>
          {storage ? (
            <Cell
              note={
                incoming && !sameStorage(storage, incoming) ? (
                  <>
                    {storageLabel(storage).note}, until <span className="num">#{rollout?.revisionId}</span> reaches it
                  </>
                ) : (
                  storageLabel(storage).note
                )
              }
            >
              {storageLabel(storage).label}
            </Cell>
          ) : (
            <Cell note="nothing pushed yet">
              <span className="text-soft">—</span>
            </Cell>
          )}
        </td>
        <td className={cn(TD, "text-right")}>
          <span className="flex items-center justify-end gap-1.5">
            {attention && allowed.promote && (
              <Button
                variant="outline"
                size="sm"
                disabled={pending || !canResync}
                onClick={() => resync(instance)}
                title={instance.pull ? "Ask the pull replica to take what it should run with its next poll" : "Push what the replica should run"}
              >
                Re-sync
              </Button>
            )}
            {showMenu && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${instance.name}`} disabled={pending}>
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-56">
                  {allowed.promote && !attention && (
                    <DropdownMenuItem disabled={!canResync} onSelect={() => resync(instance)}>
                      <RefreshCw className="h-4 w-4" /> Re-sync
                    </DropdownMenuItem>
                  )}
                  {allowed.promote && allowed.write && !attention && <DropdownMenuSeparator />}
                  {allowed.write && (
                    <>
                      <DropdownMenuLabel>Environment{locked ? " (a rollout is running)" : ""}</DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={instance.environmentId === null ? NO_ENVIRONMENT : String(instance.environmentId)}
                        onValueChange={(value) => assign(instance, value)}
                      >
                        <DropdownMenuRadioItem value={NO_ENVIRONMENT} disabled={locked}>
                          No environment
                        </DropdownMenuRadioItem>
                        {environments.map((option) => (
                          <DropdownMenuRadioItem
                            key={option.id}
                            value={String(option.id)}
                            disabled={locked}
                          >
                            {option.name}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </span>
        </td>
      </tr>
    );
  }

  // ── Environment cards ───────────────────────────────────────────────

  function memberChip(instance: FleetInstanceView, environment: EnvironmentView | null) {
    const rollout = environment ? (runningByEnvironment.get(environment.id) ?? null) : null;
    const target = rolloutTarget(rollout, instance.id);
    const replica = replicaById.get(instance.id);
    const health = nodeHealth(instance, replica, now);
    const drift = nodeDrift(instance, now);
    const version = reportedVersion(instance, replica);
    let note: string;
    let tone: StatusTone = health.tone;
    let noteClass = "text-muted-foreground";
    if (!instance.enabled) {
      note = "disabled";
    } else if (drift.attention) {
      note = "Drifted";
      tone = "warn";
      noteClass = "text-warn";
    } else if (health.tone === "bad") {
      note = health.label.toLowerCase();
      noteClass = "text-bad";
    } else if (target && rollout) {
      note = `${target.role === "canary" ? "canary" : "replica"} · ${target.status === "synced" ? `#${rollout.revisionId}` : `takes #${rollout.revisionId}`}`;
    } else if (isBehind(instance, environment, rollout)) {
      note = `behind · ${revisionLabel(instance.revisionId)}`;
      tone = "warn";
      noteClass = "text-warn";
    } else if (version && compareVersions(version, overview.master.version) === -1) {
      note = `needs update to ${formatVersion(overview.master.version)}`;
      tone = "warn";
      noteClass = "text-warn";
    } else {
      note = drift.label === "In sync" ? "in sync" : drift.label.toLowerCase();
    }
    return (
      <li key={instance.id} className="inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-lg border border-line bg-panel2 px-2.5 text-xs">
        <StatusDot tone={tone} />
        <span className="num truncate">{instance.name}</span>
        <span className={cn("truncate", noteClass)}>{note}</span>
      </li>
    );
  }

  function environmentCard(environment: EnvironmentView, index: number) {
    const members = instances.filter((instance) => instance.environmentId === environment.id);
    const active = runningByEnvironment.get(environment.id) ?? null;
    const latest = latestByEnvironment.get(environment.id) ?? null;
    const source = index > 0 ? environments[index - 1] : null;
    const headingId = `environment-${environment.id}-title`;
    const pinnedSince =
      environment.revisionId === null
        ? null
        : (rollouts.find(
            (rollout) => rollout.environmentId === environment.id && rollout.status === "succeeded" && rollout.revisionId === environment.revisionId
          )?.finishedAt ?? null);
    const lastSync = members.reduce<string | null>(
      (latestSync, instance) => (instance.lastSyncAt && (!latestSync || instance.lastSyncAt > latestSync) ? instance.lastSyncAt : latestSync),
      null
    );
    return (
      <section
        key={environment.id}
        id={`environment-${environment.id}`}
        aria-labelledby={headingId}
        className={cn(
          "flex min-w-0 scroll-mt-6 flex-col gap-3 rounded-2xl border border-line bg-panel px-[18px] py-4 target:border-brand",
          environment.promotionOnly ? "flex-[1.6_1_420px]" : "flex-[1_1_300px]"
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={headingId} className="m-0 text-base leading-6 font-semibold [overflow-wrap:anywhere]">
            {environment.name}
          </h3>
          {environment.promotionOnly ? (
            <Badge variant="warning" className="font-semibold">
              Promotion only
            </Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              Every change
            </Badge>
          )}
          {environment.promotionOnly && (
            <Badge variant="outline" className="num text-muted-foreground">
              {environment.revisionId === null ? "No revision yet" : `pinned to #${environment.revisionId}`}
            </Badge>
          )}
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            {allowed.write && (
              <>
                <Button variant="ghost" size="sm" disabled={pending} onClick={() => setEditing(environment)}>
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete environment ${environment.name}`}
                  disabled={pending}
                  onClick={() => {
                    setDeleteError(null);
                    setDeleting(environment);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </>
            )}
            {environment.promotionOnly && allowed.promote && (
              <Button
                variant="secondary"
                size="sm"
                disabled={pending || !isMaster || active !== null}
                title={active ? `Rollout #${active.id} is running` : undefined}
                onClick={() => setPromoting(environment)}
              >
                <ArrowUp className="h-3.5 w-3.5" /> {source ? `Promote from ${source.name}` : "Promote from the master"}
              </Button>
            )}
          </span>
        </div>
        {environment.description && <p className="m-0 text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{environment.description}</p>}
        <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(min(110px,100%),1fr))] gap-2.5">
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-soft">Nodes</dt>
            <dd className="num m-0 text-lg leading-[26px]">{members.length}</dd>
          </div>
          {environment.promotionOnly ? (
            <>
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-soft">Pinned revision</dt>
                <dd className="m-0 leading-[26px]">
                  {environment.revisionId === null ? (
                    <span className="text-soft">None yet</span>
                  ) : (
                    <>
                      <span className="num">#{environment.revisionId}</span>
                      {pinnedSince && (
                        <span className="text-xs text-soft">
                          {" "}
                          since <span className="num">{formatWhen(pinnedSince, now)}</span>
                        </span>
                      )}
                    </>
                  )}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-soft">Rollout</dt>
                <dd className="m-0 leading-[26px]">
                  {active ? (
                    <a href={`#rollout-${active.id}`} className="text-brand underline-offset-4 hover:underline">
                      <span className="num">#{active.id}</span> running
                    </a>
                  ) : latest ? (
                    <span className="text-muted-foreground">
                      <span className="num">#{latest.id}</span> {ROLLOUT_OUTCOME[latest.status].label.toLowerCase()}
                    </span>
                  ) : (
                    <span className="text-soft">None yet</span>
                  )}
                </dd>
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-soft">Runs</dt>
                <dd className="m-0 leading-[26px]">Live configuration</dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-soft">Last sync</dt>
                <dd className="num m-0 leading-[26px]">{lastSync ? formatWhen(lastSync, now) : <span className="font-sans text-soft">Never</span>}</dd>
              </div>
            </>
          )}
        </dl>
        <div className="border-t border-line pt-2.5">
          {members.length === 0 ? (
            <p className="m-0 text-[13px] text-soft">No nodes. Move replicas here from the nodes table.</p>
          ) : (
            <ul aria-label={`Nodes in ${environment.name}`} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {members.slice(0, MEMBERS_SHOWN).map((instance) => memberChip(instance, environment))}
              {members.length > MEMBERS_SHOWN && (
                <li>
                  <Button variant="link" size="sm" className="h-[26px] px-1 text-xs" onClick={() => showNodesOf(String(environment.id))}>
                    {members.length - MEMBERS_SHOWN} more
                  </Button>
                </li>
              )}
            </ul>
          )}
        </div>
      </section>
    );
  }

  const revisionList = revisionPage ?? { items: overview.revisions, total: overview.revisions.length, page: 1 };
  const rolloutList = rolloutPage ?? { items: rollouts, total: rollouts.length, page: 1 };
  const againstOptions = [
    { value: "previous", label: "The previous revision" },
    { value: "current", label: "The master's current configuration" },
    ...(against !== "previous" && against !== "current" ? [{ value: against, label: `Revision #${against}` }] : []),
  ];

  return (
    <div className="flex w-full flex-col gap-5">
      <PageHeader
        breadcrumb={["Platform", "Fleet"]}
        title="Fleet"
        className="mb-0"
        actions={
          <>
            {allowed.write && (
              <Button variant="outline" disabled={pending || !isMaster} onClick={checkDrift}>
                <Activity className="h-4 w-4" /> Check drift now
              </Button>
            )}
            {allowed.replicas && (
              <Button variant="outline" disabled={pending || !isMaster} onClick={() => setAddingReplica(true)}>
                Add pull replica
              </Button>
            )}
            {allowed.write && isMaster && (
              <Button onClick={() => setEditing("new")}>
                <Plus className="h-4 w-4" /> New environment
              </Button>
            )}
          </>
        }
      />

      {!isMaster && (
        <Banner tone="info" title="Fleet management works on the master instance.">
          This instance is in {overview.mode} mode, so nothing here is pushed.
        </Banner>
      )}
      {message && (
        <Banner tone={message.ok ? "ok" : "bad"} live onDismiss={() => setMessage(null)}>
          {message.text}
        </Banner>
      )}
      {isMaster &&
        (drifted.length === 1 ? (
          <Banner
            tone="warn"
            title={`${drifted[0].name} no longer runs what this master pushed.`}
            actions={
              allowed.promote ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending || (drifted[0].environmentId !== null && runningByEnvironment.has(drifted[0].environmentId))}
                  onClick={() => resync(drifted[0])}
                >
                  Re-sync {drifted[0].name}
                </Button>
              ) : undefined
            }
          >
            {drifted[0].drift.checkedAt ? `The ${formatClock(drifted[0].drift.checkedAt)} drift check found: ` : ""}
            {(drifted[0].drift.detail ?? "it runs another configuration").replace(/\.$/, "")}. Drift is never repaired automatically.
          </Banner>
        ) : drifted.length > 1 ? (
          <Banner tone="warn" title={`${drifted.length} replicas no longer run what this master pushed.`}>
            {joinNames(drifted.map((instance) => instance.name))}. Drift is never repaired automatically: re-sync them from the nodes table.
          </Banner>
        ) : null)}

      <section aria-labelledby="fleet-environments-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1.5">
          <h2 id="fleet-environments-title" className="m-0 text-base leading-6 font-semibold">
            Environments
          </h2>
          <span className="text-[13px] text-soft">
            In promotion order
            {lastCheck ? (
              <>
                {" "}
                · last drift check <span className="num">{formatClock(lastCheck)}</span>
              </>
            ) : null}
          </span>
        </div>
        {environments.length === 0 ? (
          <div className="rounded-2xl border border-line bg-panel">
            <EmptyState
              icon={Server}
              title="No environments yet"
              description="Create one per stage, for example staging and production."
              action={
                allowed.write && isMaster ? (
                  <Button onClick={() => setEditing("new")}>
                    <Plus className="h-4 w-4" /> New environment
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className="flex flex-wrap items-stretch gap-3">
            {environments.map((environment, index) => (
              <Fragment key={environment.id}>
                {index > 0 && environment.promotionOnly && (
                  <div aria-hidden="true" className="flex flex-none flex-col items-center justify-center gap-1 px-0.5 text-xs text-soft max-sm:w-full max-sm:flex-row">
                    <ArrowRight className="h-5 w-5 max-sm:rotate-90" />
                    <span>promotes to</span>
                  </div>
                )}
                {environmentCard(environment, index)}
              </Fragment>
            ))}
            {unassigned.length > 0 && (
              <section
                aria-labelledby="environment-none-title"
                className="flex min-w-0 flex-[1_1_300px] flex-col gap-3 rounded-2xl border border-dashed border-line2 bg-panel px-[18px] py-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 id="environment-none-title" className="m-0 text-base leading-6 font-semibold">
                    Without an environment
                  </h3>
                  <Badge variant="outline" className="text-muted-foreground">
                    Every change
                  </Badge>
                </div>
                <ul aria-label="Nodes without an environment" className="m-0 flex list-none flex-wrap gap-1.5 border-t border-line p-0 pt-2.5">
                  {unassigned.slice(0, MEMBERS_SHOWN).map((instance) => memberChip(instance, null))}
                  {unassigned.length > MEMBERS_SHOWN && (
                    <li>
                      <Button variant="link" size="sm" className="h-[26px] px-1 text-xs" onClick={() => showNodesOf(NO_ENVIRONMENT)}>
                        {unassigned.length - MEMBERS_SHOWN} more
                      </Button>
                    </li>
                  )}
                </ul>
              </section>
            )}
          </div>
        )}
      </section>

      {running.map((rollout) => {
        const environment = environmentById.get(rollout.environmentId);
        const source = rollout.sourceEnvironmentId === null ? null : (environmentById.get(rollout.sourceEnvironmentId)?.name ?? null);
        return (
          <RolloutPanel
            key={rollout.id}
            rollout={rollout}
            environment={environment}
            sourceName={source}
            instances={instances}
            revision={overview.revisions.find((revision) => revision.id === rollout.revisionId)}
            now={now}
            canAbort={allowed.promote}
            pending={pending}
            onAbort={() => abort(rollout)}
            onShowDiff={() => showDiff(rollout.revisionId, rollout.fromRevisionId === null ? "previous" : String(rollout.fromRevisionId))}
          />
        );
      })}

      <SectionCard id="nodes" title="Nodes" count={instances.length + (isMaster ? 1 : 0)} className="scroll-mt-6">
        {(instances.length > DEFAULT_PAGE_SIZE || (instances.length > 0 && environments.length > 0)) && (
          <div className="flex flex-wrap items-center gap-2.5 px-[18px] py-3">
            {instances.length > DEFAULT_PAGE_SIZE && (
              <SearchField
                aria-label="Filter nodes"
                type="search"
                placeholder="Name or address"
                value={nodeSearch}
                onChange={(event) => {
                  setNodeSearch(event.target.value);
                  firstNodePage();
                }}
                className="min-w-0 max-w-none flex-[1_1_240px] sm:max-w-xs"
              />
            )}
            {instances.length > 0 && environments.length > 0 && (
              <div className="relative max-w-full overflow-x-auto">
                <SegmentedControl
                  label="Environment"
                  size="sm"
                  value={filter}
                  onChange={(value) => {
                    setNodeFilter(value);
                    firstNodePage();
                  }}
                  options={filterOptions}
                />
              </div>
            )}
          </div>
        )}
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[1100px] border-collapse text-[13px]">
            <thead>
              <tr>
                <th scope="col" className={TH}>Node</th>
                <th scope="col" className={TH}>Role</th>
                <th scope="col" className={TH}>How it syncs</th>
                <th scope="col" className={TH}>Version</th>
                <th scope="col" className={TH}>Configuration</th>
                <th scope="col" className={TH}>Last sync (UTC)</th>
                <th scope="col" className={TH}>Health</th>
                <th scope="col" className={TH}>Drift</th>
                <th scope="col" className={TH}>Certificate storage</th>
                <th scope="col" className={TH}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {isMaster && filter === ALL && !nodeNeedle && nodePage.page === 1 && (
                <tr className="border-b border-line last:border-b-0 hover:bg-panel2">
                  <td className={TD}>
                    <Cell note="this dashboard">
                      <span className="font-semibold">Master</span>
                    </Cell>
                  </td>
                  <td className={TD}>
                    <Badge variant="secondary" className="font-semibold text-foreground">
                      Master
                    </Badge>
                  </td>
                  <td className={TD}>
                    <Cell note={overview.pullReplicas.length > 0 ? "pushes to replicas, answers pull replicas" : "pushes to replicas"}>Source</Cell>
                  </td>
                  <td className={TD}>
                    <span className="num">{formatVersion(overview.master.version)}</span>
                  </td>
                  <td className={TD}>
                    <Cell note="applied on save">
                      <span className="whitespace-nowrap">Live configuration</span>
                    </Cell>
                  </td>
                  <td className={TD}>
                    <span className="text-soft">—</span>
                  </td>
                  <td className={TD}>
                    <StatusDot tone="ok" label="Running" />
                  </td>
                  <td className={cn(TD, "text-soft")}>Source</td>
                  <td className={TD}>
                    <Cell note={storageLabel(overview.master.certificateStorage).note}>{storageLabel(overview.master.certificateStorage).label}</Cell>
                  </td>
                  <td className={TD} />
                </tr>
              )}
              {nodePage.items.map((instance) => nodeRow(instance))}
              {instances.length > 0 && shownInstances.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-[18px] py-6 text-center text-muted-foreground">
                    No nodes match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="border-t border-line px-[18px] py-3 empty:hidden">
          <Pagination
            page={nodePage.page}
            perPage={nodePage.perPage}
            total={nodePage.total}
            noun="nodes"
            label="Pages of nodes"
            hrefFor={nodePages.hrefFor}
          />
        </div>
        {instances.length === 0 && (
          <EmptyState
            compact
            icon={Server}
            title="No replicas yet"
            description="Add replicas on the Instance sync page, or add a pull replica for a node this master cannot reach."
            action={
              <Button asChild variant="outline" size="sm">
                <Link href="/instances">Instance sync</Link>
              </Button>
            }
          />
        )}
      </SectionCard>

      <div className="flex flex-wrap items-start gap-5">
        <SectionCard
          title="Rollouts"
          count={rolloutList.total > 0 ? rolloutList.total : null}
          link={{ label: "Revisions", href: "#revisions" }}
          className="flex-[2_1_560px]"
        >
          {rolloutList.total === 0 ? (
            <EmptyState compact title="No rollouts yet" description="Promoting to a promotion-only environment starts one." />
          ) : (
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th scope="col" className={TH}>Rollout</th>
                    <th scope="col" className={TH}>Revision</th>
                    <th scope="col" className={TH}>Outcome</th>
                    <th scope="col" className={TH}>Started (UTC)</th>
                    <th scope="col" className={TH}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rolloutList.items.map((rollout) => {
                    const outcome = ROLLOUT_OUTCOME[rollout.status];
                    const canRollback =
                      rollout.status !== "running" &&
                      allowed.promote &&
                      rollout.fromRevisionId !== null &&
                      latestByEnvironment.get(rollout.environmentId)?.id === rollout.id;
                    return (
                      <tr key={rollout.id} className="border-b border-line last:border-b-0 hover:bg-panel2">
                        <td className={TD}>
                          <Cell note={rollout.environmentName ?? "Deleted environment"}>
                            <span className="num">#{rollout.id}</span>
                          </Cell>
                        </td>
                        <td className={TD}>
                          <Cell note={rollout.kind === "rollback" ? "rollback" : undefined}>
                            <span className="num whitespace-nowrap">
                              {revisionLabel(rollout.fromRevisionId)} → #{rollout.revisionId}
                            </span>
                          </Cell>
                        </td>
                        <td className={TD}>
                          <Cell
                            note={
                              rollout.error && rollout.status !== "aborted" ? (
                                <span className="[overflow-wrap:anywhere]">{rollout.error}</span>
                              ) : rollout.status === "succeeded" && rollout.finishedAt ? (
                                <>
                                  finished <span className="num">{formatWhen(rollout.finishedAt, now)}</span>
                                </>
                              ) : undefined
                            }
                          >
                            <StatusDot
                              tone={outcome.tone}
                              label={rollout.status === "running" ? `${outcome.label} · ${PHASE_LABELS[rollout.phase].toLowerCase()}` : outcome.label}
                              className={cn(rollout.status === "running" && "text-brand")}
                            />
                          </Cell>
                        </td>
                        <td className={TD}>
                          <Cell note={rollout.startedByName ?? (rollout.startedBy === null ? "the system" : undefined)}>
                            <span className="num whitespace-nowrap">{formatWhen(rollout.createdAt, now)}</span>
                          </Cell>
                        </td>
                        <td className={cn(TD, "text-right")}>
                          {rollout.status === "running" && allowed.promote && (
                            <Button variant="ghost" size="sm" disabled={pending} onClick={() => abort(rollout)}>
                              <Square className="h-3.5 w-3.5" /> Abort
                            </Button>
                          )}
                          {canRollback && (
                            <Button variant="ghost" size="sm" disabled={pending || !isMaster} onClick={() => rollback(rollout)}>
                              <RotateCcw className="h-3.5 w-3.5" /> Roll back to #{rollout.fromRevisionId}
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="border-t border-line px-[18px] py-3 empty:hidden">
            <Pagination
              page={rolloutList.page}
              perPage={DEFAULT_PAGE_SIZE}
              total={rolloutList.total}
              noun="rollouts"
              label="Pages of rollouts"
              hrefFor={rolloutPages.hrefFor}
            />
          </div>
        </SectionCard>

        <PullReplicasPanel
          replicas={overview.pullReplicas}
          canManage={allowed.replicas ?? false}
          isMaster={isMaster}
          onChanged={() => router.refresh()}
          showAddButton={false}
          adding={addingReplica}
          onAddingChange={setAddingReplica}
          className="flex-[1_1_320px]"
        />
      </div>

      <SectionCard
        id="revisions"
        title="Revisions"
        count={revisionList.total}
        className="scroll-mt-6"
      >
        {revisionList.total === 0 ? (
          <EmptyState compact title="No revisions yet" description="The first promotion captures one." />
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-[13px]">
              <thead>
                <tr>
                  <th scope="col" className={TH}>Revision</th>
                  <th scope="col" className={TH}>Captured (UTC)</th>
                  <th scope="col" className={TH}>Summary</th>
                  <th scope="col" className={TH}>Fingerprint</th>
                  <th scope="col" className={TH}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {revisionList.items.map((revision) => (
                  <tr
                    key={revision.id}
                    className={cn("border-b border-line last:border-b-0", selectedRevision === revision.id ? "bg-brand-tint" : "hover:bg-panel2")}
                  >
                    <td className={TD}>
                      <span className="num">#{revision.id}</span>
                    </td>
                    <td className={TD}>
                      <Cell note={revision.createdByName ?? undefined}>
                        <span className="num whitespace-nowrap">{formatWhen(revision.createdAt, now)}</span>
                      </Cell>
                    </td>
                    <td className={cn(TD, "[overflow-wrap:anywhere]")}>{revision.summary}</td>
                    <td className={TD}>
                      <span className="num text-xs text-muted-foreground">{revision.fingerprint.slice(0, 12)}</span>
                    </td>
                    <td className={cn(TD, "text-right")}>
                      <Button variant="ghost" size="sm" aria-pressed={selectedRevision === revision.id} onClick={() => showDiff(revision.id, "previous")}>
                        <GitCompare className="h-3.5 w-3.5" /> Changes
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="border-t border-line px-[18px] py-3 empty:hidden">
          <Pagination
            page={revisionList.page}
            perPage={DEFAULT_PAGE_SIZE}
            total={revisionList.total}
            noun="revisions"
            label="Pages of revisions"
            hrefFor={revisionPages.hrefFor}
          />
        </div>
        {selectedRevision !== null && (
          <div className="flex flex-col gap-3 border-t border-line px-[18px] py-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <span className="text-sm font-semibold">
                Revision <span className="num">#{selectedRevision}</span>
              </span>
              <Label htmlFor="fleet-diff-against" className="text-[13px] text-muted-foreground sm:ml-4">
                Compared with
              </Label>
              <Select value={against} onValueChange={setAgainst}>
                <SelectTrigger id="fleet-diff-against" className="sm:max-w-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {againstOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="ghost" size="sm" className="sm:ml-auto" onClick={() => setSelectedRevision(null)}>
                Close
              </Button>
            </div>
            {diffError && (
              <Banner tone="bad" live>
                {diffError}
              </Banner>
            )}
            {revisionDiff && revisionDiff.revision.id === selectedRevision && <DiffView diff={revisionDiff.diff} />}
          </div>
        )}
      </SectionCard>

      <EnvironmentDialog
        open={editing !== null}
        environment={editing === "new" ? null : editing}
        nextPosition={nextPosition}
        canRelease={allowed.promote}
        onClose={() => setEditing(null)}
        onSaved={(text) => {
          setEditing(null);
          setMessage({ ok: true, text });
          router.refresh();
        }}
      />

      <PromoteDialog
        environment={promoting}
        instanceNames={instanceNames}
        onClose={() => setPromoting(null)}
        onStarted={(text) => {
          setPromoting(null);
          setMessage({ ok: true, text });
          router.refresh();
        }}
      />

      <AppDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={deleting ? `Delete environment "${deleting.name}"?` : "Delete environment"}
        submitLabel="Delete"
        onSubmit={deleteEnvironment}
        isSubmitting={pending}
      >
        <div className="space-y-2 text-sm">
          <p>
            Its replicas are left without an environment
            {deleting?.promotionOnly ? " and receive the master's configuration with the next change or sync" : ""}. Its rollouts are deleted.
          </p>
          {deleteError && (
            <Banner tone="bad" live>
              {deleteError}
            </Banner>
          )}
        </div>
      </AppDialog>
    </div>
  );
}
