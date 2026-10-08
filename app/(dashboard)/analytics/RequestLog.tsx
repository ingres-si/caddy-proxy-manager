"use client";

/**
 * The latest requests matching the filters, newest first, with "Show more".
 * A run of identical requests (a client polling, retrying) is one row with a
 * count; a request the WAF blocked links to its events on Security events.
 */
import { useMemo } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton } from "@/components/ui/skeleton";
import type { RequestLogEntry } from "@/src/lib/analytics";
import { cn } from "@/lib/utils";
import { UA_NONE } from "@/src/lib/analytics/user-agent";
import { DEFAULT_QUERY, securityHref } from "../security/security-view";
import { OUTCOME_COLOR, OUTCOME_LOG_LABEL, collapseRequestRuns, formatLogTime } from "./present";

/** Security events around a blocked request, for its source and rule. */
function wafEventsHref(row: RequestLogEntry): string {
  return securityHref(DEFAULT_QUERY, {
    range: "custom",
    from: row.ts - 300,
    to: row.ts + 300,
    kind: "waf",
    filters: [
      { dim: "ip", op: "is", value: row.ip },
      { dim: "waf_rule", op: "is", value: String(row.wafRuleId) },
    ],
  });
}

export function RequestLog({
  rows,
  loading,
  error,
  withDay,
  hasMore,
  loadingMore,
  onMore,
  mitigatedOnly,
  onMitigatedOnlyChange,
}: {
  rows: readonly RequestLogEntry[] | null;
  loading: boolean;
  error: string | null;
  /** The range spans more than a day: show the day with each time. */
  withDay: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onMore: () => void;
  /** Lists only mitigated requests (outcome is not served). */
  mitigatedOnly: boolean;
  onMitigatedOnlyChange: (mitigatedOnly: boolean) => void;
}) {
  const runs = useMemo(() => (rows ? collapseRequestRuns(rows) : null), [rows]);
  return (
    <section aria-labelledby="analytics-log-title" className="flex flex-col overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-[18px] py-3.5">
        <h2 id="analytics-log-title" className="m-0 text-base leading-6 font-semibold">
          Requests
        </h2>
        <SegmentedControl
          size="sm"
          label="Requests to list"
          className="ml-auto"
          value={mitigatedOnly ? "mitigated" : "all"}
          onChange={(value) => onMitigatedOnlyChange(value === "mitigated")}
          options={[
            { value: "all", label: "All" },
            { value: "mitigated", label: "Mitigated only" },
          ]}
        />
      </div>
      {error && !rows ? (
        <p role="alert" className="m-0 border-t border-line px-[18px] py-4 text-[13px] text-bad">
          {error}
        </p>
      ) : !rows ? (
        <div className="flex flex-col gap-2 border-t border-line px-[18px] py-4" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="m-0 border-t border-line px-[18px] py-6 text-center text-[13px] text-soft">
          {mitigatedOnly ? "No mitigated requests match the filters in this period." : "No requests match the filters in this period."}
        </p>
      ) : (
        <div className={cn("overflow-x-auto", loading && "opacity-70")} aria-busy={loading}>
          {/* Fixed columns: a long path is cut short instead of pushing Status and Source off to the right. */}
          <table className="w-full min-w-[920px] table-fixed border-collapse text-[13px]">
            <colgroup>
              <col className={withDay ? "w-[150px]" : "w-[112px]"} />
              <col className="w-[190px]" />
              <col />
              <col className="w-[64px]" />
              <col className="w-[180px]" />
              <col className="w-[190px]" />
            </colgroup>
            <thead>
              <tr className="text-left text-xs text-soft">
                <th scope="col" className="whitespace-nowrap border-y border-line px-[18px] py-2 font-medium">
                  Time (UTC)
                </th>
                <th scope="col" className="border-y border-line px-2.5 py-2 font-medium">
                  Outcome
                </th>
                <th scope="col" className="border-y border-line px-2.5 py-2 font-medium">
                  Request
                </th>
                <th scope="col" className="border-y border-line px-2.5 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="border-y border-line px-2.5 py-2 font-medium">
                  Source
                </th>
                <th scope="col" className="border-y border-line py-2 pl-2.5 pr-[18px] font-medium">
                  User agent
                </th>
              </tr>
            </thead>
            <tbody>
              {runs!.map(({ row, count, firstTs }, i) => (
                <tr key={`${row.ts}-${row.ip}-${i}`} className="border-b border-line last:border-b-0 hover:bg-panel2">
                  <td className="num whitespace-nowrap px-[18px] py-2 text-muted-foreground">{formatLogTime(row.ts, withDay)}</td>
                  <td className="whitespace-nowrap px-2.5 py-2">
                    <span className="inline-flex items-center gap-1.5">
                      <span aria-hidden="true" className="size-2 rounded-[2px]" style={{ background: OUTCOME_COLOR[row.outcome] ?? "var(--soft)" }} />
                      {OUTCOME_LOG_LABEL[row.outcome] ?? row.outcome}
                      {row.outcome === "waf" && row.wafRuleId > 0 && (
                        <Link
                          href={wafEventsHref(row)}
                          title={`Rule ${row.wafRuleId}: why it was blocked, on Security events`}
                          className="num text-xs text-brand underline-offset-4 hover:underline"
                        >
                          {row.wafRuleId}
                        </Link>
                      )}
                    </span>
                  </td>
                  <td className="px-2.5 py-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate" title={`${row.method} ${row.host}${row.path}`}>
                        <span className="num text-muted-foreground">{row.method}</span> <span>{row.host}</span>
                        <span className="num text-muted-foreground">{row.path}</span>
                      </span>
                      {count > 1 && (
                        <span
                          className="num shrink-0 rounded-full bg-raise px-1.5 text-[11px] leading-[18px] text-muted-foreground"
                          title={`${count} identical requests, ${formatLogTime(firstTs, withDay)} to ${formatLogTime(row.ts, withDay)}`}
                        >
                          ×{count}
                          <span className="sr-only"> identical requests</span>
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="num px-2.5 py-2">{row.status}</td>
                  <td className="truncate whitespace-nowrap px-2.5 py-2" title={row.asOrg ? `${row.ip} · ${row.asOrg}` : row.ip}>
                    <span className="num">{row.ip}</span> <span className="text-soft">{row.country}</span>
                  </td>
                  <td className="truncate py-2 pl-2.5 pr-[18px] text-muted-foreground" title={row.userAgent === UA_NONE ? undefined : row.userAgent}>
                    {row.userAgent === UA_NONE || !row.userAgent ? <span className="text-soft">No user agent</span> : row.userAgent}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && rows.length > 0 && (hasMore || error) && (
        <div className="flex flex-wrap items-center gap-3 border-t border-line px-[18px] py-2.5">
          {hasMore && (
            <Button variant="outline" size="sm" onClick={onMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Show more"}
            </Button>
          )}
          {error && (
            <span role="alert" className="text-[13px] text-bad">
              {error}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
