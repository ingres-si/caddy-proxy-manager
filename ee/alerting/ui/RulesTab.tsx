// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BellOff, Plus, Trash2 } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { SearchField } from "@/components/ui/SearchField";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import { cn } from "@/lib/utils";
import { paginate } from "@/src/lib/pagination";
import type { AlertChannelView, AlertRuleView } from "@/ee/alerting/types";
import { deleteAlertRuleAction, setAlertRuleEnabledAction } from "./actions";
import { conditionLine, RULE_SEVERITY } from "./format";
import { Chip, SeverityPill } from "./parts";
import { useEndSilence, useSilenceHeadline } from "./silence";

type Props = {
  rules: AlertRuleView[];
  channels: AlertChannelView[];
  canWrite: boolean;
  onCreate: () => void;
  onEdit: (rule: AlertRuleView) => void;
  /** Opens the mute dialog. */
  onMute?: (rule: AlertRuleView) => void;
  /** When the page was rendered (ms), for "Muted until 18:00". */
  now?: number;
};

function earliest(values: (string | null)[]): string | null {
  const present = values.filter((value): value is string => Boolean(value)).sort();
  return present[0] ?? null;
}

export default function RulesTab({ rules, channels, canWrite, onCreate, onEdit, onMute, now = Date.now() }: Props) {
  const router = useRouter();
  const format = useFormat();
  const [pending, startTransition] = useTransition();
  const unmute = useEndSilence();
  const headline = useSilenceHeadline(now);
  const [confirmDelete, setConfirmDelete] = useState<AlertRuleView | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const needle = search.trim().toLowerCase();
  // Built-in rules first, then yours (each by name, as listed).
  const ordered = [...rules].sort((a, b) => Number(b.builtIn !== null) - Number(a.builtIn !== null));
  // Name, condition, scope and channel names.
  const matching = needle
    ? ordered.filter((rule) =>
        [rule.name, conditionLine(rule), rule.scopeLabel, ...rule.channelIds.map((id) => channelById.get(id)?.name ?? "")].some((text) =>
          text.toLowerCase().includes(needle)
        )
      )
    : ordered;
  const shown = paginate(matching, page);
  const enabledCount = rules.filter((rule) => rule.enabled).length;

  function setEnabled(rule: AlertRuleView, enabled: boolean) {
    startTransition(async () => {
      const result = await setAlertRuleEnabledAction(rule.id, enabled);
      if (!result.ok) toast.error(result.error);
      router.refresh();
    });
  }

  function remove() {
    if (!confirmDelete) return;
    const rule = confirmDelete;
    startTransition(async () => {
      const result = await deleteAlertRuleAction(rule.id);
      if (result.ok) toast.success("Rule deleted");
      else toast.error(result.error);
      setConfirmDelete(null);
      router.refresh();
    });
  }

  return (
    <>
      <SectionCard
        title="Rules"
        actions={
          rules.length > 0 && (
            <>
              <span className="text-[13px] text-muted-foreground">
                <span className="num">{enabledCount}</span> of <span className="num">{rules.length}</span> enabled
              </span>
              <SearchField
                type="search"
                aria-label="Search rules"
                placeholder="Search rules"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
                className="w-full sm:w-56"
              />
            </>
          )
        }
        footer={
          shown.pageCount > 1 ? (
            <Pagination page={shown.page} perPage={shown.perPage} total={shown.total} noun="rules" label="Pages of rules" onPageChange={setPage} />
          ) : undefined
        }
      >
        {rules.length === 0 ? (
          <EmptyState
            compact
            title="No rules yet"
            action={
              canWrite ? (
                <Button size="sm" onClick={onCreate}>
                  <Plus /> New rule
                </Button>
              ) : undefined
            }
          />
        ) : shown.items.length === 0 ? (
          <EmptyState compact icon={null} title="No rule matches" />
        ) : (
          <Table className="min-w-[1080px]">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Condition</TableHead>
                <TableHead scope="col">Scope</TableHead>
                <TableHead scope="col">For</TableHead>
                <TableHead scope="col">Severity</TableHead>
                <TableHead scope="col">Channels</TableHead>
                <TableHead scope="col">Last fired</TableHead>
                <TableHead scope="col" className="text-right">Enabled</TableHead>
                {canWrite && (
                  <TableHead scope="col" className="w-[170px]">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.items.map((rule) => {
                const severity = RULE_SEVERITY[rule.type];
                const firingSince = rule.enabled ? earliest(rule.firing.map((item) => item.firedAt)) : null;
                return (
                  <TableRow key={rule.id} className={cn("align-top", !rule.enabled && "opacity-60")}>
                    <TableCell className="py-3">
                      <div className="flex flex-col gap-0.5">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="font-semibold">{rule.name}</span>
                          {rule.builtIn && (
                            <span
                              className="rounded-full border border-line2 px-1.5 text-[11px] leading-4 text-muted-foreground"
                              title="Comes with Ingressi. Change or disable it; it cannot be deleted."
                            >
                              Built-in
                            </span>
                          )}
                        </span>
                        <span className="flex flex-wrap items-center gap-1.5 text-xs text-soft">
                          {conditionLine(rule)}
                          {rule.explain && (
                            <span className="rounded-full border border-line2 px-1.5 text-[11px] leading-4 text-muted-foreground">AI explanation</span>
                          )}
                        </span>
                        {rule.enabled && rule.pending.length > 0 && (
                          <span className="text-xs text-warn">
                            <span className="num">{rule.pending.length}</span> waiting out the <span className="num">{rule.forMinutes}</span> min duration
                          </span>
                        )}
                        {rule.mute && (
                          <span
                            className="flex items-center gap-1 text-xs font-semibold text-muted-foreground"
                            title={[rule.mute.createdByName, rule.mute.note].filter(Boolean).join(": ") || undefined}
                          >
                            <BellOff aria-hidden="true" className="h-3 w-3" />
                            {headline(rule.mute)}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="py-3">{rule.scopeLabel}</TableCell>
                    <TableCell className="py-3 whitespace-nowrap">
                      {rule.forMinutes > 0 ? <span className="num">{rule.forMinutes} min</span> : <span className="text-muted-foreground">At once</span>}
                    </TableCell>
                    <TableCell className="py-3">
                      <div className="flex flex-col items-start gap-0.5">
                        <SeverityPill severity={severity.severity} />
                        {severity.note && <span className="text-xs text-soft">{severity.note}</span>}
                      </div>
                    </TableCell>
                    <TableCell className="py-3">
                      {rule.channelIds.length === 0 ? (
                        <span className="text-muted-foreground" title="Its alerts are listed in Ingressi only">
                          Not sent
                        </span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {rule.channelIds.map((id) => {
                            const channel = channelById.get(id);
                            const failing = Boolean(channel?.enabled && channel.lastDeliveryError);
                            return (
                              <Chip key={id} tone={failing ? "bad" : undefined} title={failing ? `Last delivery failed: ${channel!.lastDeliveryError}` : undefined}>
                                {channel?.name ?? `#${id}`}
                              </Chip>
                            );
                          })}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="py-3 whitespace-nowrap">
                      {rule.enabled && rule.firing.length > 0 ? (
                        <StatusDot
                          tone="warn"
                          label={
                            <span className="font-semibold">
                              {`Open (${rule.firing.length})${firingSince ? ` since ${format.date(firingSince)}` : ""}`}
                            </span>
                          }
                        />
                      ) : rule.lastFiredAt ? (
                        <span className="num">{format.dateTime(rule.lastFiredAt)}</span>
                      ) : (
                        <span className="text-soft">Never</span>
                      )}
                    </TableCell>
                    <TableCell className="py-3 text-right">
                      {canWrite ? (
                        <Switch
                          checked={rule.enabled}
                          disabled={pending}
                          onCheckedChange={(checked) => setEnabled(rule, checked)}
                          aria-label={`Enabled: ${rule.name}`}
                        />
                      ) : (
                        <span className="text-muted-foreground">{rule.enabled ? "On" : "Off"}</span>
                      )}
                    </TableCell>
                    {canWrite && (
                      <TableCell className="py-2.5 text-right whitespace-nowrap">
                        {rule.mute ? (
                          <Button
                            variant="link"
                            size="sm"
                            className="px-2"
                            disabled={unmute.pending}
                            onClick={() => unmute.end(rule.mute!)}
                            aria-label={`Unmute rule ${rule.name}`}
                          >
                            Unmute
                          </Button>
                        ) : (
                          rule.enabled &&
                          onMute && (
                            <Button
                              variant="link"
                              size="sm"
                              className="px-2"
                              onClick={() => onMute(rule)}
                              aria-label={`Mute rule ${rule.name}`}
                            >
                              Mute…
                            </Button>
                          )
                        )}
                        <Button
                          variant="link"
                          size="sm"
                          className="px-2"
                          onClick={() => onEdit(rule)}
                          aria-label={`Edit rule ${rule.name}`}
                        >
                          Edit
                        </Button>
                        {rule.builtIn ? (
                          // Keeps the column aligned; built-in rules are disabled, not deleted.
                          <span aria-hidden="true" className="inline-block size-8 align-middle" />
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Delete"
                            aria-label={`Delete rule ${rule.name}`}
                            disabled={pending}
                            onClick={() => setConfirmDelete(rule)}
                          >
                            <Trash2 />
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <AppDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title={`Delete rule "${confirmDelete?.name ?? ""}"?`}
        submitLabel="Delete"
        onSubmit={remove}
        isSubmitting={pending}
      >
        <p className="text-sm text-muted-foreground">
          What it was firing is forgotten without resolve notices, so a PagerDuty incident it opened stays open. Its history is kept.
        </p>
      </AppDialog>
    </>
  );
}
