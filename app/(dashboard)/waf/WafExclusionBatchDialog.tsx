"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { WafExclusionSuggestionView } from "@/src/lib/waf-event-explain";
import { createWafExclusionsAction } from "./actions";

/** Where the suggested exclusions apply, in words: "on Langfuse, for requests to /api/x". */
export function suggestionScope(suggestion: Pick<WafExclusionSuggestionView, "hostName" | "path">): string {
  const where = suggestion.hostName ? `on ${suggestion.hostName}` : "on every host that follows the global settings";
  return `${where}, ${suggestion.path ? `for requests to ${suggestion.path}` : "for every request"}`;
}

/**
 * The exclusions a WAF event suggests, reviewed together: one per rule that
 * added to the score, each as narrow as the record allows (the host, the
 * exact path, the variable it matched). Untick the ones to keep; the rest are
 * added with one reason and one apply (createWafExclusionsAction, waf:write).
 */
export function WafExclusionBatchDialog({
  open,
  onOpenChange,
  suggestions,
  ruleMessages,
  defaultReason,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suggestions: readonly WafExclusionSuggestionView[];
  /** What each rule checks, by rule id. */
  ruleMessages: ReadonlyMap<number, string>;
  defaultReason: string;
  onCreated?: () => void;
}) {
  const [chosen, setChosen] = useState<ReadonlySet<number>>(() => new Set());
  const [reason, setReason] = useState(defaultReason);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    setChosen(new Set(suggestions.map((_, index) => index)));
    setReason(defaultReason);
    setError(null);
  }, [open, suggestions, defaultReason]);

  // The scope they share, said once; a suggestion with another scope says its own.
  const shared = suggestions.length > 0 && suggestions.every((s) => s.hostName === suggestions[0].hostName && s.path === suggestions[0].path) ? suggestions[0] : null;
  const count = chosen.size;

  function submit() {
    if (count === 0) return setError("Choose at least one rule.");
    if (!reason.trim()) return setError("Say why the rules are excluded, so others know when they can go.");
    setError(null);
    const picked = suggestions.filter((_, index) => chosen.has(index));
    startTransition(async () => {
      const result = await createWafExclusionsAction(
        picked.map((suggestion) => ({
          ruleId: suggestion.ruleId,
          proxyHostId: suggestion.proxyHostId,
          path: suggestion.path,
          pathMatch: suggestion.path ? suggestion.pathMatch ?? "exact" : null,
          variable: suggestion.variable,
          reason: reason.trim(),
        }))
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(result.message ?? "Rules excluded.");
      onOpenChange(false);
      onCreated?.();
    });
  }

  return (
    <Dialog open={open} onOpenChange={(value) => !pending && onOpenChange(value)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Exclude {suggestions.length === 1 ? `rule ${suggestions[0].ruleId}` : `${suggestions.length} rules`}</DialogTitle>
          <DialogDescription>
            {shared ? `Skipped only ${suggestionScope(shared)}` : "Each skipped only where it matched"}
            {suggestions.some((s) => s.variable) ? ", in the variable it matched" : ""}. Every other rule still checks these requests.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <fieldset className="m-0 flex min-w-0 flex-col gap-0 rounded-[10px] border border-line p-0">
            <legend className="sr-only">Rules to exclude</legend>
            <ul className="m-0 max-h-[46vh] list-none overflow-y-auto p-0">
              {suggestions.map((suggestion, index) => {
                const id = `waf-batch-${index}`;
                return (
                  <li key={`${suggestion.ruleId}-${suggestion.variable ?? ""}-${index}`} className="flex items-start gap-3 border-b border-line px-3 py-2.5 last:border-b-0">
                    <Checkbox
                      id={id}
                      className="mt-0.5"
                      checked={chosen.has(index)}
                      onCheckedChange={(checked) =>
                        setChosen((current) => {
                          const next = new Set(current);
                          if (checked === true) next.add(index);
                          else next.delete(index);
                          return next;
                        })
                      }
                    />
                    <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-[13px]">
                      <span>
                        <span className="num text-muted-foreground">{suggestion.ruleId}</span> {ruleMessages.get(suggestion.ruleId) ?? "Core Rule Set rule"}
                      </span>
                      {(suggestion.variable || !shared) && (
                        <span className="text-xs text-muted-foreground">
                          {!shared && suggestionScope(suggestion)}
                          {!shared && suggestion.variable && ", "}
                          {suggestion.variable && (
                            <>
                              only in <span className="num">{suggestion.variable}</span>
                            </>
                          )}
                        </span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="waf-batch-reason">Reason</Label>
            <Textarea
              id="waf-batch-reason"
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value.replace(/\n/g, " "))}
            />
          </div>
          {error && (
            <p role="alert" className="m-0 text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || count === 0}>
              {pending ? "Adding…" : count === 1 ? "Add 1 exclusion" : `Add ${count} exclusions`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
