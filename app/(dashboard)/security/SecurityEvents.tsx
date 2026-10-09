"use client";

import { Fragment, useEffect, useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { FilterBar, type ActiveFilter, type FilterDimension } from "@/components/ui/FilterBar";
import { SectionCard } from "@/components/ui/SectionCard";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import type { SecurityEvent } from "@/src/lib/analytics/security";
import { EventDetail, type EventDetailContext } from "./EventDetail";
import type { SecurityPageData } from "./security-types";
import {
  SECURITY_SOURCES,
  SOURCE_COLORS,
  SOURCE_FILTER_LABELS,
  analyticsHref,
  eventActionLabel,
  eventReason,
  eventTime,
  isSecuritySource,
  securityHref,
  withFilter,
  type SecurityFilter,
} from "./security-view";

/** A quick check before the URL changes; the server validates every filter again. */
function filterProblem(dim: string, value: string): string | null {
  if (dim === "waf_rule" && !/^\d{1,10}$/.test(value)) return "A rule is a number such as 930130.";
  if (dim === "ip" && !/^[0-9a-fA-F.:]{2,45}$/.test(value)) return "An address is an IPv4 or IPv6 address.";
  if (dim === "country" && !/^([A-Za-z]{2}|LAN)$/.test(value)) return "A country is a two-letter code such as DE.";
  if (dim === "path" && !value.startsWith("/")) return "A path starts with /.";
  return null;
}

function eventKey(event: SecurityEvent, index: number): string {
  return `${event.ts}-${index}-${event.eventId ?? event.kind}`;
}

/**
 * The event list: WAF events and requests stopped by the other rules,
 * newest first, filtered by source, host, rule, address, path and country
 * (all held in the URL), 50 to a page. Selecting an event opens why it was
 * stopped.
 */
export function SecurityEvents({
  data,
  context,
  onNavigate,
}: {
  data: SecurityPageData;
  context: Omit<EventDetailContext, "query" | "rangeLabel">;
  onNavigate: (href: string) => void;
}) {
  const { events, query } = data;
  const [openKey, setOpenKey] = useState<string | null>(null);
  const idPrefix = useId();

  // A new page of events closes the open one.
  useEffect(() => setOpenKey(null), [events.list]);

  const sourceValue = query.kind === null ? "all" : isSecuritySource(query.kind) ? query.kind : "mixed";
  const activeFilters: ActiveFilter[] = query.filters.map((filter) => ({
    dimension: filter.dim,
    operator: filter.op === "is_not" ? "is not" : filter.op === "contains" ? "contains" : filter.op === "not_contains" ? "does not contain" : "is",
    value: filter.value,
  }));
  const dimensions: FilterDimension[] = [
    { key: "host", label: "Host", placeholder: "app.example.com", suggestions: data.hosts.list.map((host) => host.host) },
    { key: "waf_rule", label: "Rule", placeholder: "930130", suggestions: data.rules.list.map((rule) => String(rule.ruleId)) },
    { key: "ip", label: "Address", placeholder: "198.51.100.7", suggestions: data.sources.list.map((source) => source.ip) },
    { key: "path", label: "Path", placeholder: "/login" },
    { key: "country", label: "Country", placeholder: "DE" },
  ];

  const toEvents = (filters: readonly SecurityFilter[]) => securityHref(query, { filters }, "#events");
  const detailContext: EventDetailContext = { ...context, query, rangeLabel: data.range.label };
  const hasFilters = query.filters.length > 0 || query.kind !== null;

  return (
    <SectionCard
      id="events"
      title="Events"
      actions={
        context.canReadAnalytics ? (
          <Link
            href={analyticsHref(query, [{ dim: "outcome", op: "is_not", value: "served" }])}
            className="text-[13px] text-brand underline-offset-4 hover:text-foreground hover:underline"
          >
            Open in analytics
          </Link>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-2.5 border-b border-line px-[18px] py-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <SegmentedControl
            size="sm"
            label="Source"
            value={sourceValue}
            onChange={(value) => onNavigate(securityHref(query, { kind: value === "all" ? null : value }, "#events"))}
            options={[
              { value: "all", label: "All" },
              ...SECURITY_SOURCES.map((key) => ({
                value: key,
                label: (
                  <>
                    <span aria-hidden="true" className="size-2 rounded-[2px]" style={{ background: SOURCE_COLORS[key] }} />
                    {SOURCE_FILTER_LABELS[key]}
                  </>
                ),
                ariaLabel: SOURCE_FILTER_LABELS[key],
              })),
            ]}
          />
        </div>
        <FilterBar
          label="Event filters"
          filters={activeFilters}
          dimensions={dimensions}
          onAdd={(filter) => {
            const problem = filterProblem(filter.dimension, filter.value);
            if (problem) {
              toast.error(problem);
              return;
            }
            const op = filter.operator === "is not" ? "is_not" : filter.operator === "contains" ? "contains" : filter.operator === "does not contain" ? "not_contains" : "is";
            onNavigate(toEvents(withFilter(query, { dim: filter.dimension, op, value: filter.value })));
          }}
          onRemove={(_filter, index) => onNavigate(toEvents(query.filters.filter((_, i) => i !== index)))}
          trailing={
            hasFilters ? (
              <Link href={securityHref(query, { kind: null, filters: [] }, "#events")} className="text-brand underline-offset-4 hover:text-foreground hover:underline">
                Clear filters
              </Link>
            ) : undefined
          }
        />
        {events.filterError && (
          <Banner tone="warn" title="A filter in the address is not valid, so it is not applied.">
            {events.filterError}
          </Banner>
        )}
      </div>

      {events.list.length === 0 ? (
        <EmptyState
          compact
          title={hasFilters ? "No events match these filters" : "Nothing was stopped in this range"}
          action={
            hasFilters ? (
              <Button asChild size="sm" variant="outline">
                <Link href={securityHref(query, { kind: null, filters: [] }, "#events")}>Clear filters</Link>
              </Button>
            ) : data.range.preset !== "30d" ? (
              <Button asChild size="sm" variant="outline">
                <Link href={securityHref(query, { range: "30d", from: null, to: null }, "#events")}>Show the last 30 days</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-xs text-soft">
                <th scope="col" className="px-[18px] py-2 font-medium">Time (UTC)</th>
                <th scope="col" className="px-2.5 py-2 font-medium">Action</th>
                <th scope="col" className="px-2.5 py-2 font-medium">Reason</th>
                <th scope="col" className="px-2.5 py-2 font-medium">Request</th>
                <th scope="col" className="py-2 pl-2.5 pr-[18px] font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {events.list.map((event, index) => {
                const key = eventKey(event, index);
                const open = openKey === key;
                const detailId = `${idPrefix}-event-${index}`;
                const toggle = () => setOpenKey(open ? null : key);
                const reason = eventReason(event);
                return (
                  <Fragment key={key}>
                    <tr
                      onClick={toggle}
                      className={cn("cursor-pointer border-b border-line", open ? "border-b-0 bg-panel2" : "hover:bg-panel2")}
                      data-kind={event.kind}
                    >
                      <td className="px-[18px] py-2.5">
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-controls={open ? detailId : undefined}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle();
                          }}
                          className="num whitespace-nowrap rounded text-left text-muted-foreground hover:text-foreground"
                        >
                          {eventTime(event.ts)}
                        </button>
                      </td>
                      <td className="whitespace-nowrap px-2.5 py-2.5">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            aria-hidden="true"
                            className={cn("size-2 rounded-[2px]", event.kind === "waf" && !event.blocked && "opacity-50")}
                            style={{ background: SOURCE_COLORS[event.kind] }}
                          />
                          {eventActionLabel(event)}
                        </span>
                      </td>
                      <td className="max-w-[320px] px-2.5 py-2.5">
                        <span className="block truncate" title={event.kind === "waf" && event.ruleId !== null ? `${event.ruleId} ${reason}` : reason}>
                          {event.kind === "waf" && event.ruleId !== null && <span className="num mr-1.5 text-muted-foreground">{event.ruleId}</span>}
                          {reason}
                        </span>
                      </td>
                      <td className="max-w-[340px] px-2.5 py-2.5">
                        <span className="block truncate" title={`${event.method} ${event.host}${event.path}`}>
                          <span className="num mr-1.5 text-muted-foreground">{event.method}</span>
                          {event.host}
                          <span className="num text-muted-foreground">{event.path}</span>
                        </span>
                      </td>
                      <td className="whitespace-nowrap py-2.5 pl-2.5 pr-[18px]">
                        <span className="num">{event.ip}</span> <span className="text-soft">{event.country}</span>
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-b border-line bg-panel2">
                        <td colSpan={5} id={detailId} className="px-[18px] pb-[18px] pt-1">
                          <EventDetail event={event} context={detailContext} onClose={() => setOpenKey(null)} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <EventPager
        page={events.page}
        shown={events.list.length}
        perPage={events.perPage}
        hasMore={events.hasMore}
        hrefFor={(page) => securityHref(query, { page }, "#events")}
      />
    </SectionCard>
  );
}

const PAGER_ITEM =
  "inline-flex h-8 min-w-8 items-center justify-center rounded-md border border-line2 bg-panel px-2 text-[13px] text-foreground transition-colors hover:bg-raise";

/**
 * The pager under the events, in the shared pager's look
 * (src/components/ui/Pagination.tsx). The events are read newest first a
 * page at a time, without counting them all, so it offers the next page
 * while there is one instead of a total and page numbers.
 */
function EventPager({
  page,
  shown,
  perPage,
  hasMore,
  hrefFor,
}: {
  page: number;
  shown: number;
  perPage: number;
  hasMore: boolean;
  hrefFor: (page: number) => string;
}) {
  if (page <= 1 && !hasMore) return null;
  const from = (page - 1) * perPage + 1;
  const to = from + Math.max(0, shown - 1);
  const step = (target: number, enabled: boolean, label: string, icon: ReactNode) =>
    enabled ? (
      <Link href={hrefFor(target)} className={PAGER_ITEM} aria-label={label}>
        {icon}
      </Link>
    ) : (
      <span className={cn(PAGER_ITEM, "pointer-events-none opacity-40")} aria-disabled="true" aria-label={label}>
        {icon}
      </span>
    );
  return (
    <nav aria-label="Pages of events" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-[18px] py-3">
      <span className="text-[13px] text-muted-foreground">
        {shown > 0 ? (
          <>
            <span className="num">{from}</span>–<span className="num">{to}</span> events
          </>
        ) : (
          <>No events on page {page}</>
        )}
      </span>
      <span className="ml-auto flex items-center gap-1">
        {step(page - 1, page > 1, "Previous page", <ChevronLeft aria-hidden="true" className="size-4" />)}
        <span className={cn(PAGER_ITEM, "border-brand bg-brand-tint font-semibold")} aria-current="page">
          <span className="num">{page}</span>
        </span>
        {step(page + 1, hasMore, "Next page", <ChevronRight aria-hidden="true" className="size-4" />)}
      </span>
    </nav>
  );
}
