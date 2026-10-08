"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** One tab of the bar: an anchor (#routing …) that switches in place. */
export function TabAnchor({ id, current, onSelect, title, children }: { id: string; current: boolean; onSelect: () => void; title?: string; children: ReactNode }) {
  return (
    <a
      href={`#${id}`}
      role="tab"
      aria-selected={current}
      title={title}
      onClick={(event) => {
        event.preventDefault();
        onSelect();
      }}
      className={cn(
        "-mb-px flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm no-underline transition-colors",
        current ? "border-brand font-semibold text-foreground" : "border-transparent font-medium text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </a>
  );
}
