// SPDX-License-Identifier: Elastic-2.0
"use client";

import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import type { AlertEventView } from "@/ee/alerting/types";
import { DeliveryChip, SeverityPill } from "./parts";
import { silencedText } from "./silence";

type Props = { history: { events: AlertEventView[]; total: number; page: number; perPage: number } };

function Status({ event }: { event: AlertEventView }) {
  if (event.status === "resolved") return <StatusDot tone="ok" label="Resolved" />;
  return <StatusDot tone={event.severity === "critical" ? "bad" : "warn"} label="Opened" />;
}

function Delivery({ event }: { event: AlertEventView }) {
  if (!event.notified) return <span className="text-xs text-muted-foreground">{silencedText(event.silenced) ?? "Not sent (cooldown or no channel)"}</span>;
  if (event.deliveries.length === 0) return <span className="text-xs text-muted-foreground">Sending…</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {event.deliveries.map((delivery) => (
        <DeliveryChip key={delivery.channelId} delivery={delivery} />
      ))}
    </span>
  );
}

function pageHref(page: number): string {
  return page <= 1 ? "/alerts?tab=history" : `/alerts?tab=history&page=${page}`;
}

/** Every firing and resolved transition of the last 90 days, newest first. */
export default function HistoryTab({ history }: Props) {
  const format = useFormat();
  return (
    <div className="flex flex-col gap-3">
      <SectionCard
        title="Event log, last 90 days"
        count={history.total}
        footer={
          history.total > history.perPage ? (
            <Pagination
              page={history.page}
              perPage={history.perPage}
              total={history.total}
              noun="alerts"
              label="Pages of alert history"
              hrefFor={pageHref}
            />
          ) : undefined
        }
      >
        {history.events.length === 0 ? (
          <EmptyState compact title="No alerts yet" />
        ) : (
          <Table className="min-w-[960px]">
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="w-[190px]">Time</TableHead>
                <TableHead scope="col" className="w-[110px]">Status</TableHead>
                <TableHead scope="col">Alert</TableHead>
                <TableHead scope="col" className="w-[240px]">Delivery</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.events.map((event) => (
                <TableRow key={event.id} className="align-top">
                  <TableCell className="num whitespace-nowrap text-muted-foreground">{format.dateTime(event.createdAt)}</TableCell>
                  <TableCell>
                    <Status event={event} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold [overflow-wrap:anywhere]">{event.title}</span>
                        {event.status === "firing" && <SeverityPill severity={event.severity} />}
                      </span>
                      <span className="text-xs text-soft">{event.ruleName}</span>
                      {event.message && <span className="whitespace-pre-line text-xs text-muted-foreground [overflow-wrap:anywhere]">{event.message}</span>}
                      {event.explanation && (
                        <div className="rounded-lg border border-line bg-panel2 p-2 text-xs">
                          <span className="font-semibold">AI-generated explanation: </span>
                          <span className="whitespace-pre-line">{event.explanation}</span>
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Delivery event={event} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}
