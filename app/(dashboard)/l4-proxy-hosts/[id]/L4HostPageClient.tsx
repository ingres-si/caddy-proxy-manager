"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, Layers, Route, Settings2, Shield, type LucideIcon } from "lucide-react";
import type { L4ProxyHost } from "@/src/lib/models/l4-proxy-hosts";
import type { HostChangeEntry } from "@/src/lib/proxy-host-detail";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionCard } from "@/components/ui/SectionCard";
import type { StatusTone } from "@/components/ui/StatusDot";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { L4PortsApplyBanner, type PortsDiff } from "@/components/l4-proxy-hosts/L4PortsApplyBanner";
import { L4HostEditor, type L4EditorData } from "@/src/components/l4-proxy-hosts/editor/L4HostEditor";
import { TabAnchor } from "@/src/components/proxy-hosts/editor/TabAnchor";
import { HostChanges } from "@/src/components/hosts/HostChanges";
import { toggleL4ProxyHostAction } from "../actions";
import { l4DetailGroups, type L4DetailSection } from "../list";
import { l4HostStatus } from "../L4ProxyHostsClient";

const SECTION_ICONS: Record<L4DetailSection, LucideIcon> = {
  routing: Route,
  "load-balancing": Layers,
  security: Shield,
  advanced: Settings2,
};

const BADGE_CLASS: Record<StatusTone, string> = {
  ok: "bg-ok-tint text-ok",
  warn: "bg-warn-tint text-warn",
  bad: "bg-bad-tint text-bad",
  off: "bg-raise text-muted-foreground",
  info: "bg-brand-tint text-brand",
};

const DOT_CLASS: Record<StatusTone, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", off: "bg-soft", info: "bg-brand" };

/** The audit log filtered to the L4 host. */
function l4AuditHref(id: number): string {
  return `/audit-log?entityType=l4_proxy_host&entityId=${id}`;
}

/**
 * An L4 host's page, laid out like a proxy host's: one header and one tab
 * bar. Overview (where it listens, its upstreams and a summary of each
 * setting), the editor's tabs (Routing … Advanced, for roles that may change
 * L4 hosts) and History switch in place (#routing …).
 */
export default function L4HostPageClient({
  host,
  canWrite,
  changes,
  editor,
}: {
  host: L4ProxyHost;
  canWrite: boolean;
  /** null without audit_log:read. */
  changes: { total: number; entries: HostChangeEntry[] } | null;
  /** The editor's data, for roles that may change L4 hosts. */
  editor: L4EditorData | null;
}) {
  const router = useRouter();
  const [toggling, startToggle] = useTransition();
  const [portsDiff, setPortsDiff] = useState<PortsDiff | null>(null);
  const status = l4HostStatus(host, portsDiff);
  const groups = l4DetailGroups(host);

  function toggle() {
    startToggle(async () => {
      const result = await toggleL4ProxyHostAction(host.id, !host.enabled);
      if (result.status === "error") toast.error(result.message ?? "The host could not be changed.");
      else if (result.changeRequest) toast.info(result.message ?? "Submitted for approval", { duration: 10000 });
      else toast.success(host.enabled ? "L4 host disabled." : "L4 host enabled.");
      router.refresh();
    });
  }

  const header = (tabs: ReactNode) => (
    <PageHeader
      className="mb-0"
      breadcrumb={["Traffic", { label: "L4 hosts", href: "/l4-proxy-hosts" }, host.name]}
      title={<span className="[overflow-wrap:anywhere]">{host.name}</span>}
      description={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold", BADGE_CLASS[status.tone])}>
            <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", DOT_CLASS[status.tone])} />
            {status.label}
          </span>
          <span className="num">
            {host.listenAddress}/{host.protocol}
          </span>
          {host.matcherValue.length > 0 && <span className="num text-soft">{host.matcherValue.slice(0, 3).join(", ")}{host.matcherValue.length > 3 && ` and ${host.matcherValue.length - 3} more`}</span>}
          {host.tags.map((tag) => (
            <span key={tag} className="num rounded bg-raise px-1.5 text-[11px] leading-[18px] text-muted-foreground">
              {tag}
            </span>
          ))}
        </span>
      }
      actions={
        canWrite ? (
          <>
            <Button variant="outline" asChild>
              <Link href={`/l4-proxy-hosts/new?from=${host.id}`}>
                <Copy aria-hidden="true" />
                Duplicate
              </Link>
            </Button>
            <Button variant="outline" onClick={toggle} disabled={toggling}>
              {host.enabled ? "Disable" : "Enable"}
            </Button>
          </>
        ) : undefined
      }
    >
      {tabs}
    </PageHeader>
  );

  const overview = (
    <div className="flex min-w-0 flex-col gap-[18px]">
      <L4PortsApplyBanner refreshSignal={Date.parse(host.updatedAt)} canApply={canWrite} hosts={[host]} onDiff={setPortsDiff} />
      <div className="flex flex-wrap items-start gap-5">
        <SectionCard title="Configuration" className="min-w-0 flex-[2_1_560px]">
          <ul className="m-0 list-none p-0">
            {groups.map((group) => {
              const Icon = SECTION_ICONS[group.section];
              return (
                <li key={group.section} className="flex gap-3 border-b border-line px-[18px] py-3.5 last:border-b-0">
                  <span aria-hidden="true" className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg bg-raise text-muted-foreground">
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <span className="font-semibold">{group.title}</span>
                    <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-x-4 gap-y-2.5">
                      {group.items.map((item) => (
                        <div key={item.label} className="flex min-w-0 flex-col gap-px">
                          <dt className="text-xs text-soft">{item.label}</dt>
                          <dd className={cn("m-0 break-words text-[13px]", item.mono && "num")}>{item.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                  {canWrite && (
                    <a href={`#${group.section}`} aria-label={`Edit ${group.title.toLowerCase()}`} className="self-start text-[13px] text-brand underline-offset-4 hover:underline">
                      Edit
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </SectionCard>
        <SectionCard title="Upstreams" count={host.upstreams.length} className="min-w-0 flex-[1_1_320px]" contentClassName="flex flex-col gap-3 px-[18px] py-3.5">
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {host.upstreams.map((upstream) => (
              <li key={upstream} className="num [overflow-wrap:anywhere]">
                {upstream}
              </li>
            ))}
          </ul>
          <p className="m-0 rounded-[10px] bg-panel2 px-3 py-2.5 text-[13px] text-muted-foreground">
            Connections to <span className="num text-foreground">{host.listenAddress}</span> over {host.protocol.toUpperCase()} go{" "}
            {host.upstreams.length > 1 ? "to one of these" : "here"}.
          </p>
        </SectionCard>
      </div>
    </div>
  );

  const history = changes ? <HostChanges changes={changes} auditHref={l4AuditHref(host.id)} /> : null;
  const historyCount = changes ? changes.total : null;

  if (editor) return <L4HostEditor data={editor} workspace={{ header, overview, history, historyCount }} />;
  return <ReadOnlyL4Host header={header} overview={overview} history={history} historyCount={historyCount} />;
}

/** The page for a role that may not change L4 hosts: Overview and History, switched in place. */
function ReadOnlyL4Host({ header, overview, history, historyCount }: { header: (tabs: ReactNode) => ReactNode; overview: ReactNode; history: ReactNode | null; historyCount: number | null }) {
  const [view, setView] = useState<"overview" | "history">("overview");
  useEffect(() => {
    const select = () => setView(window.location.hash === "#history" && history ? "history" : "overview");
    select();
    window.addEventListener("hashchange", select);
    return () => window.removeEventListener("hashchange", select);
  }, [history]);
  const go = (next: "overview" | "history") => {
    setView(next);
    const url = new URL(window.location.href);
    url.hash = next === "overview" ? "" : next;
    window.history.replaceState(window.history.state, "", url.toString());
  };
  const tabs = (
    <nav aria-label="Host sections">
      <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line">
        <TabAnchor id="overview" current={view === "overview"} onSelect={() => go("overview")}>
          Overview
        </TabAnchor>
        {history && (
          <TabAnchor id="history" current={view === "history"} onSelect={() => go("history")}>
            History
            {historyCount !== null && historyCount > 0 && (
              <span className="num rounded-full bg-raise px-1.5 text-[11px] leading-[18px] text-muted-foreground">{historyCount}</span>
            )}
          </TabAnchor>
        )}
      </div>
    </nav>
  );
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {header(tabs)}
      {view === "history" && history ? history : overview}
    </div>
  );
}
