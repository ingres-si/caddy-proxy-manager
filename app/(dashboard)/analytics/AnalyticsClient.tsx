"use client";

/**
 * Traffic analytics (Analytics.dc.html): range, comparison, export and
 * saved views in the header; filters over every dimension; the headline
 * numbers (each selects the chart's metric); the chart, grouped; the top
 * dimensions; the request log. Everything it shows is in the URL, so a
 * view can be shared and the back button steps through changes. Data comes
 * from /api/v1/analytics; short ranges refresh every 30 seconds while the
 * tab is visible.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Download, ServerOff } from "lucide-react";
import { toast } from "sonner";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { FilterBar, type ActiveFilter, type FilterDimension, type FilterOperator, type FilterSearchResult } from "@/components/ui/FilterBar";
import { KpiTile } from "@/components/ui/KpiTile";
import { PageHeader } from "@/components/ui/PageHeader";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton } from "@/components/ui/skeleton";
import { StackedBarChart, type ChartAnnotation, type ChartSeries } from "@/components/ui/StackedBarChart";
import { StatusDot } from "@/components/ui/StatusDot";
import { Switch } from "@/components/ui/switch";
import { formatBytes, formatChange, formatCompact, formatDayUtc, formatPercent } from "@/components/ui/chart-format";
import { cn } from "@/lib/utils";
import type { AnalyticsQueryResult, Dimension, FilterOp, Grouping, Metric, RangePreset } from "@/src/lib/analytics";
import type { AnalyticsSavedView } from "@/src/lib/models/analytics-views";
import {
  DIMENSION_LABEL,
  DIMENSION_PLACEHOLDER,
  METRIC_INFO,
  chartCsv,
  chartTitle,
  filterSuggestions,
  formatClockUtc,
  groupingLabel,
  rangeNoun,
  seriesColor,
  seriesLabel,
} from "./present";
import { RangeControl } from "./RangeControl";
import { RequestLog } from "./RequestLog";
import { ManageViewsDialog, SaveViewDialog, SavedViewsMenu, useSavedViews } from "./SavedViews";
import { TopPanels } from "./TopPanels";
import { useAnalyticsData } from "./use-analytics-data";
import {
  DIMENSIONS,
  MAX_FILTERS,
  METRICS,
  METRIC_GROUPINGS,
  addFilter,
  effectiveGrouping,
  filterValueError,
  isSearchableDimension,
  MAX_CONTAINS_LENGTH,
  listParams,
  matchesSavedView,
  normalizeFilterValue,
  parseViewState,
  queryParams,
  securityEventsHref,
  serializeViewState,
  stateFromSavedView,
  type ViewState,
} from "./view-state";

export type AnalyticsClientProps = {
  /** ClickHouse is configured (CLICKHOUSE_PASSWORD is set). */
  analyticsEnabled: boolean;
  /** Caddy's access log is on (Analytics settings, Access log). */
  loggingEnabled: boolean;
  retentionDays: number;
  /** May open the security events page (waf:read). */
  canReadSecurity: boolean;
  /** May open the settings page (settings:read). */
  canReadSettings: boolean;
  /** Built-in administrator: may delete others' shared views. */
  isAdmin: boolean;
  /** Host names of the proxy hosts the user can see, offered as host filters. */
  hostSuggestions: string[];
  /** The plain-language Ask box (ee/ai/questions), shown under the header when analytics is on. */
  ask?: ReactNode;
};

/** Writes `state` to the URL: a new history entry (back undoes it), or in place. */
function navigate(state: ViewState, replace = false) {
  const query = serializeViewState(state);
  const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
}

function CompareSwitch({ checked, disabled, onChange, note }: { checked: boolean; disabled: boolean; onChange: (on: boolean) => void; note: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label
        className={cn(
          "flex h-[38px] items-center gap-2 rounded-[10px] border border-line bg-panel px-3 text-[13px]",
          disabled ? "cursor-not-allowed text-muted-foreground" : "cursor-pointer"
        )}
      >
        <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
        Compare to previous period
      </label>
      {note && <span className="text-xs text-soft">{note}</span>}
    </div>
  );
}

function LiveStatus({ live, lastUpdated, loading }: { live: boolean; lastUpdated: number | null; loading: boolean }) {
  const time = lastUpdated ? `${formatClockUtc(lastUpdated)} UTC` : null;
  if (!time) return <StatusDot tone="off" label={loading ? "Loading" : "Not loaded"} />;
  if (live) return <StatusDot tone="ok" label={`Live · updated ${time}`} />;
  return <StatusDot tone="off" label={`Updated ${time}`} />;
}

/** The headline numbers; each tile selects the chart's metric. */
export function KpiRow({
  result,
  metric,
  rangeLabel,
  onSelect,
}: {
  result: AnalyticsQueryResult | null;
  metric: Metric;
  rangeLabel: string;
  onSelect: (metric: Metric) => void;
}) {
  if (!result) {
    return (
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-3" aria-hidden="true">
        {METRICS.map((m) => (
          <Skeleton key={m} className="h-[106px] rounded-xl" />
        ))}
      </div>
    );
  }
  const { headline, headlineSeries } = result;
  // Without an earlier period the delta says "No earlier data"; nothing to add under it.
  const vs = result.previous.available ? `vs previous ${rangeLabel}` : undefined;
  const tiles: Record<Metric, { value: string; current: number; previous: number | null; note: string | undefined; spark: number[] }> = {
    requests: {
      value: formatCompact(headline.requests.value),
      current: headline.requests.value,
      previous: headline.requests.previous,
      note: vs,
      spark: headlineSeries.requests,
    },
    bytes: {
      value: formatBytes(headline.bytes.value),
      current: headline.bytes.value,
      previous: headline.bytes.previous,
      note: vs,
      spark: headlineSeries.bytes,
    },
    visitors: {
      value: formatCompact(headline.visitors.value),
      current: headline.visitors.value,
      previous: headline.visitors.previous,
      note: vs,
      spark: headlineSeries.visitors,
    },
    mitigated: {
      value: formatCompact(headline.mitigated.value),
      current: headline.mitigated.value,
      previous: headline.mitigated.previous,
      note: `${formatPercent(headline.mitigated.share)} of requests`,
      spark: headlineSeries.mitigated,
    },
    errors: {
      value: formatPercent(headline.errorRate5xx.value),
      current: headline.errorRate5xx.value,
      previous: headline.errorRate5xx.previous,
      note: vs,
      spark: headlineSeries.errors5xx,
    },
  };
  return (
    <div role="group" aria-label="Headline figures" className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-3">
      {METRICS.map((m) => {
        const tile = tiles[m];
        const change = formatChange(tile.current, tile.previous, METRIC_INFO[m].good);
        return (
          <KpiTile
            key={m}
            label={METRIC_INFO[m].label}
            value={tile.value}
            color={METRIC_INFO[m].color}
            delta={{ text: change.text, tone: change.tone }}
            note={tile.note}
            sparkline={tile.spark}
            selected={metric === m}
            onSelect={() => onSelect(m)}
          />
        );
      })}
    </div>
  );
}

const EMPTY_TEXT: Record<Metric, string> = {
  requests: "No requests match the filters in this period.",
  bytes: "No bytes were sent in this period.",
  visitors: "No requests match the filters in this period.",
  mitigated: "Nothing was mitigated in this period.",
  errors: "No error responses in this period.",
};

/** The chart's buckets (ms), series and previous-period totals (of the shown series, and of all) of a query result. */
export function chartData(result: AnalyticsQueryResult, hidden: readonly string[]) {
  const { start, step, buckets: n } = result.range;
  const group = result.groupBy;
  const metric = result.metric;
  const buckets = Array.from({ length: n }, (_, i) => (start + i * step) * 1000);
  const series: ChartSeries[] = result.series.map((s, i) => ({
    key: s.key,
    label: seriesLabel(group, metric, s.label),
    color: seriesColor(group, metric, s.key, i),
    values: s.values,
  }));
  let previous: number[] | null = null;
  let previousAll: number[] | null = null;
  if (result.previous.available) {
    const prev = result.previous;
    previousAll = prev.totals;
    previous = Array.from({ length: n }, (_, i) =>
      prev.series.reduce((sum, s) => (hidden.includes(s.key) ? sum : sum + (s.values[i] ?? 0)), 0)
    );
  }
  return { buckets, series, previous, previousAll };
}

function downloadCsv(result: AnalyticsQueryResult) {
  const { buckets, series, previousAll } = chartData(result, []);
  const csv = chartCsv({ buckets, series, previous: previousAll });
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `analytics-${result.metric}-by-${result.groupBy}-${new Date(result.range.end * 1000).toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function AnalyticsOff({ canReadSettings }: { canReadSettings: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-panel" data-testid="analytics-disabled">
      <EmptyState
        icon={ServerOff}
        title="Traffic analytics is off"
        description={
          <>
            To turn it on, add <code className="num">clickhouse</code> to <code className="num">COMPOSE_PROFILES</code> and set{" "}
            <code className="num">CLICKHOUSE_PASSWORD</code> in <code className="num">.env</code>, then run <code className="num">docker compose up -d</code>.
          </>
        }
        action={
          canReadSettings ? (
            <Button asChild variant="outline">
              <Link href="/analytics/settings">Analytics settings</Link>
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

/** The filter bar's operator words and the API's filter ops. */
const OP_OF_OPERATOR: Record<FilterOperator, FilterOp> = { is: "is", "is not": "is_not", contains: "contains", "does not contain": "not_contains" };
const OPERATOR_OF_OP: Record<FilterOp, FilterOperator> = { is: "is", is_not: "is not", contains: "contains", not_contains: "does not contain" };

export default function AnalyticsClient({
  analyticsEnabled,
  loggingEnabled,
  retentionDays,
  canReadSecurity,
  canReadSettings,
  isAdmin,
  hostSuggestions,
  ask,
}: AnalyticsClientProps) {
  const search = useSearchParams()?.toString() ?? "";
  const state = useMemo(() => parseViewState(new URLSearchParams(search)), [search]);
  const group = effectiveGrouping(state);
  const listKey = listParams(state).toString();
  const queryKey = queryParams(state).toString();
  const live = state.range === "1h" || state.range === "24h";

  const [mitigatedOnly, setMitigatedOnly] = useState(false);
  const logKey = mitigatedOnly
    ? listParams({ ...state, filters: addFilter(state.filters, { dim: "outcome", op: "is_not", value: "served" }) }).toString()
    : listKey;
  const data = useAnalyticsData({ queryKey, listKey, logKey, enabled: analyticsEnabled, live });
  const views = useSavedViews(analyticsEnabled);
  const [saveOpen, setSaveOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const chartKey = `${state.metric}:${group}`;
  const [hiddenFor, setHiddenFor] = useState<{ key: string; hidden: string[] }>({ key: chartKey, hidden: [] });
  const hidden = hiddenFor.key === chartKey ? hiddenFor.hidden : [];

  const top = data.top.data;
  const suggestions = useMemo(() => filterSuggestions(top?.dimensions ?? null, hostSuggestions), [top, hostSuggestions]);

  const update = (patch: Partial<ViewState>) => navigate({ ...state, viewId: null, ...patch });

  /** Adds a filter; returns the state it navigated to, or null when the filter was refused. */
  const addFilterTo = (dim: Dimension, op: FilterOp, raw: string): ViewState | null => {
    const contains = op === "contains" || op === "not_contains";
    const value = contains ? raw.trim() : normalizeFilterValue(dim, raw);
    const problem = contains
      ? !isSearchableDimension(dim)
        ? `${DIMENSION_LABEL[dim]} cannot be matched by part of its text`
        : !value
          ? "Type what to look for"
          : value.length > MAX_CONTAINS_LENGTH
            ? `At most ${MAX_CONTAINS_LENGTH} characters`
            : null
      : filterValueError(dim, value);
    if (problem) {
      toast.error(problem);
      return null;
    }
    if (state.filters.length >= MAX_FILTERS) {
      toast.error(`At most ${MAX_FILTERS} filters`);
      return null;
    }
    const next: ViewState = { ...state, viewId: null, filters: addFilter(state.filters, { dim, op, value }) };
    navigate(next);
    return next;
  };

  /**
   * "Only" and "Exclude" on a top list row: the filter changes the whole page,
   * so a toast says what is shown now and offers to undo it.
   */
  const filterFromList = (dim: Dimension, op: FilterOp, raw: string) => {
    const before = state;
    const after = addFilterTo(dim, op, raw);
    if (!after) return;
    const added = after.filters[after.filters.length - 1];
    const what = `${DIMENSION_LABEL[dim]} is ${added.value}`;
    toast(op === "is" ? `Showing only ${what}` : `Hiding ${what}`, {
      duration: 8000,
      action: {
        label: "Undo",
        onClick: () => {
          const current = parseViewState(new URLSearchParams(window.location.search));
          // Nothing else changed since: back to exactly the view before. Otherwise only this filter goes.
          if (serializeViewState(current) === serializeViewState(after)) navigate(before);
          else navigate({ ...current, viewId: null, filters: current.filters.filter((f) => !(f.dim === added.dim && f.op === added.op && f.value === added.value)) });
        },
      },
    });
  };

  const result = data.query.data;
  const disabled = !analyticsEnabled || result?.status === "disabled";
  const unavailable = result?.status === "unavailable" || top?.status === "unavailable";
  const loadError = data.query.error ?? data.top.error ?? (data.requests.data ? null : data.requests.error);
  const previousAvailable = result ? result.previous.available : true;
  const retentionStart = result ? result.retention.start : Math.floor(Date.now() / 1000) - retentionDays * 86_400;
  const noPreviousNote = previousAvailable ? null : `No data before ${formatDayUtc(retentionStart * 1000)}`;
  const rangeLabel = rangeNoun(state.range);
  const activeView: AnalyticsSavedView | null =
    state.viewId === null ? null : (views.views.find((view) => view.id === state.viewId && matchesSavedView(state, view)) ?? null);

  // The values containing what is typed in the filter box, within the range and filters on the page.
  const searchParamsText = listParams(state).toString();
  const searchValues = useCallback(
    async (q: string): Promise<FilterSearchResult> => {
      const params = new URLSearchParams(searchParamsText);
      params.set("q", q);
      const response = await fetch(`/api/v1/analytics/values?${params.toString()}`, { headers: { Accept: "application/json" } });
      if (!response.ok) return [];
      const body = (await response.json()) as { dimensions?: { dimension: string; values: { value: string; count: number }[] }[] };
      return (body.dimensions ?? []).map((group) => ({ dimension: group.dimension, values: group.values }));
    },
    [searchParamsText]
  );

  const filterDimensions: FilterDimension[] = DIMENSIONS.map((dim) => ({
    key: dim,
    label: DIMENSION_LABEL[dim],
    suggestions: suggestions[dim],
    placeholder: DIMENSION_PLACEHOLDER[dim],
    mono: dim !== "user_agent",
    searchable: isSearchableDimension(dim),
  }));
  const activeFilters: ActiveFilter[] = state.filters.map((f) => ({
    dimension: f.dim,
    operator: OPERATOR_OF_OP[f.op],
    value: f.value,
  }));

  const openView = (view: AnalyticsSavedView) => navigate(stateFromSavedView(view, state.compare));

  const header = (
    <PageHeader
      breadcrumb={["Observe", "Analytics"]}
      title="Analytics"
      className="mb-0"
      actions={
        disabled ? undefined : (
          <>
            <RangeControl
              range={state.range}
              from={state.from}
              to={state.to}
              onPreset={(preset: RangePreset) => update({ range: preset, from: null, to: null })}
              onCustom={(from, to) => update({ range: "custom", from, to })}
            />
            <CompareSwitch
              checked={state.compare && previousAvailable}
              disabled={!previousAvailable}
              onChange={(compare) => update({ compare })}
              note={noPreviousNote}
            />
            <Button variant="outline" className="h-[38px]" disabled={!result || result.status !== "ok"} onClick={() => result && downloadCsv(result)}>
              <Download aria-hidden="true" />
              Export CSV
            </Button>
            <SavedViewsMenu api={views} activeView={activeView} onOpen={openView} onSave={() => setSaveOpen(true)} onManage={() => setManageOpen(true)} />
          </>
        )
      }
    />
  );

  if (disabled) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {header}
        <AnalyticsOff canReadSettings={canReadSettings} />
      </div>
    );
  }

  const allowedGroups = METRIC_GROUPINGS[state.metric];
  const chart = result ? chartData(result, hidden) : null;
  const metric = result?.metric ?? state.metric;
  const resultGroup: Grouping = result?.groupBy ?? group;
  const showPrevious = chart?.previous != null && state.compare && metric !== "visitors";
  const annotations: ChartAnnotation[] =
    result?.peakMitigated && ((metric === "requests" && resultGroup === "outcome") || metric === "mitigated")
      ? [
          {
            index: result.peakMitigated.index,
            label: `Peak · ${formatCompact(result.peakMitigated.value)} mitigated`,
            href: canReadSecurity ? securityEventsHref(state) : undefined,
          },
        ]
      : [];
  const stale = data.query.loading || (result !== null && data.query.key !== queryKey);
  const queryFailed = !result && !data.query.loading && data.query.error !== null;
  const topFailed = !top && !data.top.loading && data.top.error !== null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {header}

      {ask}

      {!loggingEnabled && (
        <Banner
          tone="warn"
          title="Access logging is off."
          actions={
            canReadSettings ? (
              <Button asChild variant="outline" size="sm">
                <Link href="/analytics/settings#logging">Turn it on in Analytics settings</Link>
              </Button>
            ) : undefined
          }
        >
          No new requests are recorded.
        </Banner>
      )}

      {loadError ? (
        <div data-testid="analytics-load-error">
          <Banner
            tone="bad"
            title="Analytics could not be loaded."
            actions={
              <Button variant="outline" size="sm" onClick={data.refresh}>
                Retry
              </Button>
            }
          >
            {loadError}
          </Banner>
        </div>
      ) : unavailable ? (
        <div data-testid="analytics-unavailable">
          <Banner
            tone="warn"
            title="ClickHouse is not answering."
            actions={
              <Button variant="outline" size="sm" onClick={data.refresh}>
                Retry
              </Button>
            }
          />
        </div>
      ) : null}

      <FilterBar
        filters={activeFilters}
        dimensions={filterDimensions}
        onAdd={(filter) => addFilterTo(filter.dimension as Dimension, OP_OF_OPERATOR[filter.operator], filter.value)}
        onRemove={(_, index) => update({ filters: state.filters.filter((__, i) => i !== index) })}
        onInvert={(filter, index) => update({ filters: state.filters.map((f, i) => (i === index ? { ...f, op: OP_OF_OPERATOR[filter.operator] } : f)) })}
        onSearch={searchValues}
        trailing={
          <>
            {state.filters.length > 0 && (
              <button type="button" onClick={() => update({ filters: [] })} className="text-[13px] text-brand hover:text-foreground">
                Clear filters
              </button>
            )}
            <LiveStatus live={live && !data.paused} lastUpdated={data.lastUpdated} loading={data.query.loading} />
            <button type="button" onClick={() => setSaveOpen(true)} className="text-[13px] text-brand hover:text-foreground">
              Save view
            </button>
          </>
        }
      />

      {!queryFailed && (
        <KpiRow result={result} metric={state.metric} rangeLabel={rangeLabel} onSelect={(m) => update({ metric: m, group: null })} />
      )}

      <section
        aria-labelledby="analytics-chart-title"
        className="relative flex min-w-0 flex-col gap-3.5 rounded-2xl border border-line bg-panel px-4 pb-3.5 pt-4 sm:px-5"
      >
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="analytics-chart-title" className="m-0 flex-[1_1_240px] text-base leading-6 font-semibold">
            {chartTitle(state.metric, group)}
          </h2>
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <span aria-hidden="true">Group by</span>
            <SegmentedControl<Grouping>
              size="sm"
              label="Group by"
              value={group}
              onChange={(next) => update({ group: next })}
              disabled={allowedGroups.length < 2}
              options={allowedGroups.map((g) => ({ value: g, label: groupingLabel(g, state.metric) }))}
            />
          </div>
        </div>
        {result && chart ? (
          <div className={stale ? "opacity-70 transition-opacity" : undefined} aria-busy={stale}>
            <StackedBarChart
              title={chartTitle(metric, resultGroup)}
              buckets={chart.buckets}
              stepSeconds={result.range.step}
              series={chart.series}
              previous={showPrevious && chart.previous ? chart.previous : undefined}
              previousLabel={`Previous ${rangeLabel}`}
              annotations={annotations}
              hidden={hidden}
              onHiddenChange={(next) => setHiddenFor({ key: chartKey, hidden: next })}
              legend={metric !== "visitors"}
              formatValue={METRIC_INFO[metric].format}
              emptyText={EMPTY_TEXT[metric]}
            />
          </div>
        ) : queryFailed ? (
          <p className="m-0 rounded-lg border border-dashed border-line px-4 py-10 text-center text-[13px] text-soft">The chart could not be loaded.</p>
        ) : (
          <Skeleton className="h-[300px] w-full rounded-lg" aria-hidden="true" />
        )}
      </section>

      <h2 className="m-0 mt-2 text-base leading-6 font-semibold">Top dimensions</h2>
      <div className={data.top.loading && top ? "opacity-70 transition-opacity" : undefined} aria-busy={data.top.loading}>
        <TopPanels
          dimensions={top?.dimensions ?? null}
          total={top?.total ?? 0}
          loading={data.top.loading}
          failed={topFailed}
          listKey={listKey}
          onFilter={filterFromList}
        />
      </div>

      <div className="mt-2">
        <RequestLog
          rows={data.requests.data}
          loading={data.requests.loading}
          error={data.requests.error}
          withDay={!live}
          hasMore={data.requests.hasMore}
          loadingMore={data.requests.loadingMore}
          onMore={data.requests.loadMore}
          mitigatedOnly={mitigatedOnly}
          onMitigatedOnlyChange={setMitigatedOnly}
        />
      </div>

      <SaveViewDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        api={views}
        state={state}
        onSaved={(view) => navigate({ ...state, viewId: view.id }, true)}
      />
      <ManageViewsDialog open={manageOpen} onOpenChange={setManageOpen} api={views} isAdmin={isAdmin} state={state} onOpen={openView} />
    </div>
  );
}
