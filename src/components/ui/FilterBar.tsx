"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, Filter as FilterIcon, Plus, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl } from "@/components/ui/SegmentedControl";

export type FilterOperator = "is" | "is not" | "contains" | "does not contain";

/** The operator that does the opposite: "is" and "is not", "contains" and "does not contain". */
export function oppositeOperator(operator: FilterOperator): FilterOperator {
  return operator === "is" ? "is not" : operator === "is not" ? "is" : operator === "contains" ? "does not contain" : "contains";
}

/** Values found for a search, grouped by dimension, with how many requests have each. */
export type FilterSearchResult = { dimension: string; values: { value: string; count: number }[] }[];

/** One filter: a dimension (by key), whether it includes or excludes, and the value. */
export type ActiveFilter = {
  /** The dimension's key, e.g. "host". */
  dimension: string;
  operator: FilterOperator;
  value: string;
};

export type FilterDimension = {
  key: string;
  /** Shown in the menu and on chips, e.g. "Host". */
  label: string;
  /** Values offered while typing (the top values of the current view). */
  suggestions?: readonly string[];
  /** Values are addresses, paths or codes: show them in mono. Default true. */
  mono?: boolean;
  /** Placeholder of the value field, e.g. "app.example.com". */
  placeholder?: string;
  /** The dimension can be matched by part of its text ("contains"). */
  searchable?: boolean;
};

export type FilterChipProps = {
  /** The dimension's label, e.g. "Host". */
  dimension: string;
  operator: FilterOperator;
  value: string;
  /** Shows a remove button (labelled "Remove filter: Host is app.example.com"). */
  onRemove?: () => void;
  /** Makes the operator a button that turns the filter around (is ↔ is not, contains ↔ does not contain). */
  onInvert?: () => void;
  /** Mono value. Default true. */
  mono?: boolean;
  className?: string;
};

/** "Host · is · app.example.com": a filter in effect, with an optional remove button. */
export function FilterChip({ dimension, operator, value, onRemove, onInvert, mono = true, className }: FilterChipProps) {
  const positive = operator === "is" || operator === "contains";
  return (
    <span
      className={cn(
        "inline-flex h-[30px] max-w-full items-center gap-1.5 rounded-lg border border-line2 bg-panel2 pl-2.5 text-[13px] leading-5",
        onRemove ? "pr-1" : "pr-2.5",
        className
      )}
    >
      <span className="shrink-0 text-muted-foreground">{dimension}</span>
      {onInvert ? (
        <button
          type="button"
          onClick={onInvert}
          title={`Change to "${oppositeOperator(operator)}"`}
          aria-label={`${dimension} ${operator} ${value}: change to ${oppositeOperator(operator)}`}
          className={cn("shrink-0 rounded px-0.5 font-semibold underline-offset-4 hover:underline", positive ? "text-brand" : "text-waf-ink")}
        >
          {operator}
        </button>
      ) : (
        <span className={cn("shrink-0 font-semibold", positive ? "text-brand" : "text-waf-ink")}>{operator}</span>
      )}
      <span className={cn("min-w-0 truncate", mono && "num")}>{value}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove filter: ${dimension} ${operator} ${value}`}
          className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-raise hover:text-foreground"
        >
          <X aria-hidden="true" className="h-3 w-3" strokeWidth={2.4} />
        </button>
      )}
    </span>
  );
}

export type FilterBarProps = {
  filters: readonly ActiveFilter[];
  /** What can be filtered on, in menu order. */
  dimensions: readonly FilterDimension[];
  /** Called with a new filter from the add-filter form. Without it there is no add button. */
  onAdd?: (filter: ActiveFilter) => void;
  /** Called when a chip's remove button is pressed. Without it chips have no remove button. */
  onRemove?: (filter: ActiveFilter, index: number) => void;
  /** Called when a chip's operator is clicked, with the filter turned around. Without it the operator is plain text. */
  onInvert?: (filter: ActiveFilter, index: number) => void;
  /**
   * Finds values containing the typed text (debounced). With it the bar has a
   * search box: "contains" choices for the searchable dimensions and the
   * values found, each one click from a filter; the dimension menu becomes
   * "More filters".
   */
  onSearch?: (query: string) => Promise<FilterSearchResult>;
  /** Content at the end of the row, e.g. the live status and a "Save view" link. */
  trailing?: ReactNode;
  /** Text of the add button. Default "Add filter". */
  addLabel?: string;
  /** Accessible name of the bar. Default "Filters". */
  label?: string;
  className?: string;
};

/**
 * The filter row of a data page: chips for the filters in effect and an
 * "Add filter" button. The button opens a menu of dimensions; picking one
 * shows a small form (is / is not, and the value, with suggestions).
 */
export function FilterBar({
  filters,
  dimensions,
  onAdd,
  onRemove,
  onInvert,
  onSearch,
  trailing,
  addLabel = "Add filter",
  label = "Filters",
  className,
}: FilterBarProps) {
  const byKey = new Map(dimensions.map((dimension) => [dimension.key, dimension]));
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-2.5 py-2", className)}
    >
      <FilterIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-soft" strokeWidth={2} />
      {filters.map((filter, index) => {
        const dimension = byKey.get(filter.dimension);
        return (
          <FilterChip
            key={`${filter.dimension}-${filter.operator}-${filter.value}-${index}`}
            dimension={dimension?.label ?? filter.dimension}
            operator={filter.operator}
            value={filter.value}
            mono={dimension?.mono ?? true}
            onRemove={onRemove ? () => onRemove(filter, index) : undefined}
            onInvert={onInvert ? () => onInvert({ ...filter, operator: oppositeOperator(filter.operator) }, index) : undefined}
          />
        );
      })}
      {onAdd && onSearch && <SearchFilter dimensions={dimensions} onAdd={onAdd} onSearch={onSearch} />}
      {onAdd && dimensions.length > 0 && <AddFilter dimensions={dimensions} onAdd={onAdd} label={onSearch ? "More filters" : addLabel} />}
      {trailing && <div className="ml-auto flex flex-wrap items-center gap-3.5 text-[13px] text-soft">{trailing}</div>}
    </div>
  );
}

function AddFilter({ dimensions, onAdd, label }: { dimensions: readonly FilterDimension[]; onAdd: (filter: ActiveFilter) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<FilterDimension | null>(null);
  const [operator, setOperator] = useState<FilterOperator>("is");
  const [value, setValue] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const formId = useId();

  const reset = () => {
    setPicked(null);
    setOperator("is");
    setValue("");
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) reset();
  };

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home" ? 0
        : event.key === "End" ? items.length - 1
          : event.key === "ArrowDown" ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!picked || !trimmed) return;
    onAdd({ dimension: picked.key, operator, value: trimmed });
    onOpenChange(false);
  };

  const listId = `${formId}-suggestions`;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-[30px] items-center gap-1.5 rounded-lg border border-dashed border-line2 bg-transparent px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-raise hover:text-foreground"
        >
          <Plus aria-hidden="true" className="h-[13px] w-[13px]" strokeWidth={2.4} />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[260px] p-1.5">
        {picked === null ? (
          <div ref={listRef} onKeyDown={moveFocus} className="flex flex-col">
            <div className="px-2.5 pt-1 pb-1.5 text-xs text-soft" id={`${formId}-heading`}>
              Filter by
            </div>
            <div role="group" aria-labelledby={`${formId}-heading`} className="flex max-h-72 flex-col overflow-y-auto">
              {dimensions.map((dimension) => (
                <button
                  key={dimension.key}
                  type="button"
                  onClick={() => setPicked(dimension)}
                  className="h-8 shrink-0 rounded-md px-2.5 text-left text-[13px] transition-colors hover:bg-raise focus-visible:bg-raise"
                >
                  {dimension.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-2.5 p-1.5" aria-label={`Filter by ${picked.label}`}>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPicked(null)}
                aria-label="Back to the dimensions"
                className="-ml-1 grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-raise hover:text-foreground"
              >
                <ChevronLeft aria-hidden="true" className="h-4 w-4" />
              </button>
              <span className="text-[13px] font-semibold">{picked.label}</span>
            </div>
            <SegmentedControl
              size="sm"
              label="Match"
              value={operator}
              onChange={setOperator}
              options={[
                { value: "is", label: "is" },
                { value: "is not", label: "is not" },
                ...(picked.searchable
                  ? [
                      { value: "contains" as const, label: "contains" },
                      { value: "does not contain" as const, label: "does not contain" },
                    ]
                  : []),
              ]}
              className="self-start"
            />
            <Input
              autoFocus
              aria-label={`${picked.label} value`}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={picked.placeholder}
              list={picked.suggestions && picked.suggestions.length > 0 ? listId : undefined}
              className={cn("h-8", (picked.mono ?? true) && "num")}
              autoComplete="off"
              spellCheck={false}
            />
            {picked.suggestions && picked.suggestions.length > 0 && (
              <datalist id={listId}>
                {picked.suggestions.map((suggestion) => (
                  <option key={suggestion} value={suggestion} />
                ))}
              </datalist>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!value.trim()}>
                Add
              </Button>
            </div>
          </form>
        )}
      </PopoverContent>
    </Popover>
  );
}

type SearchChoice = { key: string; filter: ActiveFilter; label: ReactNode; count?: number };

/**
 * The search box of the filter bar: type part of a host, path, address or
 * user agent, then pick "… contains <text>" or one of the values found
 * (most requested first). Enter takes the highlighted choice.
 */
function SearchFilter({ dimensions, onAdd, onSearch }: { dimensions: readonly FilterDimension[]; onAdd: (filter: ActiveFilter) => void; onSearch: (query: string) => Promise<FilterSearchResult> }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<FilterSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const run = useRef(0);
  const byKey = new Map(dimensions.map((dimension) => [dimension.key, dimension]));
  const text = query.trim();

  useEffect(() => {
    if (!text) {
      setResults(null);
      setLoading(false);
      return;
    }
    const id = ++run.current;
    setLoading(true);
    const timer = setTimeout(() => {
      onSearch(text)
        .then((found) => id === run.current && setResults(found))
        .catch(() => id === run.current && setResults([]))
        .finally(() => id === run.current && setLoading(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [text, onSearch]);

  const choices: SearchChoice[] = text
    ? [
        ...dimensions
          // Until the search answers, every searchable dimension; then only those with a match.
          .filter((dimension) => dimension.searchable && (results === null || results.some((group) => group.dimension === dimension.key && group.values.length > 0)))
          .map((dimension) => ({
            key: `contains-${dimension.key}`,
            filter: { dimension: dimension.key, operator: "contains" as const, value: text },
            label: (
              <>
                <span className="text-muted-foreground">{dimension.label}</span> <span className="font-semibold text-brand">contains</span>{" "}
                <span className={cn((dimension.mono ?? true) && "num")}>{text}</span>
              </>
            ),
          })),
        ...(results ?? []).flatMap((group) =>
          group.values.map((found) => {
            const dimension = byKey.get(group.dimension);
            return {
              key: `value-${group.dimension}-${found.value}`,
              filter: { dimension: group.dimension, operator: "is" as const, value: found.value },
              count: found.count,
              label: (
                <>
                  <span className="text-muted-foreground">{dimension?.label ?? group.dimension}</span>{" "}
                  <span className={cn("min-w-0 truncate", (dimension?.mono ?? true) && "num")}>{found.value}</span>
                </>
              ),
            };
          })
        ),
      ]
    : [];
  const index = Math.min(active, Math.max(0, choices.length - 1));

  function pick(choice: SearchChoice | undefined) {
    if (!choice) return;
    onAdd(choice.filter);
    setQuery("");
    setOpen(false);
    setActive(0);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (choices.length > 0) setActive((index + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(choices[index]);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  const showList = open && text.length > 0;
  return (
    <div className="relative min-w-[220px] flex-[1_1_260px]">
      <label className="flex h-[30px] items-center gap-1.5 rounded-lg border border-line2 bg-panel2 px-2.5 focus-within:border-brand">
        <Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-soft" />
        <span className="sr-only">Search values to filter by</span>
        <input
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={showList && choices[index] ? `${listId}-${index}` : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          placeholder="Filter by host, path, IP or user agent…"
          autoComplete="off"
          spellCheck={false}
          className="h-full min-w-0 flex-1 border-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-soft"
        />
      </label>
      {showList && (
        <ul id={listId} role="listbox" aria-label="Filters to add" className="absolute left-0 top-full z-50 m-0 mt-1 max-h-80 w-full min-w-[320px] list-none overflow-y-auto rounded-lg border border-line2 bg-panel p-1 shadow-overlay">
          {choices.map((choice, i) => (
            <li
              key={choice.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === index}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(choice)}
              className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px]", i === index && "bg-raise")}
            >
              <span className="flex min-w-0 flex-1 items-baseline gap-1 truncate">{choice.label}</span>
              {choice.count !== undefined && <span className="num shrink-0 text-xs text-soft">{choice.count.toLocaleString("en-US")}</span>}
            </li>
          ))}
          {loading && <li className="px-2.5 py-1.5 text-xs text-soft">Searching…</li>}
          {!loading && results !== null && results.every((group) => group.values.length === 0) && (
            <li className="px-2.5 py-1.5 text-xs text-soft">No host, path, address or user agent in this period contains “{text}”.</li>
          )}
        </ul>
      )}
    </div>
  );
}
