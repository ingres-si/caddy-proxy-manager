"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HostPicker } from "@/src/components/hosts/HostPicker";
import { cn } from "@/lib/utils";
import { normalizeVariable, pathError, ruleIdError } from "@/src/lib/waf-exclusions";
import { createWafExclusionAction, updateWafExclusionAction } from "./actions";
import { Segmented } from "./Segmented";

/** The form of the dialog, as strings; `scope` is "global" or a proxy host id. */
export type WafExclusionDraft = { ruleId: string; scope: string; path: string; pathMatch: "exact" | "prefix"; variable: string; reason: string };

export const EMPTY_EXCLUSION_DRAFT: WafExclusionDraft = { ruleId: "", scope: "global", path: "", pathMatch: "prefix", variable: "", reason: "" };

/** A proxy host the exclusion can be limited to. */
export type WafExclusionHostOption = { id: number; name: string; domains: string[] };

/** A rule offered while typing the rule id: its message, and how often it matched lately. */
export type WafRuleOption = { ruleId: number; message: string | null; events?: number; topPath?: string | null };

/** The exclusion being changed: its rule and scope stay, path, variable and reason change. */
export type WafExclusionEditing = { id: number; ruleId: number; message: string | null; scopeLabel: string };

const GLOBAL_CHOICE = { value: "global", label: "Global", description: "Every host that follows or merges with the global settings" };

/**
 * "Add exclusion": one rule skipped for requests in scope (every host that
 * follows the global settings, or one proxy host, optionally one path and
 * one variable). The rule is found by its id or its name among `rules` (the
 * ones that matched lately), the host by typing its name or a domain. With
 * `fixedScope` the scope is given (a host's own page); with `editing` it
 * changes an existing exclusion's path, variable and reason. Validated here as
 * the server does, then saved with the WAF actions (waf:write).
 */
export function WafExclusionDialog({
  open,
  onOpenChange,
  hosts,
  initial = EMPTY_EXCLUSION_DRAFT,
  description = "Skip one rule for the requests in scope.",
  rules = [],
  fixedScope,
  editing,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hosts: readonly WafExclusionHostOption[];
  /** The form's values when it opens; keep the object stable while the dialog is open. */
  initial?: WafExclusionDraft;
  description?: string;
  /** Rules to offer while typing the rule id, most relevant first. */
  rules?: readonly WafRuleOption[];
  /** The scope is given and not chosen: its label, e.g. the host's name. */
  fixedScope?: string;
  editing?: WafExclusionEditing;
  onCreated?: () => void;
}) {
  const [draft, setDraft] = useState<WafExclusionDraft>(initial);
  const [formError, setFormError] = useState<string | null>(null);
  const [ruleFocused, setRuleFocused] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    setDraft(initial);
    setFormError(null);
  }, [open, initial]);

  const setField = <K extends keyof WafExclusionDraft>(key: K, value: WafExclusionDraft[K]) => setDraft((previous) => ({ ...previous, [key]: value }));

  // Rules matching what is typed, by id or by name.
  const ruleNeedle = draft.ruleId.trim().toLowerCase();
  const ruleMatches = useMemo(
    () =>
      rules
        .filter((rule) => !ruleNeedle || String(rule.ruleId).includes(ruleNeedle) || (rule.message ?? "").toLowerCase().includes(ruleNeedle))
        .slice(0, 6),
    [rules, ruleNeedle]
  );
  const pickedRule = rules.find((rule) => String(rule.ruleId) === draft.ruleId.trim());
  const showRuleList = !editing && ruleFocused && ruleMatches.length > 0 && !(pickedRule && ruleMatches.length === 1);

  function validate(): { ok: true; ruleId: number } | { ok: false; error: string } {
    const ruleId = editing ? editing.ruleId : /^\d{1,10}$/.test(draft.ruleId.trim()) ? Number(draft.ruleId.trim()) : NaN;
    const ruleError = ruleIdError(ruleId);
    if (ruleError) return { ok: false, error: ruleError.replace(/^ruleId/, "The rule id") };
    if (draft.path.trim()) {
      const error = pathError(draft.path.trim());
      if (error) return { ok: false, error: error.replace(/^path/, "The path") };
    }
    if (draft.variable.trim()) {
      const normalized = normalizeVariable(draft.variable);
      if ("error" in normalized) return { ok: false, error: normalized.error.replace(/^variable/, "The variable") };
    }
    if (!draft.reason.trim()) return { ok: false, error: "Say why the rule is excluded, so others know when it can go." };
    return { ok: true, ruleId };
  }

  function submit() {
    const checked = validate();
    if (!checked.ok) {
      setFormError(checked.error);
      return;
    }
    setFormError(null);
    const fields = {
      path: draft.path.trim() || null,
      pathMatch: draft.path.trim() ? draft.pathMatch : null,
      variable: draft.variable.trim() || null,
      reason: draft.reason.trim(),
    };
    startTransition(async () => {
      const result = editing
        ? await updateWafExclusionAction(editing.id, fields)
        : await createWafExclusionAction({ ruleId: checked.ruleId, proxyHostId: draft.scope === "global" ? null : Number(draft.scope), ...fields });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      toast.success(result.message ?? (editing ? "Exclusion changed" : "Exclusion added"));
      onOpenChange(false);
      onCreated?.();
    });
  }

  return (
    <Dialog open={open} onOpenChange={(value) => !pending && onOpenChange(value)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Change the exclusion of rule ${editing.ruleId}` : "Add exclusion"}</DialogTitle>
          <DialogDescription>{editing ? "Narrow it to a path or a variable, or widen it to every request in its scope." : description}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="waf-ex-rule">Rule</Label>
            {editing ? (
              <p className="m-0 text-[13px]">
                <span className="num text-muted-foreground">{editing.ruleId}</span> {editing.message ?? "Core Rule Set rule"}
              </p>
            ) : (
              <div className="relative">
                <Input
                  id="waf-ex-rule"
                  className="font-mono"
                  placeholder={rules.length > 0 ? "Rule id or name, e.g. 942100 or SQL injection" : "942100"}
                  value={draft.ruleId}
                  autoComplete="off"
                  role={rules.length > 0 ? "combobox" : undefined}
                  aria-expanded={rules.length > 0 ? showRuleList : undefined}
                  aria-controls={rules.length > 0 ? "waf-ex-rule-list" : undefined}
                  onFocus={() => setRuleFocused(true)}
                  onBlur={() => setRuleFocused(false)}
                  onChange={(event) => setField("ruleId", event.target.value)}
                />
                {showRuleList && (
                  <ul id="waf-ex-rule-list" role="listbox" aria-label="Rules" className="absolute inset-x-0 top-full z-50 m-0 mt-1 max-h-64 list-none overflow-y-auto rounded-lg border border-line2 bg-panel p-1 shadow-overlay">
                    {ruleMatches.map((rule) => (
                      <li
                        key={rule.ruleId}
                        role="option"
                        aria-selected={String(rule.ruleId) === draft.ruleId.trim()}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setField("ruleId", String(rule.ruleId));
                          setRuleFocused(false);
                        }}
                        className="flex cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-[13px] hover:bg-raise"
                      >
                        <span className="min-w-0 truncate">
                          <span className="num text-muted-foreground">{rule.ruleId}</span> {rule.message ?? "Core Rule Set rule"}
                        </span>
                        {(rule.events !== undefined || rule.topPath) && (
                          <span className="num truncate text-xs text-soft">
                            {rule.events !== undefined ? `${rule.events} match${rule.events === 1 ? "" : "es"} in 7 days` : ""}
                            {rule.topPath ? `${rule.events !== undefined ? " · " : ""}mostly ${rule.topPath}` : ""}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {pickedRule && <p className="m-0 mt-1 text-xs text-muted-foreground">{pickedRule.message ?? "Core Rule Set rule"}</p>}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="waf-ex-scope">Applies to</Label>
            {editing || fixedScope ? (
              <p id="waf-ex-scope" className="m-0 text-[13px]">
                {editing ? editing.scopeLabel : fixedScope}
              </p>
            ) : (
              <HostPicker id="waf-ex-scope" hosts={hosts} value={draft.scope} onChange={(value) => setField("scope", value)} extras={[GLOBAL_CHOICE]} />
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="waf-ex-path">
              Path <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <div className="flex flex-wrap gap-2">
              <Input
                id="waf-ex-path"
                className="min-w-0 flex-1 font-mono"
                placeholder={pickedRule?.topPath ?? "/api/public/"}
                value={draft.path}
                onChange={(event) => setField("path", event.target.value)}
              />
              <Segmented
                label="Path match"
                value={draft.pathMatch}
                onChange={(value) => setField("pathMatch", value as WafExclusionDraft["pathMatch"])}
                disabled={!draft.path.trim()}
                options={[
                  { value: "prefix", label: "Starts with" },
                  { value: "exact", label: "Exactly" },
                ]}
              />
            </div>
            <span className={cn("text-xs text-muted-foreground")}>
              Without the query string. Empty: every path.
              {pickedRule?.topPath && !draft.path.trim() && (
                <>
                  {" "}
                  <button type="button" className="text-brand underline-offset-4 hover:underline" onClick={() => setField("path", pickedRule.topPath!)}>
                    Use {pickedRule.topPath}
                  </button>
                </>
              )}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="waf-ex-variable">
              Variable <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="waf-ex-variable"
              className="font-mono"
              placeholder="ARGS:content"
              value={draft.variable}
              onChange={(event) => setField("variable", event.target.value)}
            />
            <span className="text-xs text-muted-foreground">
              Such as <span className="font-mono">ARGS:name</span>, <span className="font-mono">REQUEST_HEADERS:name</span> or{" "}
              <span className="font-mono">REQUEST_COOKIES:name</span>. Empty: every variable.
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="waf-ex-reason">Reason</Label>
            <Textarea
              id="waf-ex-reason"
              rows={2}
              maxLength={500}
              placeholder="Runbook pages quote SQL queries in the page body"
              value={draft.reason}
              onChange={(event) => setField("reason", event.target.value.replace(/\n/g, " "))}
            />
          </div>
          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {editing ? "Save changes" : "Add exclusion"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
