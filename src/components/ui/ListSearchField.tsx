"use client";

import { useEffect, useRef } from "react";
import { Loader2, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The search field of a list page: "/" focuses it from anywhere on the page
 * (not while typing elsewhere), Escape clears it, a spinner shows while the
 * list catches up, and a clear button empties it.
 */
export function ListSearchField({
  value,
  onChange,
  placeholder,
  label,
  pending = false,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Accessible name, e.g. "Filter hosts". */
  label: string;
  /** The list is being updated for the search. */
  pending?: boolean;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <label className={cn("flex h-[38px] min-w-0 items-center gap-2 rounded-[10px] border border-line bg-panel px-3 text-soft focus-within:border-brand", className)}>
      {pending ? <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin" /> : <Search aria-hidden="true" className="h-4 w-4 shrink-0" />}
      <span className="sr-only">{label}</span>
      <input
        ref={input}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            onChange("");
          }
        }}
        placeholder={placeholder}
        aria-busy={pending || undefined}
        className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-soft [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button type="button" onClick={() => onChange("")} aria-label="Clear the search" className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-raise hover:text-foreground">
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      ) : (
        <kbd aria-hidden="true" className="hidden h-5 shrink-0 items-center rounded border border-line2 px-1.5 text-[11px] text-soft sm:inline-flex">
          /
        </kbd>
      )}
    </label>
  );
}
