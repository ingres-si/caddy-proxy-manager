"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { formatCount } from "@/components/ui/chart-format";
import type { SecurityEvent } from "@/src/lib/analytics/security";
import type { WafEventExplanation } from "@/src/lib/waf-event-explain";
import { ruleIdError } from "@/src/lib/waf-exclusions";
import { explainWafEventAction } from "../waf/actions";
import type { WafExclusionDraft } from "../waf/WafExclusionDialog";
import { suggestionScope, WafExclusionBatchDialog } from "../waf/WafExclusionBatchDialog";
import { wafAuditRecordAction } from "./actions";
import { CdnWarning, type BlockTarget } from "./BlockSourceDialog";
import { analyticsHref, curlCommand, eventActionLabel, eventExplanation, splitMatchedData, visibleText, type CurlRequest, type SecurityQuery } from "./security-view";

export type EventDetailContext = {
  query: SecurityQuery;
  rangeLabel: string;
  canWriteWaf: boolean;
  canReadAnalytics: boolean;
  canReadSettings: boolean;
  blockDisabledReason: string | null;
  /** Addresses the Blocked sources list already blocks. */
  blockedIps: ReadonlySet<string>;
  /** Addresses that belong to a CDN (Cloudflare), with its name. */
  cdnIps?: Readonly<Record<string, string>>;
  /** WAF events of a rule over the range, for the rules on the top list. */
  ruleEvents: ReadonlyMap<number, number>;
  /** The proxy host serving each WAF event's host name, when one does. */
  eventHostIds: Readonly<Record<string, number>>;
  onBlock: (target: BlockTarget) => void;
  onAddExclusion: (draft: WafExclusionDraft) => void;
  /** Exclusions were added from an event: the page refreshes its figures. */
  onExcluded?: () => void;
};

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="m-0 text-[13px] font-semibold text-muted-foreground">{children}</h3>;
}

function Pre({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "num m-0 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-background px-3 py-2.5 text-xs leading-[18px]",
        className
      )}
    >
      {children}
    </pre>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Copy as curl, the raw audit record and the analytics link, under the choices. */
function ToolLinks({ curl, event, context }: { curl: CurlRequest; event: SecurityEvent; context: EventDetailContext }) {
  const [shownCurl, setShownCurl] = useState<string | null>(null);
  const [raw, setRaw] = useState<{ status: "idle" | "loading" } | { status: "ready"; text: string } | { status: "error"; error: string }>({ status: "idle" });

  async function copy() {
    const command = curlCommand(curl);
    if (await copyText(command)) toast.success("Copied as curl.");
    else setShownCurl(command);
  }

  async function toggleRaw() {
    if (raw.status === "ready" || raw.status === "error") {
      setRaw({ status: "idle" });
      return;
    }
    if (!event.eventId) return;
    setRaw({ status: "loading" });
    const result = await wafAuditRecordAction(event.eventId);
    setRaw(result.ok ? { status: "ready", text: result.value } : { status: "error", error: result.error });
  }

  const linkClass = "text-[13px] text-brand underline-offset-4 hover:text-foreground hover:underline";
  return (
    <>
      <div className="flex flex-wrap gap-x-3.5 gap-y-1 px-1">
        <button type="button" className={linkClass} onClick={copy}>
          Copy as curl
        </button>
        {event.kind === "waf" && event.eventId && (
          <button type="button" className={linkClass} aria-expanded={raw.status === "ready" || raw.status === "error"} onClick={toggleRaw}>
            {raw.status === "loading" ? "Reading the record…" : "Raw audit record"}
          </button>
        )}
        {context.canReadAnalytics && (
          <Link className={linkClass} href={analyticsHref(context.query, [{ dim: "ip", op: "is", value: event.ip }])}>
            Open in analytics
          </Link>
        )}
      </div>
      {shownCurl && (
        <div className="flex w-full flex-col gap-1">
          <span className="text-xs text-muted-foreground">The clipboard is not available here; copy the command yourself.</span>
          <Pre>{shownCurl}</Pre>
        </div>
      )}
      {raw.status === "error" && <p className="m-0 w-full text-xs text-muted-foreground">{raw.error}</p>}
      {raw.status === "ready" && <Pre className="max-h-80 w-full">{raw.text}</Pre>}
    </>
  );
}

/** The CDN an event's address belongs to; host names and addresses are request data, so only own entries count. */
function cdnOf(context: EventDetailContext, ip: string): string | null {
  return context.cdnIps && Object.hasOwn(context.cdnIps, ip) ? context.cdnIps[ip] : null;
}

function BlockButton({ event, context }: { event: SecurityEvent; context: EventDetailContext }) {
  const blocked = context.blockedIps.has(event.ip);
  const reason = blocked ? "Already on the Blocked sources list." : context.blockDisabledReason;
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={reason !== null}
      title={reason ?? 'Adds it to the "Blocked sources" access list on every host.'}
      onClick={() =>
        context.onBlock({
          ip: event.ip,
          country: event.country,
          cdn: cdnOf(context, event.ip),
          note:
            event.kind === "waf" && event.ruleId !== null
              ? `From Security events: WAF rule ${event.ruleId} on ${event.host}`
              : `From Security events: ${eventActionLabel(event).toLowerCase()} on ${event.host}`,
        })
      }
    >
      {blocked ? `${event.ip} is blocked` : `Block ${event.ip}`}
    </Button>
  );
}

/** Ends a message with a full stop unless it already ends a sentence. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export type LoadState = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; explanation: WafEventExplanation };

/** One rule that matched: its points, what it checks, and what it found where. */
function MatchedRule({ rule }: { rule: WafEventExplanation["rules"][number] }) {
  const [open, setOpen] = useState(false);
  const split = rule.matchedData ? splitMatchedData(rule.matchedData) : null;
  const variable = split?.variable ?? rule.matchedVariable;
  const found = split ? visibleText(split.data) : null;
  const value = split?.value ? visibleText(split.value) : null;
  const points = rule.anomalyPoints !== null ? (rule.countedInScore ? `+${rule.anomalyPoints}` : "0") : rule.disruptive ? "deny" : "·";
  return (
    <li className="grid grid-cols-[44px_minmax(0,1fr)] gap-x-2.5 border-b border-line py-2.5 last:border-b-0">
      <span className={cn("num pt-px text-[13px]", rule.countedInScore && rule.anomalyPoints ? "text-waf-ink" : "text-muted-foreground")}>{points}</span>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[13px]">
          <span className="num text-muted-foreground">{rule.ruleId}</span> {rule.message ?? "No message"}
          {!rule.countedInScore && rule.anomalyPoints !== null && (
            <span className="text-muted-foreground"> (paranoia level {rule.paranoiaLevel}: logged only)</span>
          )}
        </span>
        {(found !== null || variable) && (
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
            {found !== null && found !== "" && (
              <>
                Matched <code className="num max-w-full truncate rounded bg-raise px-1 py-px text-foreground" title={found}>{found}</code>
              </>
            )}
            {variable && (
              <>
                in <span className="num">{variable}</span>
              </>
            )}
            {value && value !== found && (
              <button type="button" className="text-brand underline-offset-4 hover:underline" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
                {open ? "Hide the value" : "Show the value"}
              </button>
            )}
          </span>
        )}
        {open && value && <Pre className="max-h-40">{value}</Pre>}
      </div>
    </li>
  );
}

/**
 * A WAF event, expanded: the verdict in one line, every rule that matched
 * with what it found where, and what to do: exclude the rules that added to
 * the score (reviewed together, one apply), block the source, or look closer.
 */
function WafEventDetail({ event, context }: { event: SecurityEvent; context: EventDetailContext; onClose: () => void }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!event.eventId) {
      setState({ status: "error", error: "This event has no transaction id, so its audit record cannot be read." });
      return;
    }
    let cancelled = false;
    if (reload === 0) setState({ status: "loading" });
    explainWafEventAction(event.eventId).then(
      (result) => {
        if (cancelled) return;
        setState(result.ok ? { status: "ready", explanation: result.value } : { status: "error", error: result.error });
      },
      () => {
        if (!cancelled) setState({ status: "error", error: "Could not read this event's audit record." });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [event.eventId, reload]);

  return <WafEventView event={event} context={context} state={state} onExcluded={() => setReload((n) => n + 1)} />;
}

/** The WAF event detail for a loaded (or failed) explanation; split from the loading so it renders in tests. */
export function WafEventView({ event, context, state, onExcluded }: { event: SecurityEvent; context: EventDetailContext; state: LoadState; onExcluded: () => void }) {
  const [batchOpen, setBatchOpen] = useState(false);
  const explanation = state.status === "ready" ? state.explanation : null;
  const blocked = explanation ? explanation.blocked : event.blocked;
  const matched = explanation ? explanation.rules.filter((rule) => rule.kind === "attack" || rule.kind === "custom") : [];
  const showScore = explanation ? explanation.rules.some((rule) => rule.kind === "inbound_evaluation") || explanation.inboundScore > 0 : false;
  const ruleMessages = useMemo(
    () => new Map((explanation?.rules ?? []).filter((rule) => rule.message).map((rule) => [rule.ruleId, rule.message as string])),
    [explanation]
  );

  // The narrowest exclusions the explain API suggests. When the record cannot be read: the event's rule on its host and path.
  const fallback: WafExclusionDraft | null =
    state.status === "error" && event.ruleId !== null && ruleIdError(event.ruleId) === null
      ? {
          ruleId: String(event.ruleId),
          // Host names are request data: only an own entry of the map counts (never "constructor" and the like).
          scope: Object.hasOwn(context.eventHostIds, event.host) ? String(context.eventHostIds[event.host]) : "global",
          path: event.path,
          pathMatch: "exact",
          variable: "",
          reason: event.eventId ? `Suggested from WAF event ${event.eventId}` : "Suggested from a WAF event",
        }
      : null;
  const suggestions = explanation?.suggestions ?? [];
  const open = useMemo(() => suggestions.filter((suggestion) => suggestion.existingExclusionId === null), [suggestions]);
  const allExcluded = suggestions.length > 0 && open.length === 0;

  // Why excluding is not offered, when it is not.
  let excludeNote: string | null = null;
  if (!context.canWriteWaf) excludeNote = "Adding exclusions needs the waf:write permission.";
  else if (allExcluded) excludeNote = suggestions.length === 1 ? "The suggested exclusion exists already." : "The suggested exclusions exist already.";
  else if (explanation && open.length === 0)
    excludeNote =
      explanation.decidingRule?.kind === "custom"
        ? "A custom rule decided this: change that rule in the WAF settings."
        : "No Core Rule Set rule added to the score, so there is no rule to exclude.";
  else if (state.status === "error" && !fallback) excludeNote = "The record names no rule to exclude.";
  const canExclude = context.canWriteWaf && state.status !== "loading" && (open.length > 0 || fallback !== null);
  const excludeLabel = open.length > 1 ? `Exclude ${open.length} rules…` : `Exclude rule ${open[0]?.ruleId ?? fallback?.ruleId ?? event.ruleId ?? ""}…`;

  function exclude() {
    if (open.length > 0) setBatchOpen(true);
    else if (fallback) context.onAddExclusion(fallback);
  }

  const request = explanation?.request;
  const requestLine = `${request?.method ?? event.method} ${request?.host ?? event.host}${request?.uri ?? event.path}`;
  const ruleEvents = event.ruleId !== null ? context.ruleEvents.get(event.ruleId) : undefined;
  const reachNote = blocked
    ? `The request never reached the upstream${ruleEvents && ruleEvents > 1 ? `; rule ${event.ruleId} matched ${formatCount(ruleEvents)} times in the ${context.rangeLabel}` : ""}.`
    : "Logged only: the request reached the upstream.";

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-line2 bg-panel p-4">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
        {explanation && showScore && (
          <div className="flex items-baseline gap-2">
            <span className="num text-[26px] leading-8 text-waf-ink">{explanation.inboundScore}</span>
            <span className="text-[13px] text-muted-foreground">
              points, {blocked ? "blocked at" : "the limit is"} <span className="num">{explanation.inboundThreshold}</span>
              {explanation.thresholdSource === "settings" ? " (current settings)" : ""}
            </span>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="num min-w-0 text-[13px] [overflow-wrap:anywhere]">
            {requestLine}
            {request?.httpVersion && <span className="text-muted-foreground"> {request.httpVersion}</span>}
          </span>
          <span className="text-xs text-muted-foreground">
            {explanation && !showScore ? `${explanation.summary} ` : ""}
            {reachNote}
          </span>
        </div>
      </div>

      {state.status === "loading" && (
        <p role="status" className="m-0 text-[13px] text-muted-foreground">
          Reading the audit record…
        </p>
      )}
      {state.status === "error" && (
        <p role="status" className="m-0 text-[13px] text-muted-foreground">
          {sentence(state.error)}{" "}
          {event.ruleId !== null && (
            <>
              The event names rule <span className="num">{event.ruleId}</span>
              {event.message ? `: ${sentence(event.message)}` : "."}
            </>
          )}
        </p>
      )}
      {explanation && (matched.length > 0 || explanation.decidingRule) && (
        <section aria-label={blocked ? "Why it was blocked" : "Why it was logged"} className="flex flex-col">
          <Heading>{matched.length === 1 ? "The rule that matched" : `The ${matched.length} rules that matched`}</Heading>
          <ol className="m-0 mt-1 flex list-none flex-col p-0">
            {matched.map((rule, index) => (
              <MatchedRule key={`${rule.ruleId}-${index}`} rule={rule} />
            ))}
            {explanation.decidingRule && explanation.decidingRule.kind !== "attack" && explanation.decidingRule.kind !== "custom" && (
              <li className="grid grid-cols-[44px_minmax(0,1fr)] gap-x-2.5 py-2.5 text-[13px]">
                <span className="num text-muted-foreground">=</span>
                <span className="min-w-0">
                  <span className="num text-muted-foreground">{explanation.decidingRule.ruleId}</span>{" "}
                  {explanation.decidingRule.blocked ? `Anomaly score reached: blocked with 403` : explanation.decidingRule.message ?? "Logged only"}
                </span>
              </li>
            )}
          </ol>
        </section>
      )}

      <div className="flex flex-col gap-2 border-t border-line pt-3.5">
        {cdnOf(context, event.ip) && <CdnWarning ip={event.ip} cdn={cdnOf(context, event.ip)!} />}
        <div className="flex flex-wrap items-center gap-2">
          {(canExclude || excludeNote === null) && (
            <Button size="sm" onClick={exclude} disabled={!canExclude}>
              {excludeLabel}
            </Button>
          )}
          <BlockButton event={event} context={context} />
          <ToolLinks
            event={event}
            context={context}
            curl={{
              method: request?.method ?? event.method,
              host: event.host,
              uri: request?.uri ?? event.path,
              headers: request?.headers ?? null,
            }}
          />
        </div>
        <p className="m-0 text-xs text-muted-foreground">
          {excludeNote ??
            (open.length > 0
              ? `A false positive? Excluding skips ${open.length === 1 ? "the rule" : "these rules"} only ${suggestionScope(open[0])}${open.some((s) => s.variable) ? ", in the variable matched" : ""}; you review ${open.length === 1 ? "it" : "them"} first.`
              : "")}
        </p>
      </div>

      {explanation && open.length > 0 && (
        <WafExclusionBatchDialog
          open={batchOpen}
          onOpenChange={setBatchOpen}
          suggestions={open}
          ruleMessages={ruleMessages}
          defaultReason={`False positive on ${event.host}${open[0].path ?? ""} (WAF event ${event.eventId ?? "?"})`}
          onCreated={() => {
            onExcluded();
            context.onExcluded?.();
          }}
        />
      )}
    </div>
  );
}

const SETTINGS_LINKS: Partial<Record<SecurityEvent["kind"], { label: string; href: string; needs: "settings" | "none" }>> = {
  geo: { label: "Geo blocking", href: "/geo-blocking", needs: "settings" },
  access: { label: "Access lists", href: "/access-lists", needs: "none" },
  rate_limit: { label: "Rate limiting", href: "/rate-limiting", needs: "settings" },
};

/** A request stopped by a geo, access, sign-in or rate limit rule: the rule from its outcome. */
function RuleEventDetail({ event, context }: { event: SecurityEvent; context: EventDetailContext }) {
  const link = SETTINGS_LINKS[event.kind];
  const lines = [
    `${event.method} ${event.path}`,
    `Host: ${event.host}`,
    `From: ${event.ip}${event.country ? ` (${event.country})` : ""}`,
    ...(event.status > 0 ? [`Answered: ${event.status}`] : []),
  ].join("\n");
  return (
    <div className="grid gap-4 rounded-xl border border-line2 bg-panel p-4 [grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr))]">
      <div className="flex min-w-0 flex-col gap-2.5">
        <Heading>Why it was stopped</Heading>
        <p className="m-0 text-[13px] font-semibold">{eventActionLabel(event)}</p>
        <p className="m-0 text-[13px] text-muted-foreground">{eventExplanation(event)}</p>
        {link && (link.needs === "none" || context.canReadSettings) && (
          <Link href={link.href} className="text-[13px] text-brand underline-offset-4 hover:text-foreground hover:underline">
            {link.label}
          </Link>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2.5">
        <Heading>Request</Heading>
        <Pre>{lines}</Pre>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <Heading>What you can do</Heading>
        {cdnOf(context, event.ip) && <CdnWarning ip={event.ip} cdn={cdnOf(context, event.ip)!} />}
        <div className="flex flex-wrap items-center gap-2">
          <BlockButton event={event} context={context} />
          <ToolLinks event={event} context={context} curl={{ method: event.method, host: event.host, uri: event.path }} />
        </div>
      </div>
    </div>
  );
}

/** The expanded row of an event: why it was stopped and what to do about it. */
export function EventDetail({ event, context, onClose }: { event: SecurityEvent; context: EventDetailContext; onClose: () => void }) {
  if (event.kind === "waf") return <WafEventDetail event={event} context={context} onClose={onClose} />;
  return <RuleEventDetail event={event} context={context} />;
}
