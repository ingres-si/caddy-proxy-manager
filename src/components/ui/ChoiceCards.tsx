"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ChoiceCard<T extends string> = {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  /** A small pill after the label, e.g. "Recommended". */
  badge?: ReactNode;
  /** A coloured dot before the label (a tone such as "bg-warn"). */
  dot?: string;
};

/**
 * One choice among a few, each with a line that says what it does: cards in
 * a radio group, the chosen one outlined in the brand colour. Used wherever a
 * mode is picked (the WAF's global mode, a host's WAF mode), so they look and
 * behave the same.
 */
export function ChoiceCards<T extends string>({
  label,
  labelledBy,
  value,
  options,
  onChange,
  disabled = false,
  minWidth = 200,
  id,
}: {
  /** The group's accessible name, when no visible label names it (labelledBy). */
  label?: string;
  labelledBy?: string;
  value: T;
  options: readonly ChoiceCard<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** The narrowest a card gets before they wrap, in pixels. */
  minWidth?: number;
  id?: string;
}) {
  return (
    <div
      id={id}
      tabIndex={id ? -1 : undefined}
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      className="grid gap-2.5"
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(${minWidth}px, 100%), 1fr))` }}
    >
      {options.map((option) => {
        const checked = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              checked ? "border-brand bg-brand-tint" : "border-line hover:border-line2 hover:bg-panel2"
            )}
          >
            <span className={cn("flex items-center gap-2 font-semibold", !checked && "text-muted-foreground")}>
              <span aria-hidden="true" className={cn("grid h-4 w-4 shrink-0 place-items-center rounded-full border-2", checked ? "border-brand" : "border-line2")}>
                <span className={cn("h-1.5 w-1.5 rounded-full", checked && "bg-brand")} />
              </span>
              {option.dot && <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", option.dot)} />}
              {option.label}
              {option.badge && <span className="rounded-full bg-brand-tint px-1.5 text-[11px] font-semibold leading-[18px] text-brand">{option.badge}</span>}
            </span>
            {option.description && <span className="text-xs leading-[17px] text-muted-foreground">{option.description}</span>}
          </button>
        );
      })}
    </div>
  );
}
