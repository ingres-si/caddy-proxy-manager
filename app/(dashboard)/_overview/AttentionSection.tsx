"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { BellOff, ChevronRight, CircleAlert, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { cn } from "@/lib/utils";
import type { AttentionItem, AttentionSeverity, AttentionView } from "@/src/lib/attention/types";

const SEVERITY: Record<AttentionSeverity, { label: string; Icon: LucideIcon; box: string }> = {
  critical: { label: "Critical", Icon: CircleAlert, box: "bg-bad-tint text-bad" },
  warning: { label: "Warning", Icon: TriangleAlert, box: "bg-warn-tint text-warn" },
  info: { label: "Information", Icon: Info, box: "bg-brand-tint text-brand" },
};

function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

const itemKey = (item: AttentionItem) => `${item.source}:${item.id}`;

async function errorOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : "The change could not be saved";
}

/** Dismisses an alert until it resolves (POST /api/v1/alert-silences); the dismissal's id, or an error. */
async function dismissIssue(issue: NonNullable<AttentionItem["issue"]>): Promise<{ id: number } | { error: string }> {
  try {
    const response = await fetch("/api/v1/alert-silences", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ruleId: issue.ruleId, subjectKey: issue.subjectKey }),
    });
    if (!response.ok) return { error: await errorOf(response) };
    const body = (await response.json()) as { id: number };
    return { id: body.id };
  } catch {
    return { error: "The change could not be saved" };
  }
}

async function undoDismissal(id: number): Promise<string | null> {
  try {
    const response = await fetch(`/api/v1/alert-silences/${id}`, { method: "DELETE", credentials: "same-origin" });
    return response.ok || response.status === 404 ? null : await errorOf(response);
  } catch {
    return "The change could not be saved";
  }
}

function AttentionRow({ item, onDismiss, pending }: { item: AttentionItem; onDismiss?: () => void; pending: boolean }) {
  const severity = SEVERITY[item.severity];
  const [first] = item.actions;
  return (
    <li
      className="relative flex items-start gap-3 border-b border-line py-2.5 pr-2.5 pl-3.5 last:border-b-0 md:items-center md:gap-4 md:px-[18px] md:py-3.5 max-md:has-[a:active]:bg-panel2"
      data-severity={item.severity}
    >
      <span aria-hidden="true" className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-[9px]", severity.box)}>
        <severity.Icon className="h-[18px] w-[18px]" strokeWidth={2} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-semibold text-pretty">
          <span className="sr-only">{severity.label}: </span>
          {item.title}
        </span>
        <span className="text-[13px] leading-[18px] text-muted-foreground text-pretty md:leading-5">{item.detail}</span>
      </span>
      {/* The actions and the dismiss button stay together, so they wrap as one group. */}
      <span className="flex shrink-0 items-center gap-2">
        {item.actions.length > 0 && (
          <span className="flex flex-wrap justify-end gap-2 max-md:hidden">
            {item.actions.map((action) => (
              <Button key={`${action.route}-${action.label}`} asChild variant="secondary" size="sm">
                <Link href={action.route}>{action.label}</Link>
              </Button>
            ))}
          </span>
        )}
        {onDismiss && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="relative z-10 h-8 w-8 text-muted-foreground"
            title="Dismiss until it resolves"
            aria-label={`Dismiss until it resolves: ${item.title}`}
            disabled={pending}
            onClick={onDismiss}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
        {first && <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-soft md:hidden" />}
      </span>
      {/* On a phone the whole row opens the first action. */}
      {first && <Link href={first.route} aria-label={`${item.title}: ${first.label}`} className="absolute inset-0 md:hidden" />}
    </li>
  );
}

/**
 * "Needs attention": the items of GET /api/v1/overview/attention for this
 * viewer, most severe first, each with the pages that deal with it. Alerts
 * (items with an `issue`) can be dismissed until they resolve by readers who
 * may change alerts, for everyone, with Undo right after.
 */
export function AttentionSection({
  attention,
  alertsHref,
  canDismiss = false,
  exclude = [],
  hideWhenEmpty = false,
}: {
  attention: AttentionView;
  /** "Alerts" in the title row, for readers of the alerts. */
  alertsHref?: string | null;
  /** alerts:write: dismiss alerts, and the footer offers adding a channel when nobody is notified. */
  canDismiss?: boolean;
  /** Sources left out (the first-run page shows the checklist itself). */
  exclude?: readonly string[];
  /** Leave the whole section out when nothing needs attention. */
  hideWhenEmpty?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Dismissed here since the list was loaded; the next load leaves them out itself.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [undoable, setUndoable] = useState<{ item: AttentionItem; silenceId: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setHidden(new Set()), [attention.generatedAt]);

  const listed = attention.items.filter((item) => !exclude.includes(item.source));
  const items = listed.filter((item) => !hidden.has(itemKey(item)));
  if (hideWhenEmpty && items.length === 0 && !undoable) return null;
  const silent = attention.sources.filter((source) => source.status !== "ok" && !exclude.includes(source.id));
  const count = attention.truncated && listed.length === attention.items.length ? `${items.length}+` : items.length;
  const unsent = attention.notifying === false && items.some((item) => item.issue);

  function dismiss(item: AttentionItem) {
    if (!item.issue) return;
    const issue = item.issue;
    setError(null);
    startTransition(async () => {
      const result = await dismissIssue(issue);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setHidden((previous) => new Set(previous).add(itemKey(item)));
      setUndoable({ item, silenceId: result.id });
    });
  }

  function undo() {
    if (!undoable) return;
    const { item, silenceId } = undoable;
    setError(null);
    startTransition(async () => {
      const failure = await undoDismissal(silenceId);
      if (failure) {
        setError(failure);
        return;
      }
      setHidden((previous) => {
        const next = new Set(previous);
        next.delete(itemKey(item));
        return next;
      });
      setUndoable(null);
      router.refresh();
    });
  }

  return (
    <SectionCard
      title="Needs attention"
      count={items.length > 0 ? count : null}
      link={alertsHref ? { label: "Alerts", href: alertsHref } : undefined}
      className="max-md:[&>div:first-child]:px-3.5 max-md:[&>div:first-child]:py-2.5"
      footer={
        silent.length > 0 || unsent ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-soft">
            {silent.length > 0 && (
              <span>
                {joinLabels(silent.map((source) => source.label))} did not answer in time: {silent.length === 1 ? "its" : "their"} items may be missing.
              </span>
            )}
            {unsent && (
              <span className="flex flex-wrap items-center gap-x-1.5" data-testid="attention-unsent">
                <BellOff aria-hidden="true" className="h-3.5 w-3.5" />
                <span>Alerts are not sent anywhere.</span>
                {canDismiss && (
                  <Link href="/alerts?tab=channels" className="font-medium text-brand hover:underline">
                    Add a channel
                  </Link>
                )}
              </span>
            )}
          </span>
        ) : undefined
      }
    >
      {undoable && (
        <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-panel2 px-3.5 py-2 text-[13px] md:px-[18px]">
          <span className="min-w-0 flex-1 text-muted-foreground">Dismissed for everyone until it resolves. It stays on the Alerts page.</span>
          <Button type="button" variant="link" size="sm" className="h-auto p-0 text-[13px]" disabled={pending} onClick={undo}>
            Undo
          </Button>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label="Close" onClick={() => setUndoable(null)}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      {error && (
        <div role="alert" className="border-b border-line px-3.5 py-2 text-[13px] text-bad md:px-[18px]">
          {error}
        </div>
      )}
      {items.length === 0 ? (
        <EmptyState compact icon={CircleCheck} title="Nothing needs attention right now" className="px-[18px]" />
      ) : (
        <ul className="m-0 list-none p-0" data-testid="attention-list">
          {items.map((item) => (
            <AttentionRow
              key={itemKey(item)}
              item={item}
              pending={pending}
              onDismiss={canDismiss && item.issue ? () => dismiss(item) : undefined}
            />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
