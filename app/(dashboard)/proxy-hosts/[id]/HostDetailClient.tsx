"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlignLeft, BadgeCheck, ExternalLink, Lock, Route, Settings2, Shield, type LucideIcon } from "lucide-react";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import type { HostDetail, HostChangeEntry } from "@/src/lib/proxy-host-detail";
import type { HostAttention } from "@/src/lib/proxy-host-view";
import { primaryDomain, statusText } from "@/src/lib/proxy-host-view";
import type { HostEditorSection } from "@/src/lib/proxy-host-config-summary";
import type { ProxyHostHealth, UpstreamHealth, UpstreamStatus } from "@/src/lib/upstream-health";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionCard } from "@/components/ui/SectionCard";
import { Banner, type BannerTone } from "@/components/ui/Banner";
import { KpiTile } from "@/components/ui/KpiTile";
import { StackedBarChart } from "@/components/ui/StackedBarChart";
import { TopList, type TopListSegment } from "@/components/ui/TopList";
import { DiffView } from "@/components/ui/DiffView";
import { StatusDot, type StatusTone } from "@/components/ui/StatusDot";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { formatBytes, formatCount, formatPercent } from "@/components/ui/chart-format";
import { cn } from "@/lib/utils";
import { toggleProxyHostAction } from "../actions";
import { hostAnalyticsHref, hostAuditHref, HEALTH_CHECKS_TARGET, historyVersionHref, siteUrl } from "../links";
import { HostEditor } from "@/src/components/proxy-hosts/editor/HostEditor";
import { TabAnchor } from "@/src/components/proxy-hosts/editor/TabAnchor";
import type { HostEditorData } from "@/src/components/proxy-hosts/editor/types";
import { CertificateSummary, ProtectionPills, TagChips, useHostStatus } from "../host-parts";
import { ErrorShareLine } from "./ErrorShareLine";

type HostInfo = { id: number; name: string; domains: string[]; enabled: boolean; tags: string[] };

type Allowed = {
  write: boolean;
  analytics: boolean;
  alerts: boolean;
  certificates: boolean;
  auditLog: boolean;
  approvals: boolean;
  /** The security events page (waf:read). */
  security: boolean;
};

const SECTION_ICONS: Record<HostEditorSection, LucideIcon> = {
  routing: Route,
  security: Shield,
  access: Lock,
  certificate: BadgeCheck,
  headers: AlignLeft,
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

const UPSTREAM_TONE: Record<UpstreamStatus, StatusTone> = {
  up: "ok",
  degraded: "warn",
  down: "bad",
  unchecked: "off",
  unknown: "off",
  disabled: "off",
};

const OUTCOME_TEXT: Record<string, string> = {
  waf: "the WAF",
  geo: "geo blocking",
  access: "access rules",
  auth: "sign-in",
  rate_limit: "rate limiting",
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function upstreamText(upstream: UpstreamHealth): string {
  const parts: string[] = [];
  switch (upstream.status) {
    case "up":
      parts.push("No recent failures");
      break;
    case "degraded":
      parts.push(`${plural(upstream.fails ?? 0, "recent failure")}`);
      break;
    case "down":
      parts.push(`Taken out after ${plural(upstream.fails ?? 0, "failure")}`);
      break;
    case "unchecked":
      parts.push("Not checked");
      break;
    case "unknown":
      parts.push(upstream.reported ? "Status unknown" : "Not reported by Caddy");
      break;
    case "disabled":
      parts.push("Host disabled");
      break;
  }
  if (upstream.requestsInFlight) parts.push(`${plural(upstream.requestsInFlight, "request")} in flight`);
  if (upstream.tls) parts.push("TLS to upstream");
  return parts.join(" · ");
}

function HealthChecks({ health, upstreams, canWrite }: { health: ProxyHostHealth; upstreams: number; canWrite: boolean }) {
  const { active, passive, loadBalancing } = health.healthChecks;
  if (!active && !passive) {
    return (
      <div className="flex flex-col gap-1 rounded-[10px] bg-panel2 px-3 py-2.5 text-[13px]">
        <span className="font-semibold">Health checks are off</span>
        {canWrite && (
          <a href={`#${HEALTH_CHECKS_TARGET}`} className="mt-0.5 self-start text-brand underline-offset-4 hover:underline">
            Turn on health checks
          </a>
        )}
      </div>
    );
  }
  const lines: string[] = [];
  if (active) {
    lines.push(
      `Active: GET ${active.path ?? "/"}${active.port ? ` on port ${active.port}` : ""} every ${active.interval ?? "30s"}` +
        `${active.expectStatus ? `, expects ${active.expectStatus}` : ""}.`
    );
  }
  if (passive) {
    lines.push(
      passive.counting
        ? `Passive: taken out after ${plural(Math.max(1, passive.maxFails ?? 1), "failure")} within ${passive.failDuration}.`
        : "Passive: on, but without a fail duration no failures are counted."
    );
  }
  if (loadBalancing && upstreams > 1) lines.push(`Load balancing: ${loadBalancing.policy.replace(/_/g, " ")}.`);
  return (
    <ul className="flex flex-col gap-1 rounded-[10px] bg-panel2 px-3 py-2.5 text-[13px] text-muted-foreground">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

function IncidentBanner({
  item,
  domains,
  allowed,
  time,
}: {
  item: HostAttention;
  domains: string[];
  allowed: Allowed;
  time: (ms: number) => string;
}) {
  const actionClass = "flex h-8 items-center rounded-lg border border-line2 bg-panel px-3 text-[13px] text-foreground hover:bg-raise";
  let tone: BannerTone = item.tone === "bad" ? "bad" : "warn";
  let title: string;
  let body: string;
  const actions: ReactNode[] = [];
  switch (item.kind) {
    case "error_burst": {
      const what = `${plural(item.count, "response")} with ${item.status > 0 ? statusText(item.status) : "a 5xx status"}`;
      title = item.ongoing ? `Ongoing: ${what} since ${time(item.start * 1000)}.` : `Resolved: ${what} at ${time(item.start * 1000)}.`;
      const share = item.requests > 0 ? formatPercent(item.count / item.requests) : null;
      body =
        `Between ${time(item.start * 1000)} and ${time(item.end * 1000)}${share ? `, ${share} of the requests answered with 5xx` : ""}` +
        (item.path ? `; the most frequent was ${item.method ? `${item.method} ` : ""}${item.path}.` : ".") +
        (item.ongoing ? " Check that the upstream is running and reachable from Caddy." : "");
      if (allowed.analytics) {
        actions.push(
          <Link key="requests" href={hostAnalyticsHref(domains, { from: item.start - 60, to: item.end + 60 })} className={actionClass}>
            Show these requests
          </Link>
        );
      }
      if (allowed.alerts) {
        actions.push(
          <Link key="alerts" href="/alerts" className={actionClass}>
            Alert history
          </Link>
        );
      }
      break;
    }
    case "error_rate":
      title = `${formatPercent(item.rate)} of the requests in the last 24 hours answered with 5xx.`;
      body = `${formatCount(item.errors)} of ${formatCount(item.requests)} requests.`;
      if (allowed.analytics) {
        actions.push(
          <Link key="requests" href={hostAnalyticsHref(domains)} className={actionClass}>
            Show the requests
          </Link>
        );
      }
      break;
    case "mitigation_spike":
      title =
        item.factor !== null
          ? `Blocked traffic is ${Math.round(item.factor)} times the usual: ${formatCount(item.count)} requests stopped in 24 hours.`
          : `${formatCount(item.count)} requests stopped in 24 hours, with none in the week before.`;
      body = `Most were stopped by ${OUTCOME_TEXT[item.outcome] ?? item.outcome}.`;
      if (allowed.security) {
        actions.push(
          <Link key="security" href="/security" className={actionClass}>
            Security events
          </Link>
        );
      }
      break;
    case "certificate":
      tone = item.tone === "bad" ? "bad" : "warn";
      title =
        item.state === "expired"
          ? "The certificate has expired."
          : item.state === "overdue"
            ? "Renewing the certificate is failing."
            : `The certificate expires in ${plural(item.daysLeft ?? 0, "day")}.`;
      body =
        item.state === "replace_soon"
          ? "It was imported, so it is not renewed automatically: import a renewed one."
          : "Check Caddy's log for challenge errors, that the domain points at this server and that ports 80 and 443 are reachable.";
      if (allowed.certificates) {
        actions.push(
          <Link key="certificates" href="/certificates" className={actionClass}>
            Certificates
          </Link>
        );
      }
      break;
  }
  return (
    <Banner tone={tone} title={title} actions={actions.length > 0 ? actions : undefined}>
      {body}
    </Banner>
  );
}

function ChangeEntry({ entry, time }: { entry: HostChangeEntry; time: { relative: (v: string) => string; dateTime: (v: string) => string } }) {
  return (
    <li className="flex flex-col gap-2 border-b border-line px-[18px] py-3 last:border-b-0">
      <span className="text-[13px]">
        <span className="font-semibold">{entry.actor ?? "System"}</span> <span className="text-muted-foreground">{entry.summary}</span>
      </span>
      {entry.fields && entry.fields.length > 0 && <DiffView fields={entry.fields} label={`What "${entry.summary}" changed`} />}
      {entry.moreFields > 0 && <span className="text-xs text-soft">and {plural(entry.moreFields, "more field")}</span>}
      <span className="flex flex-wrap gap-3 text-xs text-soft">
        <time dateTime={entry.createdAt} title={time.dateTime(entry.createdAt)} suppressHydrationWarning>
          {time.relative(entry.createdAt)}
        </time>
        {entry.rollbackVersionId !== null && (
          <Link href={historyVersionHref(entry.rollbackVersionId)} className="text-brand underline-offset-4 hover:underline">
            Roll back
          </Link>
        )}
      </span>
    </li>
  );
}

const CLASS_COLORS: [string, string][] = [
  ["2xx", "var(--served)"],
  ["3xx", "var(--served2)"],
  ["4xx", "var(--err4)"],
  ["5xx", "var(--err5)"],
];

/**
 * A proxy host's page: one header and one tab bar for everything about the
 * host. Overview (traffic, upstreams, configuration), the editor's sections
 * (Routing … Advanced, for roles that may change hosts) and History switch in
 * place (#routing …), so looking at a host and changing it never leave the
 * page. Without proxy_hosts:write it has Overview and History only.
 */
export default function HostDetailClient({ host, detail, can: allowed, editor = null }: { host: HostInfo; detail: HostDetail; can: Allowed; editor?: HostEditorData | null }) {
  const router = useRouter();
  const format = useFormat();
  const [toggling, startToggle] = useTransition();
  const { row, traffic, health, changes, config, errorRateAlert } = detail;
  const domain = primaryDomain(row);
  const status = useHostStatus(row);
  const url = siteUrl(host.domains.find((d) => !d.includes("*")), true);
  const time = (ms: number) => format.time(ms);
  const incident = row.attention[0] ?? null;

  function toggle() {
    startToggle(async () => {
      const result = await toggleProxyHostAction(host.id, !host.enabled);
      if (result.status === "error") toast.error(result.message ?? "The host could not be changed.");
      else if (result.changeRequest) toast.info(result.message ?? "Submitted for approval", { duration: 10000 });
      else toast.success(result.message ?? (host.enabled ? "Proxy host disabled." : "Proxy host enabled."));
      router.refresh();
    });
  }

  const otherDomains = host.domains.filter((d) => d !== domain);
  const buckets = traffic ? Array.from({ length: traffic.range.buckets }, (_, i) => (traffic.range.start + i * traffic.range.step) * 1000) : [];
  const served = traffic ? traffic.series.requests.map((value, i) => Math.max(0, value - (traffic.series.errors5xx[i] ?? 0))) : [];
  const statusSegments: TopListSegment[] =
    traffic && traffic.totals.requests > 0
      ? CLASS_COLORS.map(([label, color]) => ({
          label,
          color,
          fraction:
            traffic.statusCodes.filter((code) => Math.floor(code.status / 100) === Number(label[0])).reduce((sum, code) => sum + code.count, 0) /
            traffic.totals.requests,
        })).filter((segment) => segment.fraction > 0)
      : [];

  const header = (tabs: ReactNode) => (
    <PageHeader
      className="mb-0"
      breadcrumb={["Traffic", { label: "Proxy hosts", href: "/proxy-hosts" }, domain]}
      title={<span className="[overflow-wrap:anywhere]">{domain}</span>}
      description={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold", BADGE_CLASS[status.tone])}>
            <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", DOT_CLASS[status.tone])} />
            {status.label}
          </span>
          {row.name !== domain && <span>{row.name}</span>}
          {otherDomains.length > 0 && (
            <span className="text-soft">
              Also <span className="num">{otherDomains.slice(0, 3).join(", ")}</span>
              {otherDomains.length > 3 && ` and ${otherDomains.length - 3} more`}
            </span>
          )}
          {host.tags.length > 0 && <TagChips tags={host.tags} />}
        </span>
      }
      actions={
        <>
          {url && (
            <Button variant="outline" asChild>
              <a href={url} target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden="true" />
                Open site
              </a>
            </Button>
          )}
          {allowed.write && (
            <Button variant="outline" onClick={toggle} disabled={toggling}>
              {host.enabled ? "Disable" : "Enable"}
            </Button>
          )}
        </>
      }
    >
      {tabs}
    </PageHeader>
  );

  const overview = (
    <div className="flex min-w-0 flex-col gap-[18px]">
      {incident && host.enabled && <IncidentBanner item={incident} domains={host.domains} allowed={allowed} time={time} />}
      {host.enabled && (health.status === "down" || health.status === "degraded") && (
        <Banner tone={health.status === "down" ? "bad" : "warn"} title={health.status === "down" ? "Caddy took every upstream out of rotation." : "An upstream is failing."}>
          {health.upstreams
            .filter((upstream) => upstream.status === "down" || upstream.status === "degraded")
            .map((upstream) => `${upstream.dial}: ${plural(upstream.fails ?? 0, "recent failure")}`)
            .join("; ")}
          . Check that the service is running and reachable from Caddy.
        </Banner>
      )}
      {row.pendingChangeRequestId !== null && (
        <Banner
          tone="info"
          title="A change to this host is waiting for approval."
          actions={
            allowed.approvals ? (
              <Link href="/approvals" className="flex h-8 items-center rounded-lg border border-line2 bg-panel px-3 text-[13px] text-foreground hover:bg-raise">
                Approvals
              </Link>
            ) : undefined
          }
        />
      )}

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[2_1_560px] flex-col gap-5">
          {traffic && (
            <SectionCard
              title="Last 24 hours"
              link={allowed.analytics ? { label: "Analytics for this host", href: hostAnalyticsHref(host.domains) } : undefined}
              divided={false}
              contentClassName="flex flex-col gap-4 px-5 pb-4"
            >
              {traffic.status !== "ok" ? (
                <EmptyState
                  compact
                  icon={null}
                  title={traffic.status === "disabled" ? "Traffic analytics is off" : "Traffic could not be read"}
                  description={traffic.status === "disabled" ? "Set up ClickHouse to record requests." : "ClickHouse did not answer."}
                />
              ) : (
                <>
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(min(150px,100%),1fr))] gap-3">
                    <KpiTile label="Requests" value={formatCount(traffic.totals.requests)} color="var(--served)" />
                    <KpiTile
                      label="5xx"
                      value={formatCount(traffic.totals.errors5xx)}
                      color="var(--err5)"
                      note={`${formatPercent(traffic.totals.errorRate5xx)} of requests`}
                    />
                    <KpiTile label="Clients" value={formatCount(traffic.totals.clients)} />
                    <KpiTile label="Bandwidth" value={formatBytes(traffic.totals.bytes)} />
                  </div>
                  <StackedBarChart
                    title="Requests per 30 minutes, served and 5xx"
                    buckets={buckets}
                    stepSeconds={traffic.range.step}
                    series={[
                      { key: "served", label: "Served", color: "var(--served)", values: served },
                      { key: "5xx", label: "5xx", color: "var(--err5)", values: traffic.series.errors5xx },
                    ]}
                    formatValue={formatCount}
                    height={140}
                    xTicks={5}
                    emptyText="No requests in the last 24 hours."
                  />
                  {traffic.totals.requests > 0 && (
                    <ErrorShareLine
                      buckets={buckets}
                      stepSeconds={traffic.range.step}
                      requests={traffic.series.requests}
                      errors={traffic.series.errors5xx}
                      thresholdPercent={errorRateAlert?.thresholdPercent ?? null}
                    />
                  )}
                </>
              )}
            </SectionCard>
          )}

          <div className="flex flex-wrap gap-5">
            <SectionCard title="Upstreams" count={health.upstreams.length} className="flex-[1_1_320px]" contentClassName="flex flex-col gap-3 px-[18px] py-3.5">
              {!health.caddyReachable && (
                <p className="m-0 text-[13px] text-muted-foreground">Caddy did not answer: the upstreams&apos; state is unknown.</p>
              )}
              <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
                {health.upstreams.map((upstream) => (
                  <li key={upstream.upstream} className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                    <StatusDot tone={UPSTREAM_TONE[upstream.status]} />
                    <span className="num min-w-0 flex-1 [overflow-wrap:anywhere]">{upstream.upstream}</span>
                    <span className="text-[13px] text-muted-foreground">{upstreamText(upstream)}</span>
                  </li>
                ))}
              </ul>
              <HealthChecks health={health} upstreams={health.upstreams.length} canWrite={allowed.write} />
            </SectionCard>

            {traffic && (
              <SectionCard title="Where requests go" className="flex-[1_1_320px]" contentClassName="flex flex-col gap-2 py-2">
                {traffic.status === "ok" && traffic.topPaths.length > 0 ? (
                  <>
                    <TopList
                      framed={false}
                      mono
                      dimension="Path"
                      rows={traffic.topPaths.map((path) => {
                        const errors = path.statuses.find((entry) => entry.status >= 500);
                        return {
                          key: path.path,
                          label: path.path || "/",
                          count: path.count,
                          tag: errors ? `${formatCount(errors.count)} × ${errors.status}` : path.mitigated > 0 ? `${formatCount(path.mitigated)} stopped` : undefined,
                        };
                      })}
                      total={traffic.totals.requests}
                      formatCount={formatCount}
                      segments={statusSegments}
                    />
                    <p className="m-0 flex flex-wrap gap-x-3.5 gap-y-1 border-t border-line px-[18px] pt-2 text-xs text-muted-foreground">
                      {traffic.statusCodes.slice(0, 5).map((code) => (
                        <span key={code.status}>
                          <span className="num">{formatCount(code.count)}</span>{" "}
                          {code.status === 499 ? "closed by the client" : <>× <span className="num">{code.status}</span></>}
                        </span>
                      ))}
                    </p>
                  </>
                ) : (
                  <p className="m-0 px-[18px] py-2 text-[13px] text-soft">
                    {traffic.status === "ok" ? "No requests in the last 24 hours." : "No traffic data."}
                  </p>
                )}
              </SectionCard>
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-[1_1_340px] flex-col gap-5">
          <SectionCard title="Configuration">
            <ul className="m-0 list-none p-0">
              {config.map((entry) => {
                const Icon = SECTION_ICONS[entry.section];
                return (
                  <li key={entry.section} className="flex gap-3 border-b border-line px-[18px] py-3.5 last:border-b-0">
                    <span aria-hidden="true" className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg bg-raise text-muted-foreground">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="font-semibold">{entry.title}</span>
                      <span className="text-[13px] text-muted-foreground">{entry.summary}</span>
                      {entry.section === "security" && <ProtectionPills protections={row.protections} className="mt-1" />}
                      {entry.section === "certificate" && (
                        <span className="mt-1 text-[13px]">
                          <CertificateSummary certificate={row.certificate} />
                        </span>
                      )}
                    </span>
                    {allowed.write && (
                      <a
                        href={`#${entry.section}`}
                        aria-label={`Edit ${entry.title.toLowerCase()}`}
                        className="self-start text-[13px] text-brand underline-offset-4 hover:underline"
                      >
                        Edit
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          </SectionCard>
        </div>
      </div>
    </div>
  );

  const history =
    allowed.auditLog && changes ? (
      <SectionCard title="Changes to this host" count={changes.total > 0 ? changes.total : null} link={{ label: "Open in the audit log", href: hostAuditHref(host.id) }}>
        {changes.entries.length === 0 ? (
          <p className="m-0 px-[18px] py-3.5 text-[13px] text-soft">No changes recorded yet.</p>
        ) : (
          <ol className="m-0 list-none p-0">
            {changes.entries.map((entry) => (
              <ChangeEntry key={entry.id} entry={entry} time={{ relative: (v) => format.relative(v), dateTime: (v) => format.dateTime(v) }} />
            ))}
          </ol>
        )}
      </SectionCard>
    ) : null;
  const historyCount = changes ? changes.total : null;

  if (editor) {
    return <HostEditor data={editor} workspace={{ header, overview, history, historyCount }} />;
  }
  return <ReadOnlyHost header={header} overview={overview} history={history} historyCount={historyCount} />;
}

/** The page for a role that may not change hosts: Overview and History, switched in place. */
function ReadOnlyHost({ header, overview, history, historyCount }: { header: (tabs: ReactNode) => ReactNode; overview: ReactNode; history: ReactNode | null; historyCount: number | null }) {
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
