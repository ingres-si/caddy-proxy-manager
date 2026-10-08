// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import { BellOff, BellRing, ChevronRight, Info, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import { cn } from "@/lib/utils";
import { paginate } from "@/src/lib/pagination";
import type { AlertEventView, AlertRuleView, FiringAlertView, Severity } from "@/ee/alerting/types";
import { auditLogAround, formatDuration, subjectLink, type AlertEpisode } from "./format";
import { DeliveryChip, SeverityPill } from "./parts";
import { SilenceMarker, silencedText, useEndSilence } from "./silence";

const SEVERITY_TILE: Record<Severity, { icon: LucideIcon; className: string }> = {
  critical: { icon: OctagonAlert, className: "bg-bad-tint text-bad" },
  warning: { icon: TriangleAlert, className: "bg-warn-tint text-warn" },
  info: { icon: Info, className: "bg-raise text-muted-foreground" },
};

type Props = {
  firing: FiringAlertView[];
  episodes: AlertEpisode[];
  rules: AlertRuleView[];
  hostNames: ReadonlyMap<number, string>;
  /** Server time the page was rendered at, for durations that render the same on the server and the client. */
  now: number;
  onEditRule: (rule: AlertRuleView) => void;
  /** alerts:write: edit rules, dismiss alerts, undo dismissals and mutes. */
  canWrite?: boolean;
  /** Opens the dismiss dialog (offered with canWrite). */
  onDismiss?: (alert: FiringAlertView) => void;
  /** Opens the editor for a new rule (offered with canWrite when there are no rules). */
  onCreateRule?: () => void;
};

function Deliveries({ deliveries, notified, silenced = null }: { deliveries: AlertEventView["deliveries"]; notified: boolean; silenced?: AlertEventView["silenced"] }) {
  if (!notified) return <span className="text-xs text-muted-foreground">{silencedText(silenced) ?? "Not sent (cooldown or no channel)"}</span>;
  if (deliveries.length === 0) return <span className="text-xs text-muted-foreground">Sending…</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {deliveries.map((delivery) => (
        <DeliveryChip key={delivery.channelId} delivery={delivery} />
      ))}
    </span>
  );
}

function clearsText(alert: FiringAlertView): string {
  if (alert.deliveries.length === 0) return "Nothing was sent when it fired, so no resolve notice follows";
  if (alert.notifyOnResolve) {
    return alert.deliveries.length === 1 ? "A resolve notice goes to the same channel" : `A resolve notice goes to the same ${alert.deliveries.length} channels`;
  }
  return "No resolve notice; a PagerDuty incident is still closed";
}

function FiringCard({ alert, rule, hostNames, now, canEdit, canWrite, onEditRule, onDismiss }: {
  alert: FiringAlertView;
  rule: AlertRuleView | undefined;
  hostNames: ReadonlyMap<number, string>;
  now: number;
  canEdit: boolean;
  canWrite: boolean;
  onEditRule: (rule: AlertRuleView) => void;
  onDismiss?: (alert: FiringAlertView) => void;
}) {
  const format = useFormat();
  const undo = useEndSilence();
  const quiet = Boolean(alert.dismissal || alert.mute);
  const tile = quiet ? { icon: BellOff, className: "bg-raise text-muted-foreground" } : SEVERITY_TILE[alert.severity];
  const Icon = tile.icon;
  const link = subjectLink(alert.subjectKey, hostNames);
  return (
    <article className="flex flex-col gap-4 rounded-2xl border border-line bg-panel px-5 pt-4 pb-[18px]" data-silenced={quiet ? "true" : undefined}>
      {quiet && (
        <div className="flex flex-col gap-1.5 rounded-xl bg-panel2 px-3 py-2">
          {alert.dismissal && (
            <SilenceMarker
              silence={alert.dismissal}
              now={now}
              undo={canWrite ? { label: "Undo", onClick: () => undo.end(alert.dismissal!), disabled: undo.pending } : undefined}
              undoLabel={`Undo the dismissal of ${alert.title}`}
            />
          )}
          {alert.mute && (
            <SilenceMarker
              silence={alert.mute}
              now={now}
              muteLabel="Rule muted"
              undo={canWrite ? { label: "Unmute", onClick: () => undo.end(alert.mute!), disabled: undo.pending } : undefined}
              undoLabel={`Unmute rule ${alert.ruleName}`}
            />
          )}
        </div>
      )}
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <span aria-hidden="true" className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-[10px]", tile.className)}>
          <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
        </span>
        <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <h3 className="m-0 text-[15px] leading-[22px] font-semibold [overflow-wrap:anywhere]">{alert.title}</h3>
            <SeverityPill severity={alert.severity} dot />
          </div>
          {alert.message && <p className="m-0 whitespace-pre-line text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{alert.message}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {link && (
            <Button asChild variant="secondary" size="sm">
              <Link href={link.href}>{link.action}</Link>
            </Button>
          )}
          {canEdit && rule && (
            <Button variant="secondary" size="sm" onClick={() => onEditRule(rule)}>
              Edit rule
            </Button>
          )}
          {canEdit && onDismiss && !alert.dismissal && (
            <Button variant="secondary" size="sm" onClick={() => onDismiss(alert)} aria-label={`Dismiss ${alert.title}`}>
              Dismiss
            </Button>
          )}
        </div>
      </div>
      <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-x-5 gap-y-3 text-[13px]">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-soft">Rule</dt>
          <dd className="m-0">{alert.ruleName}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-soft">Firing since</dt>
          <dd className="num m-0">
            {alert.firedAt ? `${format.dateTime(alert.firedAt)} · ${formatDuration(now - Date.parse(alert.firedAt))}` : "Unknown"}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-soft">Notified</dt>
          <dd className="m-0">
            {alert.deliveries.length === 0 ? (
              <span className="text-muted-foreground">
                {alert.silenced === "muted" ? "Nobody (rule muted)" : alert.silenced === "dismissed" ? "Nobody (dismissed)" : "Nobody (cooldown or no channel)"}
              </span>
            ) : (
              <Deliveries deliveries={alert.deliveries} notified />
            )}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-soft">When it clears</dt>
          <dd className="m-0">{clearsText(alert)}</dd>
        </div>
      </dl>
    </article>
  );
}

function deliveryLines(episode: AlertEpisode): { at: string | null; text: string }[] {
  const lines: { at: string | null; text: string }[] = [];
  if (!episode.notified) {
    const reason = episode.silenced === "muted" ? "rule muted" : episode.silenced === "dismissed" ? "dismissed" : "cooldown or no channel";
    lines.push({ at: episode.firedAt, text: `Firing: not sent (${reason})` });
  }
  for (const delivery of episode.deliveries) {
    lines.push({
      at: episode.firedAt,
      text: delivery.ok ? `${delivery.channelName}: firing, delivered` : `${delivery.channelName}: firing, not delivered (${delivery.error ?? "error"})`,
    });
  }
  if (episode.resolve) {
    if (!episode.resolve.notified || episode.resolve.deliveries.length === 0) {
      lines.push({ at: episode.resolve.at, text: "Resolved: no notice sent" });
    }
    for (const delivery of episode.resolve.deliveries) {
      lines.push({
        at: episode.resolve.at,
        text: delivery.ok ? `${delivery.channelName}: resolved, delivered` : `${delivery.channelName}: resolved, not delivered (${delivery.error ?? "error"})`,
      });
    }
  }
  return lines;
}

function EpisodeDetail({ episode, hostNames }: { episode: AlertEpisode; hostNames: ReadonlyMap<number, string> }) {
  const format = useFormat();
  const link = subjectLink(episode.subjectKey, hostNames);
  const lines = deliveryLines(episode);
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-4 rounded-xl border border-line2 bg-panel p-4">
      <div className="flex min-w-0 flex-col gap-2">
        <h4 className="m-0 text-[13px] font-semibold text-muted-foreground">What happened</h4>
        <p className="m-0 whitespace-pre-line text-[13px] [overflow-wrap:anywhere]">{episode.message || episode.title}</p>
        {episode.explanation && (
          <div className="rounded-lg border border-line bg-panel2 p-2.5 text-[13px]">
            <span className="font-semibold">AI-generated explanation: </span>
            <span className="whitespace-pre-line text-muted-foreground">{episode.explanation}</span>
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <h4 className="m-0 text-[13px] font-semibold text-muted-foreground">Who was told</h4>
        <ol className="m-0 flex list-none flex-col gap-2 p-0 text-[13px]">
          {lines.map((line, index) => (
            <li key={index} className="flex gap-2.5">
              <span className="num w-[72px] shrink-0 text-soft">{line.at ? format.time(line.at) : ""}</span>
              <span className="min-w-0 [overflow-wrap:anywhere]">{line.text}</span>
            </li>
          ))}
        </ol>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <h4 className="m-0 text-[13px] font-semibold text-muted-foreground">Look closer</h4>
        {link && (
          <Link
            href={link.href}
            className="flex flex-col gap-0.5 rounded-[10px] border border-line2 bg-panel2 px-3 py-2.5 text-foreground no-underline transition-colors hover:bg-raise"
          >
            <span className="font-semibold [overflow-wrap:anywhere]">{link.label}</span>
            <span className="text-xs text-muted-foreground">{link.description}</span>
          </Link>
        )}
        <Link
          href={auditLogAround(episode.firedAt, episode.resolvedAt ?? episode.firedAt)}
          className="flex flex-col gap-0.5 rounded-[10px] border border-line2 bg-panel2 px-3 py-2.5 text-foreground no-underline transition-colors hover:bg-raise"
        >
          <span className="font-semibold">Audit log around {format.time(episode.firedAt)}</span>
          <span className="text-xs text-muted-foreground">Changes and sign-ins in the half hour before and after</span>
        </Link>
      </div>
    </div>
  );
}

export default function FiringTab({ firing, episodes, rules, hostNames, now, onEditRule, canWrite = false, onDismiss, onCreateRule }: Props) {
  const format = useFormat();
  const [open, setOpen] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const shown = paginate(episodes, page);
  const ruleById = useMemo(() => new Map(rules.map((rule) => [rule.id, rule])), [rules]);
  const pending = rules.filter((rule) => rule.enabled).flatMap((rule) => rule.pending.map((item) => ({ rule, item })));

  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="firing-now-title" className="flex flex-col gap-2.5">
        <h2 id="firing-now-title" className="m-0 text-base leading-6 font-semibold">
          Firing now
        </h2>
        {firing.length === 0 ? (
          <div className="rounded-2xl border border-line bg-panel">
            {rules.length === 0 ? (
              <EmptyState
                compact
                icon={BellRing}
                title="No alert rules, so nothing can fire"
                description="Needs attention on the overview is worked out from traffic and does not alert. Add a rule, such as Error rate or WAF block spike, to be notified."
                action={
                  canWrite && onCreateRule ? (
                    <Button type="button" size="sm" onClick={onCreateRule}>
                      New rule
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <EmptyState compact icon={BellRing} title="Nothing is firing" />
            )}
          </div>
        ) : (
          firing.map((alert) => (
            <FiringCard
              key={`${alert.ruleId}:${alert.subjectKey}`}
              alert={alert}
              rule={ruleById.get(alert.ruleId)}
              hostNames={hostNames}
              now={now}
              canEdit={canWrite && ruleById.has(alert.ruleId)}
              canWrite={canWrite}
              onEditRule={onEditRule}
              onDismiss={onDismiss}
            />
          ))
        )}
        {pending.length > 0 && (
          <p className="m-0 text-[13px] text-muted-foreground">
            Waiting out a &quot;for&quot; duration:{" "}
            {pending.slice(0, 5).map(({ rule, item }, index) => (
              <Fragment key={`${rule.id}:${item.subjectKey}`}>
                {index > 0 && "; "}
                <span className="text-foreground">{item.title ?? item.subjectKey}</span> ({rule.name}
                {item.since ? `, since ${format.time(item.since)}` : ""})
              </Fragment>
            ))}
            {pending.length > 5 ? ` and ${pending.length - 5} more` : ""}.
          </p>
        )}
      </section>

      <SectionCard
        title="Last 7 days"
        count={episodes.length > 0 ? episodes.length : null}
        link={{ label: "Full history", href: "/alerts?tab=history" }}
        footer={
          shown.pageCount > 1 ? (
            <Pagination
              page={shown.page}
              perPage={shown.perPage}
              total={shown.total}
              noun="alerts"
              label="Pages of the last 7 days"
              onPageChange={setPage}
            />
          ) : undefined
        }
      >
        {episodes.length === 0 ? (
          <EmptyState compact title="No alerts in the last 7 days" />
        ) : (
          <Table className="min-w-[980px]">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Alert</TableHead>
                <TableHead scope="col">Severity</TableHead>
                <TableHead scope="col">Fired</TableHead>
                <TableHead scope="col">Resolved</TableHead>
                <TableHead scope="col" className="text-right">Lasted</TableHead>
                <TableHead scope="col">Notified</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.items.map((episode) => {
                const expanded = open === episode.id;
                const detailId = `alert-episode-${episode.id}`;
                return (
                  <Fragment key={episode.id}>
                    <TableRow className={cn(expanded && "bg-panel2")}>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => setOpen(expanded ? null : episode.id)}
                          aria-expanded={expanded}
                          aria-controls={detailId}
                          className="flex items-center gap-2 border-0 bg-transparent p-0 text-left"
                        >
                          <ChevronRight
                            aria-hidden="true"
                            className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
                            strokeWidth={2.4}
                          />
                          <span className="font-semibold [overflow-wrap:anywhere]">{episode.title}</span>
                        </button>
                      </TableCell>
                      <TableCell>
                        <SeverityPill severity={episode.severity} dot />
                      </TableCell>
                      <TableCell className="num whitespace-nowrap">{format.dateTime(episode.firedAt)}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {episode.resolvedAt ? (
                          <StatusDot tone="ok" label={<span className="num">{format.time(episode.resolvedAt)}</span>} />
                        ) : (
                          <StatusDot tone="warn" label={<span className="font-semibold">Firing</span>} />
                        )}
                      </TableCell>
                      <TableCell className="num text-right whitespace-nowrap">
                        {formatDuration((episode.resolvedAt ? Date.parse(episode.resolvedAt) : now) - Date.parse(episode.firedAt))}
                      </TableCell>
                      <TableCell>
                        <Deliveries deliveries={episode.deliveries} notified={episode.notified} silenced={episode.silenced} />
                      </TableCell>
                    </TableRow>
                    {expanded && (
                      <TableRow id={detailId} className="bg-panel2 hover:bg-panel2">
                        <TableCell colSpan={6} className="px-[18px] pt-1 pb-[18px]">
                          <EpisodeDetail episode={episode} hostNames={hostNames} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}
