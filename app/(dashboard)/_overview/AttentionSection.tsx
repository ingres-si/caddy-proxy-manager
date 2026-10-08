"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, CircleAlert, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
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

function itemKey(item: Pick<AttentionItem, "source" | "id">): string {
  return `${item.source}:${item.id}`;
}

/** POST or DELETE /api/v1/overview/attention/dismissals; an error message, or null. */
async function saveDismissal(method: "POST" | "DELETE", item?: Pick<AttentionItem, "source" | "id">): Promise<string | null> {
  try {
    const query = method === "DELETE" && item ? `?${new URLSearchParams({ source: item.source, id: item.id })}` : "";
    const response = await fetch(`/api/v1/overview/attention/dismissals${query}`, {
      method,
      credentials: "same-origin",
      headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: method === "POST" && item ? JSON.stringify({ source: item.source, id: item.id }) : undefined,
    });
    if (response.ok) return null;
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    return json?.error ?? "Could not save. Try again.";
  } catch {
    return "Could not reach the server. Try again.";
  }
}

function AttentionRow({ item, onDismiss, pending }: { item: AttentionItem; onDismiss?: () => void; pending: boolean }) {
  const severity = SEVERITY[item.severity];
  const [first] = item.actions;
  return (
    <li
      className="relative flex items-start gap-3 border-b border-line py-2.5 pr-2.5 pl-3.5 last:border-b-0 md:flex-wrap md:items-center md:gap-x-4 md:gap-y-3 md:px-[18px] md:py-3.5 max-md:has-[a:active]:bg-panel2"
      data-severity={item.severity}
    >
      <span aria-hidden="true" className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-[9px]", severity.box)}>
        <severity.Icon className="h-[18px] w-[18px]" strokeWidth={2} />
      </span>
      <span className="flex min-w-0 flex-1 basis-0 flex-col gap-0.5 md:basis-[360px]">
        <span className="font-semibold text-pretty">
          <span className="sr-only">{severity.label}: </span>
          {item.title}
        </span>
        <span className="text-[13px] leading-[18px] text-muted-foreground text-pretty md:leading-5">{item.detail}</span>
      </span>
      {item.actions.length > 0 && (
        <span className="flex flex-wrap gap-2 max-md:hidden">
          {item.actions.map((action) => (
            <Button key={`${action.route}-${action.label}`} asChild variant="secondary" size="sm">
              <Link href={action.route}>{action.label}</Link>
            </Button>
          ))}
        </span>
      )}
      {first && (
        <>
          {/* On a phone the whole row opens the first action, as Phone.dc.html shows. */}
          <Link href={first.route} aria-label={`${item.title}: ${first.label}`} className="absolute inset-0 md:hidden" />
          {!onDismiss && <ChevronRight aria-hidden="true" className="mt-2 h-4 w-4 shrink-0 text-soft md:hidden" />}
        </>
      )}
      {onDismiss && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="relative shrink-0 max-md:-my-1 max-md:-mr-1"
          disabled={pending}
          onClick={onDismiss}
          aria-label={`Dismiss: ${item.title}`}
          title="Dismiss for 24 hours"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </Button>
      )}
    </li>
  );
}

/**
 * "Needs attention": the items of GET /api/v1/overview/attention for this
 * viewer, most severe first, each with the pages that deal with it. Items
 * marked dismissible (traffic) can be hidden from the viewer's own list for
 * 24 hours (src/lib/attention/dismissals.ts), with Undo right after and
 * "Show dismissed" in the footer.
 */
export function AttentionSection({
  attention,
  alertsHref,
  exclude = [],
  hideWhenEmpty = false,
}: {
  attention: AttentionView;
  /** "Set up alerts" in the title row, for readers of the alerts: these items do not alert by themselves. */
  alertsHref?: string | null;
  /** Sources left out (the first-run page shows the checklist itself). */
  exclude?: readonly string[];
  /** Leave the whole section out when nothing needs attention. */
  hideWhenEmpty?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Dismissed here since the list was loaded; the next load leaves them out itself.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [undoable, setUndoable] = useState<AttentionItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setHidden(new Set()), [attention.generatedAt]);

  const listed = attention.items.filter((item) => !exclude.includes(item.source));
  const items = listed.filter((item) => !hidden.has(itemKey(item)));
  const dismissedCount = attention.dismissed + (listed.length - items.length);
  if (hideWhenEmpty && items.length === 0 && dismissedCount === 0) return null;
  const silent = attention.sources.filter((source) => source.status !== "ok" && !exclude.includes(source.id));
  const count = attention.truncated && listed.length === attention.items.length ? `${items.length}+` : items.length;

  function dismiss(item: AttentionItem) {
    setError(null);
    startTransition(async () => {
      const failure = await saveDismissal("POST", item);
      if (failure) {
        setError(failure);
        return;
      }
      setHidden((previous) => new Set(previous).add(itemKey(item)));
      setUndoable(item);
    });
  }

  function undo(item: AttentionItem) {
    setError(null);
    startTransition(async () => {
      const failure = await saveDismissal("DELETE", item);
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
    });
  }

  function showDismissed() {
    setError(null);
    startTransition(async () => {
      const failure = await saveDismissal("DELETE");
      if (failure) {
        setError(failure);
        return;
      }
      setUndoable(null);
      router.refresh();
    });
  }

  const notes = [
    silent.length > 0
      ? `${joinLabels(silent.map((source) => source.label))} did not answer in time: ${silent.length === 1 ? "its" : "their"} items may be missing.`
      : null,
  ].filter((note): note is string => note !== null);
  return (
    <SectionCard
      title="Needs attention"
      count={items.length > 0 ? count : null}
      link={alertsHref ? { label: "Set up alerts", href: alertsHref } : undefined}
      className="max-md:[&>div:first-child]:px-3.5 max-md:[&>div:first-child]:py-2.5"
      footer={
        notes.length > 0 || dismissedCount > 0 ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-soft">
            {notes.map((note) => (
              <span key={note}>{note}</span>
            ))}
            {dismissedCount > 0 && (
              <span className="flex flex-wrap items-center gap-x-2">
                <span data-testid="attention-dismissed-count">
                  {dismissedCount} dismissed {dismissedCount === 1 ? "item" : "items"}
                </span>
                <Button type="button" variant="link" size="sm" className="h-auto p-0 text-[13px]" disabled={pending} onClick={showDismissed}>
                  Show dismissed
                </Button>
              </span>
            )}
          </span>
        ) : undefined
      }
    >
      {(error || undoable) && (
        <div className="border-b border-line px-3.5 py-2.5 md:px-[18px]">
          {error ? (
            <Banner tone="bad" live onDismiss={() => setError(null)}>
              {error}
            </Banner>
          ) : undoable ? (
            <Banner
              tone="neutral"
              live
              title="Dismissed for 24 hours."
              actions={
                <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => undo(undoable)}>
                  Undo
                </Button>
              }
              onDismiss={() => setUndoable(null)}
              dismissLabel="Close"
            >
              It comes back sooner if it gets worse. Other users still see it.
            </Banner>
          ) : null}
        </div>
      )}
      {items.length === 0 ? (
        <EmptyState
          compact
          icon={CircleCheck}
          title="Nothing needs attention right now"
          className="px-[18px]"
        />
      ) : (
        <ul className="m-0 list-none p-0" data-testid="attention-list">
          {items.map((item) => (
            <AttentionRow key={itemKey(item)} item={item} pending={pending} onDismiss={item.dismissible ? () => dismiss(item) : undefined} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
