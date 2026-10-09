"use client";

/**
 * Choosing proxy hosts by typing: a search over names and domains with the
 * matches in a list (arrow keys, Enter, Escape), instead of scrolling a long
 * dropdown. HostPicker chooses one (with optional extra choices such as
 * "Global"); HostMultiPicker chooses several, shown as removable chips.
 */
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export type PickableHost = { id: number; name: string; domains?: readonly string[] };

/** A choice that is not a host, such as "Global". */
export type ExtraChoice = { value: string; label: string; description?: string };

const MAX_SHOWN = 50;

function matches(host: PickableHost, needle: string): boolean {
  if (!needle) return true;
  return host.name.toLowerCase().includes(needle) || (host.domains ?? []).some((domain) => domain.toLowerCase().includes(needle));
}

/** The host's name, and its first domain when that says something else. */
function HostLabel({ host }: { host: PickableHost }) {
  const domain = host.domains?.[0];
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate">{host.name}</span>
      {domain && domain !== host.name && <span className="num truncate text-xs text-soft">{domain}{(host.domains?.length ?? 0) > 1 ? ` +${host.domains!.length - 1}` : ""}</span>}
    </span>
  );
}

type Option = { key: string; label: ReactNode; text: string; selected: boolean; onPick: () => void };

/** The search field and the list of matches, with keyboard navigation. */
function SearchList({ options, query, onQuery, placeholder, label, empty, footer }: {
  options: Option[];
  query: string;
  onQuery: (value: string) => void;
  placeholder: string;
  label: string;
  empty: string;
  footer?: ReactNode;
}) {
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const index = Math.min(active, Math.max(0, options.length - 1));

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = options.length === 0 ? 0 : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      setActive(next);
      listRef.current?.querySelectorAll("li")[next]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      options[index]?.onPick();
    }
  }

  return (
    <div className="flex flex-col">
      <label className="flex items-center gap-2 border-b border-line px-2.5">
        <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-soft" />
        <span className="sr-only">{label}</span>
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={options[index] ? `${listId}-${index}` : undefined}
          value={query}
          onChange={(event) => {
            onQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="h-9 min-w-0 flex-1 border-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-soft"
        />
      </label>
      <ul ref={listRef} id={listId} role="listbox" aria-label={label} className="m-0 max-h-64 list-none overflow-y-auto p-1">
        {options.length === 0 && <li className="px-2.5 py-2 text-[13px] text-muted-foreground">{empty}</li>}
        {options.map((option, i) => (
          <li
            key={option.key}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={option.selected}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={option.onPick}
            className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px]", i === index && "bg-raise")}
          >
            <Check aria-hidden="true" className={cn("h-3.5 w-3.5 shrink-0 text-brand", !option.selected && "invisible")} />
            {option.label}
          </li>
        ))}
      </ul>
      {footer}
    </div>
  );
}

/** One proxy host (or an extra choice such as "Global"), found by typing part of its name or a domain. */
export function HostPicker({
  id,
  hosts,
  value,
  onChange,
  extras = [],
  placeholder = "Choose a proxy host",
  disabled,
}: {
  id?: string;
  hosts: readonly PickableHost[];
  /** A host id as a string, or the value of an extra choice. */
  value: string;
  onChange: (value: string) => void;
  extras?: readonly ExtraChoice[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const chosenExtra = extras.find((extra) => extra.value === value);
  const chosenHost = chosenExtra ? undefined : hosts.find((host) => String(host.id) === value);
  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery("");
  };
  const found = useMemo(() => hosts.filter((host) => matches(host, needle)), [hosts, needle]);
  const options: Option[] = [
    ...extras
      .filter((extra) => !needle || extra.label.toLowerCase().includes(needle))
      .map((extra) => ({
        key: `extra-${extra.value}`,
        text: extra.label,
        selected: extra.value === value,
        onPick: () => pick(extra.value),
        label: (
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{extra.label}</span>
            {extra.description && <span className="truncate text-xs text-soft">{extra.description}</span>}
          </span>
        ),
      })),
    ...found.slice(0, MAX_SHOWN).map((host) => ({
      key: `host-${host.id}`,
      text: host.name,
      selected: String(host.id) === value,
      onPick: () => pick(String(host.id)),
      label: <HostLabel host={host} />,
    })),
  ];
  return (
    <Popover open={open} onOpenChange={(next) => !disabled && (setOpen(next), next || setQuery(""))}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          className="flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-line2 bg-panel px-3 text-left text-[13px] transition-colors hover:border-soft/60 focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-tint disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className={cn("min-w-0 truncate", !chosenExtra && !chosenHost && "text-soft")}>
            {chosenExtra ? chosenExtra.label : chosenHost ? `${chosenHost.name}${chosenHost.domains?.[0] && chosenHost.domains[0] !== chosenHost.name ? ` (${chosenHost.domains[0]})` : ""}` : placeholder}
          </span>
          <ChevronsUpDown aria-hidden="true" className="h-4 w-4 shrink-0 text-soft" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-[var(--radix-popover-trigger-width)] min-w-[280px] p-0">
        <SearchList
          options={options}
          query={query}
          onQuery={setQuery}
          placeholder="Search names and domains"
          label="Proxy hosts"
          empty="No proxy host matches."
          footer={found.length > MAX_SHOWN ? <p className="m-0 border-t border-line px-3 py-2 text-xs text-soft">{found.length - MAX_SHOWN} more: type to narrow.</p> : undefined}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Several proxy hosts: the chosen ones as chips, more found by typing. */
export function HostMultiPicker({
  hosts,
  value,
  onChange,
  max,
  label = "Proxy hosts",
}: {
  hosts: readonly PickableHost[];
  value: readonly number[];
  onChange: (value: number[]) => void;
  /** At most this many may be chosen. */
  max?: number;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const byId = useMemo(() => new Map(hosts.map((host) => [host.id, host])), [hosts]);
  const chosen = new Set(value);
  const full = max !== undefined && value.length >= max;
  const toggle = (id: number) => onChange(chosen.has(id) ? value.filter((existing) => existing !== id) : full ? [...value] : [...value, id]);
  const found = hosts.filter((host) => matches(host, needle));
  const options: Option[] = found.slice(0, MAX_SHOWN).map((host) => ({
    key: `host-${host.id}`,
    text: host.name,
    selected: chosen.has(host.id),
    onPick: () => toggle(host.id),
    label: <HostLabel host={host} />,
  }));
  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label={`Chosen ${label.toLowerCase()}`}>
          {value.map((id) => {
            const host = byId.get(id);
            return (
              <li key={id} className="inline-flex h-7 max-w-full items-center gap-1 rounded-lg border border-line2 bg-panel2 pl-2.5 pr-1 text-[13px]">
                <span className="min-w-0 truncate">{host ? host.name : `Host #${id} (not listed)`}</span>
                <button
                  type="button"
                  aria-label={`Remove ${host?.name ?? `host #${id}`}`}
                  onClick={() => onChange(value.filter((existing) => existing !== id))}
                  className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-raise hover:text-foreground"
                >
                  <X aria-hidden="true" className="h-3 w-3" strokeWidth={2.4} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Popover open={open} onOpenChange={(next) => (setOpen(next), next || setQuery(""))}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-haspopup="listbox"
            className="flex h-9 w-full items-center gap-2 rounded-lg border border-dashed border-line2 bg-transparent px-3 text-left text-[13px] text-muted-foreground transition-colors hover:bg-raise hover:text-foreground"
          >
            <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
            {value.length === 0 ? "Search and choose proxy hosts" : "Choose more proxy hosts"}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={4} className="w-[var(--radix-popover-trigger-width)] min-w-[280px] p-0">
          <SearchList
            options={options}
            query={query}
            onQuery={setQuery}
            placeholder="Search names and domains"
            label={label}
            empty="No proxy host matches."
            footer={
              <p className="m-0 border-t border-line px-3 py-2 text-xs text-soft">
                {value.length} chosen{max !== undefined ? `, up to ${max}` : ""}
                {found.length > MAX_SHOWN ? `. ${found.length - MAX_SHOWN} more: type to narrow.` : "."}
              </p>
            }
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
