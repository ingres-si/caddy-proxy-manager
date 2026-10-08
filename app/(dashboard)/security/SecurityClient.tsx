"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ShieldOff, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionCard } from "@/components/ui/SectionCard";
import { Sparkline } from "@/components/ui/Sparkline";
import { StackedBarChart } from "@/components/ui/StackedBarChart";
import { StatusDot } from "@/components/ui/StatusDot";
import { DELTA_TONE_CLASS } from "@/components/ui/KpiTile";
import { formatBucketTime, formatChange, formatCompact, formatCount, formatPercent } from "@/components/ui/chart-format";
import { ruleIdError } from "@/src/lib/waf-exclusions";
import TuningSuggestions from "@/ee/ai/ui/TuningSuggestions";
import { EMPTY_EXCLUSION_DRAFT, WafExclusionDialog, type WafExclusionDraft } from "../waf/WafExclusionDialog";
import { BlockSourceDialog, type BlockTarget } from "./BlockSourceDialog";
import { RangeControl } from "./RangeControl";
import { SecurityEvents } from "./SecurityEvents";
import type { RuleSetStatus, SecurityPageData, SecurityRuleView } from "./security-types";
import {
  SECURITY_SOURCES,
  SOURCE_COLORS,
  SOURCE_LABELS,
  eventTime,
  relativeTime,
  securityHref,
  withFilter,
  type SecuritySourceKey,
} from "./security-view";

const plural = (count: number, word: string, many = `${word}s`) => `${formatCount(count)} ${count === 1 ? word : many}`;

/** "3 hours", "30 minutes", "1 day": a bucket's length. */
function duration(seconds: number): string {
  if (seconds % 86_400 === 0) return plural(seconds / 86_400, "day");
  if (seconds % 3600 === 0) return plural(seconds / 3600, "hour");
  return plural(Math.round(seconds / 60), "minute");
}

/** "a, b and c". */
function sentenceList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const SOURCE_PHRASES: Record<SecuritySourceKey, string> = {
  waf: "by the WAF",
  geo: "by geo rules",
  access: "by access lists",
  auth: "sent to sign-in",
  rate_limit: "by rate limits",
};

// ── Rule set ────────────────────────────────────────────────────────────

function ruleSetTone(ruleSet: RuleSetStatus): "ok" | "warn" | "off" {
  if (ruleSet.blocking > 0) return "ok";
  if (ruleSet.detecting > 0) return "warn";
  return "off";
}

function hostModes(ruleSet: RuleSetStatus): string {
  const parts: string[] = [];
  if (ruleSet.blocking > 0) parts.push(`Blocking on ${plural(ruleSet.blocking, "host")}`);
  if (ruleSet.detecting > 0) parts.push(`${parts.length > 0 ? "detection only" : "Detection only"} on ${plural(ruleSet.detecting, "host")}`);
  return parts.length > 0 ? parts.join(", ") : "No host uses the WAF";
}

function RuleSetStrip({ ruleSet }: { ruleSet: RuleSetStatus }) {
  const using = ruleSet.blocking + ruleSet.detecting > 0;
  return (
    <section
      aria-label="WAF rule set"
      className="flex flex-wrap items-center gap-x-[18px] gap-y-2 rounded-xl border border-line bg-panel px-3.5 py-2.5 text-[13px] text-muted-foreground"
    >
      <StatusDot
        tone={ruleSetTone(ruleSet)}
        label={ruleSet.crsLoaded ? `OWASP Core Rule Set ${ruleSet.crsVersion}` : "Custom rules only (no Core Rule Set)"}
        className={cn(ruleSetTone(ruleSet) !== "ok" && "text-foreground")}
      />
      {ruleSet.crsLoaded && (
        <>
          <span>
            Paranoia level <span className="num">{ruleSet.paranoiaLevel}</span>
          </span>
          <span>
            Anomaly threshold <span className="num">{ruleSet.inboundThreshold}</span>
          </span>
        </>
      )}
      <span>{using ? hostModes(ruleSet) : `The WAF is off on all ${plural(ruleSet.hosts, "host")}`}</span>
      <span>{plural(ruleSet.exclusions, "rule exclusion")}</span>
      <Link href="/waf" className="ml-auto text-brand underline-offset-4 hover:text-foreground hover:underline">
        {using ? "Rule set and exclusions" : "Turn on the WAF"}
      </Link>
    </section>
  );
}

// ── Mitigated summary ───────────────────────────────────────────────────

function MitigatedSummary({ data }: { data: SecurityPageData }) {
  const { summary, range, query } = data;
  const total = summary.mitigated;
  const change = formatChange(total, summary.previousMitigated, "down");
  const present = SECURITY_SOURCES.filter((key) => summary.bySource[key] > 0);
  const topSource = data.sources.list[0];
  const topHost = data.hosts.list[0];
  const titleId = "security-mitigated-title";

  return (
    <div className="flex flex-wrap gap-3">
      <section
        aria-labelledby={titleId}
        className="flex min-w-0 flex-[2_1_520px] flex-col gap-3.5 rounded-xl border border-line bg-panel px-[18px] py-4"
      >
        <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1.5">
          <h2 id={titleId} className="m-0 text-[13px] font-medium text-muted-foreground">
            Mitigated requests, {range.label}
          </h2>
          <span className="num text-[30px] font-medium leading-9 tracking-[-0.02em]">{formatCount(total)}</span>
          <span className="text-[13px] text-soft">
            <span className="num">{formatPercent(summary.share)}</span> of {formatCompact(summary.requests)} requests
            {summary.previousMitigated === null ? (
              " · nothing earlier to compare with"
            ) : (
              <>
                {" · "}
                <span className={cn("num font-semibold", DELTA_TONE_CLASS[change.tone])}>{change.text}</span> vs {range.previousLabel}
              </>
            )}
          </span>
        </div>
        {total > 0 ? (
          <div aria-hidden="true" className="flex h-3.5 gap-0.5 overflow-hidden rounded">
            {present.map((key) => (
              <div key={key} style={{ width: `${(summary.bySource[key] / total) * 100}%`, background: SOURCE_COLORS[key] }} />
            ))}
          </div>
        ) : (
          <div aria-hidden="true" className="h-3.5 rounded bg-raise" />
        )}
        <ul className="m-0 grid list-none gap-2.5 p-0 [grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr))]">
          {SECURITY_SOURCES.map((key) => {
            const count = summary.bySource[key];
            return (
              <li key={key} className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <span aria-hidden="true" className="size-2.5 rounded-[3px]" style={{ background: SOURCE_COLORS[key] }} />
                  {SOURCE_LABELS[key]}
                </span>
                {key === "rate_limit" && count === 0 && !data.rateLimitInUse ? (
                  <span className="text-[13px] text-soft">
                    No rules yet
                    {data.permissions.canReadSettings && (
                      <>
                        {" · "}
                        <Link href="/rate-limiting" className="text-brand hover:text-foreground">
                          Add one
                        </Link>
                      </>
                    )}
                  </span>
                ) : (
                  <span className="num text-lg">
                    {formatCount(count)} <span className="text-xs text-soft">{total > 0 ? formatPercent(count / total) : "–"}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-1.5 rounded-xl border border-line bg-panel px-[18px] py-4">
        <span className="text-[13px] text-muted-foreground">Source addresses</span>
        <span className="num text-[26px] font-medium leading-8">{formatCount(data.sources.total)}</span>
        <span className="text-xs text-soft">
          {plural(data.rules.matched, "WAF rule")} matched
          {topSource ? ` · top address sent ${formatCount(topSource.wafEvents + topSource.otherMitigated)}` : ""}
        </span>
      </div>

      <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-1.5 rounded-xl border border-line bg-panel px-[18px] py-4">
        <span className="text-[13px] text-muted-foreground">Most targeted host</span>
        {topHost ? (
          <>
            <Link
              href={securityHref(query, { filters: withFilter(query, { dim: "host", op: "is", value: topHost.host }) }, "#events")}
              className="truncate text-lg font-semibold leading-8 text-foreground hover:text-brand"
              title={`Show the events of ${topHost.host}`}
            >
              {topHost.host}
            </Link>
            <span className="text-xs text-soft">
              <span className="num">{formatCount(topHost.events)}</span> events
              {data.hosts.total > 0 ? ` · ${formatPercent(topHost.events / data.hosts.total)} of all` : ""}
            </span>
          </>
        ) : (
          <span className="text-lg leading-8 text-soft">None</span>
        )}
      </div>
    </div>
  );
}

// ── Chart ───────────────────────────────────────────────────────────────

function PeakNote({ data }: { data: SecurityPageData }) {
  const { peak, range, query } = data;
  if (!peak) return null;
  const what = SECURITY_SOURCES.filter((key) => (peak.bySource[key] ?? 0) > 0).map((key) => `${formatCount(peak.bySource[key] ?? 0)} ${SOURCE_PHRASES[key]}`);
  const sentences = [`${sentenceList(what)} in ${duration(range.step)}.`];
  const top = peak.top;
  if (top?.source) {
    sentences.push(
      top.addresses <= 1
        ? `All from ${top.source.ip} (${top.source.country}).`
        : `${formatCount(top.addresses)} source addresses; the busiest, ${top.source.ip} (${top.source.country}), sent ${formatCount(top.source.count)}.`
    );
  }
  if (top?.host) sentences.push(`Most went to ${top.host.name} (${formatCount(top.host.count)}).`);
  if (top?.rule) sentences.push(`The WAF rule matched most was ${top.rule.ruleId}${top.rule.message ? `, ${top.rule.message}` : ""} (${formatCount(top.rule.count)}).`);
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border border-line2 bg-panel2 px-3 py-2.5 text-xs">
      <span className="text-[13px] font-semibold">
        Peak: {formatBucketTime(peak.ts * 1000, range.step, true)} UTC · {plural(peak.value, "request")} stopped
      </span>
      <span className="text-muted-foreground">{sentences.join(" ")}</span>
      <Link
        href={securityHref(query, { range: "custom", from: peak.ts, to: peak.ts + range.step }, "#events")}
        className="self-start text-[13px] text-brand underline-offset-4 hover:text-foreground hover:underline"
      >
        Show these events
      </Link>
    </div>
  );
}

function MitigationChart({ data }: { data: SecurityPageData }) {
  const { range, peak } = data;
  const buckets = useMemo(() => Array.from({ length: range.buckets }, (_, i) => (range.start + i * range.step) * 1000), [range]);
  const series = data.series.map((entry) => ({ key: entry.key, label: SOURCE_LABELS[entry.key], color: SOURCE_COLORS[entry.key], values: entry.values }));
  const title = `Mitigated requests by source, ${range.label}`;
  return (
    <SectionCard title={title} divided={false} className="relative" contentClassName="flex flex-col gap-3 px-5 pb-3.5">
      <PeakNote data={data} />
      <StackedBarChart
        title={title}
        buckets={buckets}
        stepSeconds={range.step}
        series={series}
        annotations={
          peak
            ? [{ index: peak.index, label: `Peak · ${formatCompact(peak.value)}`, href: securityHref(data.query, { range: "custom", from: peak.ts, to: peak.ts + range.step }, "#events") }]
            : []
        }
        height={220}
        emptyText="Nothing was stopped in this range."
      />
    </SectionCard>
  );
}

// ── Top rules and sources ───────────────────────────────────────────────

function ruleWhere(rule: SecurityRuleView): string {
  const paths = rule.paths.slice(0, 3).map((entry) => entry.path).filter(Boolean);
  const more = rule.pathCount > paths.length ? ` and ${formatCount(rule.pathCount - paths.length)} more` : "";
  const hosts = rule.hostCount === 1 && rule.hosts[0] ? rule.hosts[0].host : plural(rule.hostCount, "host");
  return [paths.length > 0 ? `${paths.join(", ")}${more}` : null, hosts].filter(Boolean).join(" · ");
}

function TopRules({
  data,
  onAddExclusion,
}: {
  data: SecurityPageData;
  onAddExclusion: (draft: WafExclusionDraft) => void;
}) {
  const { rules, query, permissions } = data;
  return (
    <SectionCard
      title="Top rules"
      description={plural(rules.matched, "rule") + " matched"}
      footer={!permissions.canWriteWaf && rules.list.length > 0 ? <span className="text-soft">Adding an exclusion needs the waf:write permission.</span> : undefined}
    >
      {rules.list.length === 0 ? (
        <EmptyState
          compact
          icon={ShieldOff}
          title="No WAF rule matched"
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/waf">WAF settings</Link>
            </Button>
          }
        />
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-xs text-soft">
                <th scope="col" className="px-[18px] py-2 font-medium">Rule</th>
                <th scope="col" className="px-2.5 py-2 font-medium">Trend</th>
                <th scope="col" className="whitespace-nowrap px-2.5 py-2 text-right font-medium">Events</th>
                <th scope="col" className="py-2 pl-2.5 pr-[18px]"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rules.list.map((rule) => {
                const logged = rule.events - rule.blocked;
                // The rules that decide blocking (949110 and friends) cannot be excluded.
                const notExcludable = ruleIdError(rule.ruleId);
                return (
                  <tr key={rule.ruleId} className="border-b border-line last:border-b-0 hover:bg-panel2">
                    <td className="w-full max-w-0 px-[18px] py-2.5">
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="num rounded bg-raise px-1.5 text-xs leading-[18px] text-muted-foreground">{rule.ruleId}</span>
                          {rule.category && (
                            <span className="rounded-full border border-line2 px-1.5 text-xs leading-[18px] text-muted-foreground">{rule.category}</span>
                          )}
                        </span>
                        <Link
                          href={securityHref(query, { filters: withFilter(query, { dim: "waf_rule", op: "is", value: String(rule.ruleId) }) }, "#events")}
                          className="text-foreground underline-offset-4 hover:text-brand hover:underline"
                          title={`Show the events of rule ${rule.ruleId}`}
                        >
                          {rule.message ?? `Rule ${rule.ruleId}`}
                        </Link>
                        <span className="truncate text-xs text-soft" title={ruleWhere(rule)}>
                          {ruleWhere(rule)}
                        </span>
                      </span>
                    </td>
                    <td className="w-px px-2.5 py-2.5">
                      <Sparkline values={rule.sparkline} color="var(--waf)" width={84} height={24} area={false} label={`Events of rule ${rule.ruleId} over the range`} />
                    </td>
                    <td className="whitespace-nowrap px-2.5 py-2.5 text-right">
                      <span className="num">{formatCount(rule.events)}</span>
                      {logged > 0 && <span className="block text-xs text-soft">{formatCount(logged)} logged only</span>}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pl-2.5 pr-[18px] text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-brand"
                        disabled={!permissions.canWriteWaf || notExcludable !== null}
                        title={notExcludable ?? undefined}
                        aria-label={`Add exclusion for rule ${rule.ruleId}`}
                        onClick={() =>
                          onAddExclusion({
                            ...EMPTY_EXCLUSION_DRAFT,
                            ruleId: String(rule.ruleId),
                            scope: rule.exclusionHostId === null ? "global" : String(rule.exclusionHostId),
                            path: rule.pathCount === 1 && rule.paths[0] ? rule.paths[0].path : "",
                            pathMatch: "exact",
                          })
                        }
                      >
                        Add exclusion
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function TopSources({ data, blocked, onBlock }: { data: SecurityPageData; blocked: ReadonlySet<string>; onBlock: (target: BlockTarget) => void }) {
  const { sources, query, permissions, now } = data;
  return (
    <SectionCard
      title="Top sources"
      description={plural(sources.total, "address", "addresses")}
      footer={permissions.blockDisabledReason && sources.list.length > 0 ? <span className="text-soft">{permissions.blockDisabledReason}</span> : undefined}
    >
      {sources.list.length === 0 ? (
        <EmptyState
          compact
          title="No source addresses"
          action={
            data.range.preset !== "30d" ? (
              <Button asChild size="sm" variant="outline">
                <Link href={securityHref(query, { range: "30d", from: null, to: null })}>Show the last 30 days</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[600px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-xs text-soft [&>th]:whitespace-nowrap">
                <th scope="col" className="px-[18px] py-2 font-medium">Address</th>
                <th scope="col" className="px-2.5 py-2 font-medium">Network</th>
                <th scope="col" className="px-2.5 py-2 font-medium">Rules</th>
                <th scope="col" className="px-2.5 py-2 font-medium">Last seen</th>
                <th scope="col" className="px-2.5 py-2 text-right font-medium">Events</th>
                <th scope="col" className="py-2 pl-2.5 pr-[18px]"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {sources.list.map((source) => {
                const isBlocked = blocked.has(source.ip);
                const events = source.wafEvents + source.otherMitigated;
                return (
                  <tr key={source.ip} className="border-b border-line last:border-b-0 hover:bg-panel2">
                    <td className="whitespace-nowrap px-[18px] py-2.5">
                      <span className="flex items-center gap-2">
                        <span className="num rounded bg-raise px-1 text-[11px] font-semibold leading-4 text-muted-foreground" title="Country">
                          {source.country}
                        </span>
                        <Link
                          href={securityHref(query, { filters: withFilter(query, { dim: "ip", op: "is", value: source.ip }) }, "#events")}
                          className="num text-foreground underline-offset-4 hover:text-brand hover:underline"
                          title={`Show the events of ${source.ip}`}
                        >
                          {source.ip}
                        </Link>
                      </span>
                    </td>
                    <td className="w-full max-w-0 px-2.5 py-2.5 text-muted-foreground">
                      {source.asn > 0 ? (
                        <span className="block truncate" title={source.asOrg || undefined}>
                          <span className="num">AS{source.asn}</span>
                          {source.asOrg ? ` ${source.asOrg}` : ""}
                        </span>
                      ) : (
                        <span className="text-soft">Unknown</span>
                      )}
                    </td>
                    <td className="num whitespace-nowrap px-2.5 py-2.5 text-muted-foreground" title={source.rules.join(", ") || undefined}>
                      {source.rules.length > 0 ? source.rules.slice(0, 2).join(", ") + (source.rules.length > 2 ? ` +${source.rules.length - 2}` : "") : "–"}
                    </td>
                    <td className="whitespace-nowrap px-2.5 py-2.5 text-muted-foreground" title={`${eventTime(source.lastSeen)} UTC`}>
                      {relativeTime(source.lastSeen, now)}
                    </td>
                    <td className="num px-2.5 py-2.5 text-right">{formatCount(events)}</td>
                    <td className="py-2.5 pl-2.5 pr-[18px] text-right">
                      {isBlocked ? (
                        <span className="text-xs text-soft">Blocked</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={permissions.blockDisabledReason !== null}
                          aria-label={`Block ${source.ip}`}
                          onClick={() =>
                            onBlock({
                              ip: source.ip,
                              country: source.country,
                              cdn: Object.hasOwn(data.cdnIps, source.ip) ? data.cdnIps[source.ip] : null,
                              note: `From Security events: ${formatCount(events)} events${source.rules.length > 0 ? `, WAF rules ${source.rules.slice(0, 5).join(", ")}` : ""}`,
                            })
                          }
                        >
                          Block
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
    </SectionCard>
  );
}

// ── Page ────────────────────────────────────────────────────────────────

export default function SecurityClient({ data }: { data: SecurityPageData }) {
  const router = useRouter();
  const [navigating, startNavigation] = useTransition();
  const navigate = useCallback((href: string) => startNavigation(() => router.push(href, { scroll: false })), [router]);

  const [exclusion, setExclusion] = useState<{ open: boolean; draft: WafExclusionDraft }>({ open: false, draft: EMPTY_EXCLUSION_DRAFT });
  const [blockTarget, setBlockTarget] = useState<BlockTarget | null>(null);
  const blocked = useMemo(() => new Set(data.blockedIps), [data.blockedIps]);
  const ruleEvents = useMemo(() => new Map(data.rules.list.map((rule) => [rule.ruleId, rule.events])), [data.rules.list]);
  const openExclusion = useCallback((draft: WafExclusionDraft) => setExclusion({ open: true, draft }), []);
  const disabled = data.status === "disabled";

  return (
    <div className={cn("flex flex-col gap-5 transition-opacity", navigating && "opacity-70")} aria-busy={navigating}>
      <PageHeader
        breadcrumb={["Observe", "Security events"]}
        title="Security events"
        className="mb-0"
        actions={
          <>
            <RangeControl key={`${data.range.start}-${data.range.end}`} query={data.query} range={data.range} onNavigate={navigate} />
            <Button asChild variant="outline">
              <Link href="/waf">
                <SlidersHorizontal aria-hidden="true" />
                WAF settings
              </Link>
            </Button>
          </>
        }
      />

      {data.rangeError && (
        <Banner tone="warn" title="The time range in the address is not valid.">
          {data.rangeError}. The last 7 days are shown instead.
        </Banner>
      )}
      {disabled && (
        <Banner tone="info" title="Analytics is off.">
          The WAF and your access rules still stop requests; their events are not stored.
        </Banner>
      )}
      {data.status === "unavailable" && (
        <Banner
          tone="warn"
          title="ClickHouse did not answer."
          actions={
            <Button size="sm" variant="outline" onClick={() => router.refresh()}>
              Try again
            </Button>
          }
        />
      )}

      <RuleSetStrip ruleSet={data.ruleSet} />

      {disabled ? (
        <SectionCard title="Events" padded>
          <EmptyState
            title="No events without analytics"
            description={
              <>
                To keep them, add <span className="num">clickhouse</span> to <span className="num">COMPOSE_PROFILES</span> and set{" "}
                <span className="num">CLICKHOUSE_PASSWORD</span> in <span className="num">.env</span>, then run{" "}
                <span className="num">docker compose up -d</span>.
              </>
            }
            action={
              <Button asChild variant="outline">
                <Link href="/waf">WAF settings</Link>
              </Button>
            }
          />
        </SectionCard>
      ) : (
        <>
          <MitigatedSummary data={data} />
          <MitigationChart data={data} />
          <div className="grid items-start gap-5 [grid-template-columns:repeat(auto-fit,minmax(min(520px,100%),1fr))]">
            <TopRules data={data} onAddExclusion={openExclusion} />
            <TopSources data={data} blocked={blocked} onBlock={setBlockTarget} />
          </div>
          <SecurityEvents
            data={data}
            onNavigate={navigate}
            context={{
              canWriteWaf: data.permissions.canWriteWaf,
              canReadAnalytics: data.permissions.canReadAnalytics,
              canReadSettings: data.permissions.canReadSettings,
              blockDisabledReason: data.permissions.blockDisabledReason,
              blockedIps: blocked,
              cdnIps: data.cdnIps,
              ruleEvents,
              eventHostIds: data.eventHostIds,
              onBlock: setBlockTarget,
              onAddExclusion: openExclusion,
              onExcluded: () => router.refresh(),
            }}
          />
        </>
      )}

      <div className="rounded-2xl border border-line bg-panel px-5 py-4">
        <TuningSuggestions
          initialSuggestions={data.tuning.suggestions}
          canWrite={data.permissions.canWriteWaf}
          analyticsEnabled={data.tuning.analyticsEnabled}
          aiConfigured={data.tuning.aiConfigured}
          onApplied={() => router.refresh()}
        />
      </div>

      <WafExclusionDialog
        open={exclusion.open}
        onOpenChange={(open) => setExclusion((current) => ({ ...current, open }))}
        hosts={data.exclusionHosts}
        initial={exclusion.draft}
        description="Skip one rule for the requests in scope. Narrow it to the host, path and variable that need it."
        onCreated={() => router.refresh()}
      />
      <BlockSourceDialog target={blockTarget} onClose={() => setBlockTarget(null)} onBlocked={() => router.refresh()} />
    </div>
  );
}
