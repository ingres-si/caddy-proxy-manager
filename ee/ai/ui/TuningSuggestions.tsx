// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Lock, Sparkles, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AppDialog } from "@/components/ui/AppDialog";
import { formatDateTimeUtc } from "@/src/lib/date-format";
import type { SuggestionConfidence, WafTuningSuggestionView } from "@/ee/ai/types";
import { applyTuningSuggestionAction, dismissTuningSuggestionAction, generateTuningSuggestionsAction } from "./tuning-actions";

const CONFIDENCE_VARIANT: Record<SuggestionConfidence, "success" | "warning" | "secondary"> = {
  high: "success",
  medium: "warning",
  low: "secondary",
};

type Props = {
  initialSuggestions: WafTuningSuggestionView[];
  /** Holds waf:write (finding, applying and dismissing change the WAF). Default true. */
  canWrite?: boolean;
  analyticsEnabled: boolean;
  aiConfigured: boolean;
  onApplied?: (ruleId: number, host: string) => void;
};

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[0.62rem] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-sm font-mono">{value}</p>
    </div>
  );
}

export default function TuningSuggestions({ initialSuggestions, canWrite = true, analyticsEnabled, aiConfigured, onApplied }: Props) {
  const [pending, startTransition] = useTransition();
  const [suggestions, setSuggestions] = useState(initialSuggestions);
  const [explain, setExplain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<WafTuningSuggestionView | null>(null);

  function generate() {
    setError(null);
    startTransition(async () => {
      const result = await generateTuningSuggestionsAction(explain && aiConfigured);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.value.error) {
        setError(result.value.error);
        return;
      }
      setSuggestions(result.value.suggestions);
      if (!result.value.analyticsEnabled) setError("Analytics are off, so there are no WAF events to analyze.");
      else if (result.value.explanationError) toast.error(`Some AI risk assessments are missing: ${result.value.explanationError}`);
      else toast.success(`${result.value.suggestions.length} suggestion(s) from the last ${result.value.windowDays} days`);
    });
  }

  function apply(suggestion: WafTuningSuggestionView) {
    startTransition(async () => {
      const result = await applyTuningSuggestionAction(suggestion.id);
      setConfirming(null);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (result.value.warning) toast.warning(result.value.warning);
      else toast.success(`Rule ${suggestion.ruleId} suppressed for ${result.value.proxyHost.name}`);
      setSuggestions((current) => current.filter((item) => item.id !== suggestion.id));
      onApplied?.(suggestion.ruleId, suggestion.host);
    });
  }

  function dismiss(suggestion: WafTuningSuggestionView) {
    startTransition(async () => {
      const result = await dismissTuningSuggestionAction(suggestion.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Suggestion dismissed; it will not be proposed again");
      setSuggestions((current) => current.filter((item) => item.id !== suggestion.id));
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="m-0 text-base font-semibold">Tuning suggestions</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">Likely false positives in the last 14 days of WAF events. Nothing changes until you apply one.</p>
      </div>
      {!canWrite && (
        <Alert>
          <Lock className="h-4 w-4" />
          <AlertDescription>Finding, applying and dismissing suggestions needs the waf:write permission.</AlertDescription>
        </Alert>
      )}
      {!analyticsEnabled && (
        <Alert>
          <AlertDescription>Tuning suggestions need analytics, which are off.</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-4">
        <Button onClick={generate} disabled={!canWrite || !analyticsEnabled || pending} className="gap-1.5">
          <Wand2 className="h-4 w-4" /> Find suggestions
        </Button>
        <label className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <Checkbox checked={explain && aiConfigured} onCheckedChange={(checked) => setExplain(checked === true)} disabled={!canWrite || !aiConfigured} />
          Add AI risk assessments (up to 5)
          {!aiConfigured && <span className="text-xs text-muted-foreground">Needs an AI provider (AI settings).</span>}
        </label>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {suggestions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No open suggestions.</p>
      ) : (
        suggestions.map((suggestion) => {
          const evidence = suggestion.evidence;
          return (
            <Card key={suggestion.id}>
              <CardContent className="flex flex-col gap-3 pt-6">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold">Rule {suggestion.ruleId}</span>
                  <Badge variant={CONFIDENCE_VARIANT[suggestion.confidence]}>{suggestion.confidence} confidence</Badge>
                  {suggestion.ruleFamily && <Badge variant="outline">{suggestion.ruleFamily}</Badge>}
                  {suggestion.attackCritical && <Badge variant="destructive">Critical attack class</Badge>}
                  <span className="text-xs text-muted-foreground ml-auto">score {suggestion.score}/100</span>
                </div>
                {suggestion.ruleMessage && <p className="text-sm">{suggestion.ruleMessage}</p>}
                <p className="text-sm">
                  Host <span className="font-mono">{suggestion.host}</span> (proxy host &quot;{suggestion.proxyHost.name}&quot;)
                </p>
                <div className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/30 p-3 sm:grid-cols-4">
                  <Stat label="Matches" value={evidence.events.toLocaleString("en-US")} />
                  <Stat label="Clients" value={evidence.clients.toLocaleString("en-US")} />
                  <Stat label="Days" value={`${evidence.activeDays} of ${evidence.windowDays}`} />
                  <Stat label="Not blocked" value={percent(evidence.detectionOnlyEvents, evidence.events)} />
                  <Stat label="Clean clients" value={`${evidence.cleanClients} of ${evidence.clients}`} />
                  <Stat label="Normal clients" value={evidence.normalClients === null ? "n/a" : `${evidence.normalClients} of ${evidence.clients}`} />
                  <Stat label="Avg anomaly score" value={evidence.averageAnomalyScore === null ? "below threshold" : String(evidence.averageAnomalyScore)} />
                  <Stat label="Last seen (UTC)" value={formatDateTimeUtc(Date.parse(evidence.lastSeen))} />
                </div>
                {evidence.pathPrefixes.length > 0 && (
                  <div className="text-sm">
                    <p className="text-[0.62rem] font-bold uppercase tracking-wider text-muted-foreground mb-1">Paths</p>
                    <ul className="list-disc pl-5 space-y-0.5">
                      {evidence.pathPrefixes.map((prefix) => (
                        <li key={prefix.prefix}>
                          <span className="font-mono">{prefix.prefix}</span>: {prefix.events} matches, {prefix.clients} clients
                          {prefix.examplePaths.length > 0 && (
                            <span className="text-muted-foreground"> (e.g. <span className="font-mono break-all">{prefix.examplePaths.join(", ")}</span>)</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-0.5">
                  {suggestion.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
                <p className="text-sm">
                  <span className="font-medium">Proposed exclusion: </span>
                  {suggestion.exclusion.description}
                </p>
                {suggestion.explanation && (
                  <Alert>
                    <Sparkles className="h-4 w-4" />
                    <AlertDescription>
                      <span className="font-semibold">{suggestion.explanation.label}: </span>
                      {suggestion.explanation.text}
                    </AlertDescription>
                  </Alert>
                )}
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setConfirming(suggestion)} disabled={!canWrite || pending}>
                    Apply
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => dismiss(suggestion)} disabled={!canWrite || pending}>
                    Dismiss
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })
      )}
      <AppDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title="Apply tuning suggestion"
        submitLabel="Suppress rule"
        onSubmit={() => confirming && apply(confirming)}
        isSubmitting={pending}
      >
        {confirming && (
          <p className="text-sm">
            Rule {confirming.ruleId} will no longer be checked for any request to proxy host &quot;{confirming.proxyHost.name}&quot;
            ({confirming.host}). You can undo this in the host&apos;s WAF settings.
          </p>
        )}
      </AppDialog>
    </div>
  );
}
