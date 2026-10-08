"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { cn } from "@/lib/utils";
import { formatAppVersion } from "@/src/lib/app-version";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import { useBranding } from "@/ee/white-label/ui/BrandingProvider";
import { OVERVIEW_RANGE_LABELS, OVERVIEW_RANGES, type OverviewData, type OverviewRange, type OverviewTraffic } from "@/src/lib/overview-shared";
import { AttentionSection } from "./_overview/AttentionSection";
import { BusiestHosts } from "./_overview/BusiestHosts";
import { NodesCard } from "./_overview/NodesCard";
import { RecentChanges } from "./_overview/RecentChanges";
import { SetupChecklist } from "./_overview/SetupChecklist";
import { KpiRow, TrafficChart, TrafficUnavailable } from "./_overview/TrafficSection";
import { headerDateLine } from "./_overview/format";

/** The server's "now" at first, then the browser's clock, minute by minute (after hydration, so both renders match). */
function useNow(initial: string): number {
  const [now, setNow] = useState(() => Date.parse(initial));
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function rangeHref(range: OverviewRange): string {
  return range === "24h" ? "/" : `/?range=${range}`;
}

/** "Saturday 3 October · 11:36 UTC", with whatever follows it. */
function DateLine({ now, children }: { now: number; children?: ReactNode }) {
  const fmt = useFormat();
  return (
    <p className="m-0 text-[13px] leading-5 text-soft max-md:leading-[18px]" data-testid="overview-date">
      {headerDateLine(now, fmt.timeZone)}
      {children}
    </p>
  );
}

function NewProxyHostButton({ className }: { className?: string }) {
  return (
    <Button asChild className={cn("h-[38px] rounded-[10px] px-3.5 text-sm", className)}>
      <Link href="/proxy-hosts?create=1">
        <Plus aria-hidden="true" strokeWidth={2.4} />
        New proxy host
      </Link>
    </Button>
  );
}

/** Analytics answered for the range (they may be off, or ClickHouse may not answer). */
function answered(traffic: OverviewTraffic): boolean {
  return traffic.status === "ok";
}

/** The overview of an install that is set up: Main.dc.html, stacked on a phone as Phone.dc.html. */
function Overview({ data }: { data: OverviewData }) {
  const router = useRouter();
  const now = useNow(data.generatedAt);
  // The pressed range: the one asked for, while its figures load (the sections show data.range's).
  const [range, setRange] = useState<OverviewRange>(data.range);
  const [pending, startTransition] = useTransition();
  useEffect(() => setRange(data.range), [data.range]);
  const { permissions, traffic, hosts, nodes, changes } = data;

  function changeRange(next: OverviewRange) {
    setRange(next);
    startTransition(() => router.push(rangeHref(next), { scroll: false }));
  }

  const nothingElse = !traffic && !hosts && !nodes && !changes;
  const left = traffic !== null || hosts !== null;
  const right = nodes !== null || changes !== null;

  return (
    <div className="flex flex-col gap-3 md:gap-5">
      <header className="flex flex-wrap items-end gap-x-4 gap-y-2.5">
        <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1">
          <DateLine now={now}>
            {permissions.readAnalytics && <span className="md:hidden"> · {OVERVIEW_RANGE_LABELS[data.range]}</span>}
          </DateLine>
          <h1 className="m-0 text-2xl leading-8 font-semibold tracking-[-0.015em] max-md:sr-only">Overview</h1>
        </div>
        {(permissions.readAnalytics || permissions.createProxyHost) && (
          <div className="flex flex-wrap items-center gap-2.5">
            {permissions.readAnalytics && (
              <SegmentedControl
                label="Time range"
                mono
                value={range}
                onChange={changeRange}
                options={OVERVIEW_RANGES.map((value) => ({ value, label: value }))}
              />
            )}
            {permissions.createProxyHost && <NewProxyHostButton className="max-md:hidden" />}
          </div>
        )}
      </header>

      <AttentionSection attention={data.attention} alertsHref={permissions.readAlerts ? "/alerts" : null} canDismiss={permissions.writeAlerts} />

      <div className={cn("flex flex-col gap-3 transition-opacity md:gap-5", pending && "opacity-60")} aria-busy={pending || undefined}>
        {traffic && answered(traffic) && <KpiRow traffic={traffic} range={data.range} />}

        {(left || right) && (
          <div className="flex flex-wrap items-start gap-3 md:gap-5">
            {left && (
              <div className="flex min-w-0 flex-[2_1_560px] flex-col gap-3 md:gap-5">
                {traffic &&
                  (answered(traffic) ? (
                    <TrafficChart traffic={traffic} range={data.range} security={permissions.readSecurity} />
                  ) : (
                    <TrafficUnavailable status={traffic.status === "disabled" ? "disabled" : "unavailable"} />
                  ))}
                {hosts && <BusiestHosts hosts={hosts} canCreate={permissions.createProxyHost} canList={permissions.readProxyHosts} />}
              </div>
            )}
            {right && (
              <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-3 md:gap-5">
                {nodes && <NodesCard nodes={nodes} now={now} />}
                {changes && <RecentChanges changes={changes} now={now} />}
              </div>
            )}
          </div>
        )}
      </div>

      {nothingElse && (
        <SectionCard title="Your account" divided={false}>
          <EmptyState
            compact
            icon={UserRound}
            title="Nothing else to show for your role"
            description="An administrator can give your role access to hosts, analytics or settings."
            action={
              <Button asChild variant="secondary" size="sm">
                <Link href="/profile">Profile</Link>
              </Button>
            }
            className="px-[18px] pt-0"
          />
        </SectionCard>
      )}
    </div>
  );
}

/** A fresh install: the setup checklist and empty traffic (Onboarding.dc.html). */
function FirstRun({ data }: { data: OverviewData & { firstRun: NonNullable<OverviewData["firstRun"]> } }) {
  const branding = useBranding();
  const now = useNow(data.generatedAt);
  const { permissions, traffic, hosts, firstRun } = data;
  return (
    <div className="flex flex-col gap-3 md:gap-5">
      <header className="flex flex-col gap-1">
        <DateLine now={now}>
          {data.version !== "unknown" && (
            <>
              {" "}
              · {branding.productName} <span className="num">{formatAppVersion(data.version)}</span>
            </>
          )}
        </DateLine>
        <h1 className="m-0 text-2xl leading-8 font-semibold tracking-[-0.015em]">Welcome, {data.userName}</h1>
      </header>

      <AttentionSection attention={data.attention} alertsHref={permissions.readAlerts ? "/alerts" : null} canDismiss={permissions.writeAlerts} exclude={["setup"]} hideWhenEmpty />

      <div className="flex flex-wrap items-start gap-3 md:gap-5">
        <SetupChecklist firstRun={firstRun} permissions={permissions} />
        {(traffic || hosts) && (
          <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-3 md:gap-5">
            {traffic &&
              (answered(traffic) && traffic.totals.requests > 0 ? (
                <TrafficChart traffic={traffic} range={data.range} security={permissions.readSecurity} compact />
              ) : (
                <SectionCard title={`Traffic, ${OVERVIEW_RANGE_LABELS[data.range]}`} divided={false} padded contentClassName="pt-0">
                  <div className="flex min-h-[168px] flex-col items-center justify-center gap-2.5 border-b border-line2 px-4 text-center">
                    <p className="m-0 max-w-[280px] text-[13px] leading-[19px] text-muted-foreground text-pretty">
                      {traffic.status === "disabled"
                        ? "Analytics are off."
                        : traffic.status === "unavailable"
                          ? "Traffic could not be read: ClickHouse did not answer."
                          : "No requests yet."}
                    </p>
                    {traffic.status === "disabled" && (
                      <Button asChild variant="secondary" size="sm">
                        <a href="#step-analytics">How to turn them on</a>
                      </Button>
                    )}
                  </div>
                </SectionCard>
              ))}
            {hosts && <BusiestHosts hosts={hosts} canCreate={permissions.createProxyHost} canList={permissions.readProxyHosts} compact />}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The overview page. A fresh install (setup checklist neither complete nor
 * hidden, for readers of the settings) gets the first-run layout; every
 * other section is only there when the viewer may read it.
 */
export default function OverviewClient({ data }: { data: OverviewData }) {
  if (data.firstRun) return <FirstRun data={{ ...data, firstRun: data.firstRun }} />;
  return <Overview data={data} />;
}
