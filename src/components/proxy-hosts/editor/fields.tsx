"use client";

/**
 * The host editor's building blocks: a context with the form, its errors and
 * what changed, and labelled fields that wire up ids, hints, errors
 * (aria-describedby, aria-invalid) and the "Was …" hint of a changed setting.
 */
import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { FieldErrors } from "./validate";
import type { HostEditorData } from "./types";
import type { HostForm } from "./model";
import type { ChangeLookup } from "./changes";

export type EditorContextValue = {
  form: HostForm;
  saved: HostForm;
  data: HostEditorData;
  lookup: ChangeLookup;
  /** Replaces the form (every edit goes through it). */
  update: (recipe: (form: HostForm) => HostForm) => void;
  /** Errors to show now (fields the user left, or all of them after a save attempt). */
  errors: FieldErrors;
  /** Marks a field as visited, so its error shows. */
  touch: (id: string) => void;
  /** "Was …" for a changed group, or null. */
  wasOf: (groupId: string) => string | null;
};

const EditorContext = createContext<EditorContextValue | null>(null);

/**
 * What the fields below need from the form they are in: its errors, a way to
 * mark a field visited, and the "Was …" of a changed setting. The host editor
 * provides it; another form (the L4 host editor) provides its own with
 * FieldsProvider, and fields outside any show no errors.
 */
export type FieldsContextValue = {
  errors: Readonly<Record<string, { message: string }>>;
  touch: (id: string) => void;
  wasOf: (groupId: string) => string | null;
};

const NO_FIELDS: FieldsContextValue = { errors: {}, touch: () => {}, wasOf: () => null };
const FieldsContext = createContext<FieldsContextValue>(NO_FIELDS);

export function FieldsProvider({ value, children }: { value: FieldsContextValue; children: ReactNode }) {
  return <FieldsContext.Provider value={value}>{children}</FieldsContext.Provider>;
}

export function EditorProvider({ value, children }: { value: EditorContextValue; children: ReactNode }) {
  return (
    <EditorContext.Provider value={value}>
      <FieldsProvider value={value}>{children}</FieldsProvider>
    </EditorContext.Provider>
  );
}

export function useEditor(): EditorContextValue {
  const value = useContext(EditorContext);
  if (!value) throw new Error("useEditor outside the host editor");
  return value;
}

/** Props that tie an input to its hint and error. */
export function useFieldProps(id: string, hint?: boolean) {
  const { errors, touch } = useContext(FieldsContext);
  const error = errors[id];
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy || undefined,
    onBlur: () => touch(id),
  } as const;
}

export function FieldError({ id }: { id: string }) {
  const { errors } = useContext(FieldsContext);
  const error = errors[id];
  if (!error) return null;
  return (
    <p id={`${id}-error`} className="m-0 text-xs leading-4 text-bad">
      {error.message}
    </p>
  );
}

export function WasHint({ group }: { group: string }) {
  const { wasOf } = useContext(FieldsContext);
  const was = wasOf(group);
  if (!was) return null;
  return <span className="text-xs font-medium text-brand">Was {was}</span>;
}

/** A label, the control (given the field's id), a hint and the error. */
export function Field({
  id,
  label,
  hint,
  was,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  /** The change group whose "Was …" shows next to the label. */
  was?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className="flex flex-wrap items-center gap-2 text-[13px] font-medium leading-5">
        {label}
        {was && <WasHint group={was} />}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="m-0 text-xs leading-4 text-soft">
          {hint}
        </p>
      )}
      <FieldError id={id} />
    </div>
  );
}

/** A text input with its label, hint and error. */
export function TextField({
  id,
  label,
  value,
  onChange,
  hint,
  placeholder,
  mono = false,
  type = "text",
  inputMode,
  disabled,
  was,
  className,
  autoComplete = "off",
  name,
}: {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  /** The input's name (kept from the older host form for scripts that select by it). */
  name?: string;
  hint?: ReactNode;
  placeholder?: string;
  mono?: boolean;
  type?: "text" | "number" | "password" | "url";
  inputMode?: "numeric" | "text" | "url";
  disabled?: boolean;
  was?: string;
  className?: string;
  autoComplete?: string;
}) {
  const props = useFieldProps(id, Boolean(hint));
  return (
    <Field id={id} label={label} hint={hint} was={was} className={className}>
      <Input
        {...props}
        name={name}
        type={type}
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete={autoComplete}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        className={cn(mono && "num")}
      />
    </Field>
  );
}

/** A setting that is on or off: its name, what it does, and a switch named after it. */
export function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange,
  was,
  disabled,
  className,
}: {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  was?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start gap-3.5 py-3", className)}>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={`${id}-label`} className="flex flex-wrap items-center gap-2 font-medium">
          {label}
          {was && <WasHint group={was} />}
        </span>
        {description && (
          <span id={`${id}-desc`} className="text-[13px] text-muted-foreground">
            {description}
          </span>
        )}
      </span>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-desc` : undefined}
        className="mt-0.5"
      />
    </div>
  );
}

/** A card of the editor: a titled section of the page, linkable by id. */
export function EditorCard({
  id,
  title,
  description,
  actions,
  was,
  children,
  flush = false,
  className,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  was?: string;
  children?: ReactNode;
  /** Content runs edge to edge (tables, row lists) instead of being padded. */
  flush?: boolean;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section
      id={id}
      tabIndex={id ? -1 : undefined}
      aria-labelledby={headingId}
      className={cn("min-w-0 scroll-mt-20 rounded-2xl border border-line bg-panel outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
    >
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2 px-5 pb-3 pt-4">
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-0.5">
          <h3 id={headingId} className="m-0 flex flex-wrap items-center gap-2 text-base font-semibold leading-6">
            {title}
            {was && <WasHint group={was} />}
          </h3>
          {description && <p className="m-0 text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children !== undefined && children !== null && children !== false && (
        <div className={cn(flush ? "border-t border-line" : "flex flex-col gap-4 px-5 pb-5")}>{children}</div>
      )}
    </section>
  );
}

/** Values as removable chips, with an input to add more (Enter, comma or the Add button; pasted lists are split). */
export function ChipInput({
  id,
  label,
  values,
  onChange,
  placeholder,
  addLabel = "Add",
  normalize = (value) => value.trim(),
  isNew,
  mono = true,
  hint,
  testId,
  listLabel,
}: {
  id: string;
  label: string;
  /** Names the list of chips for screen readers; defaults to the input's label. */
  listLabel?: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  addLabel?: string;
  normalize?: (value: string) => string;
  /** Marks chips that are not saved yet. */
  isNew?: (value: string) => boolean;
  mono?: boolean;
  hint?: ReactNode;
  testId?: string;
}) {
  const [draft, setDraft] = useState("");
  const props = useFieldProps(id, Boolean(hint));
  const commit = (raw: string) => {
    const parts = raw
      .split(/[\s,]+/)
      .map(normalize)
      .filter(Boolean);
    if (parts.length === 0) {
      setDraft("");
      return;
    }
    const next = [...values];
    for (const part of parts) if (!next.includes(part)) next.push(part);
    if (next.length !== values.length) onChange(next);
    setDraft("");
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {values.length > 0 && (
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label={listLabel ?? label}>
            {values.map((value) => {
              const fresh = isNew?.(value) ?? false;
              return (
                <li
                  key={value}
                  className={cn(
                    "inline-flex h-[30px] items-center gap-1.5 rounded-lg border pl-2.5 pr-1 text-[13px]",
                    fresh ? "border-brand bg-brand-tint" : "border-line2 bg-panel2"
                  )}
                >
                  <span className={cn(mono && "num")}>{value}</span>
                  {fresh && <span className="text-[11px] font-semibold text-brand">new</span>}
                  <button
                    type="button"
                    onClick={() => onChange(values.filter((item) => item !== value))}
                    aria-label={`Remove ${value}`}
                    className="grid h-[22px] w-[22px] place-items-center rounded-md text-muted-foreground transition-colors hover:bg-raise hover:text-foreground"
                  >
                    <X aria-hidden="true" className="h-3 w-3" strokeWidth={2.4} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <span className="flex min-w-0 flex-[1_1_220px] items-center gap-1.5">
          <label htmlFor={id} className="sr-only">
            {label}
          </label>
          <Input
            {...props}
            data-testid={testId}
            value={draft}
            placeholder={placeholder}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                commit(draft);
              } else if (event.key === "Backspace" && !draft && values.length > 0) {
                onChange(values.slice(0, -1));
              }
            }}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData("text");
              if (/[\s,]/.test(pasted.trim())) {
                event.preventDefault();
                commit(`${draft}${pasted}`);
              }
            }}
            onBlur={() => {
              props.onBlur();
              if (draft.trim()) commit(draft);
            }}
            className={cn("h-[30px] min-w-0 flex-1 border-dashed bg-transparent", mono && "num")}
          />
          <button
            type="button"
            onClick={() => commit(draft)}
            className="h-[30px] shrink-0 rounded-lg border border-line2 bg-panel2 px-2.5 text-[13px] transition-colors hover:bg-raise"
          >
            {addLabel}
          </button>
        </span>
      </div>
      {hint && (
        <p id={`${id}-hint`} className="m-0 text-xs leading-4 text-soft">
          {hint}
        </p>
      )}
      <FieldError id={id} />
    </div>
  );
}

/** A small "+ Add …" button for row lists. */
export function AddButton({ onClick, children, disabled }: { onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line2 bg-panel2 px-3 text-[13px] transition-colors hover:bg-raise disabled:cursor-not-allowed disabled:opacity-50"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-none stroke-current" strokeWidth={2.4} strokeLinecap="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
      {children}
    </button>
  );
}

/** An icon button that removes a row; its name says which. */
export function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-raise hover:text-foreground"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
      </svg>
    </button>
  );
}
