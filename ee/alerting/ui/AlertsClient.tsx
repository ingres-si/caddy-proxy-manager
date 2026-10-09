// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AlertChannelView, AlertEventView, AlertRuleView, FiringAlertView } from "@/ee/alerting/types";
import type { DigestSettingsView } from "@/ee/ai/types";
import FiringTab, { RecentAlerts } from "./FiringTab";
import RulesTab from "./RulesTab";
import ChannelsTab from "./ChannelsTab";
import HistoryTab from "./HistoryTab";
import RuleEditor, { type HostChoice } from "./RuleEditor";
import { SilenceDialog, type SilenceTarget } from "./silence";
import { silenceAlertAction } from "./actions";
import { buildEpisodes } from "./format";
import { TabCount } from "./parts";

/** "firing" is the Open tab (its URL value is kept for links that use it). */
export type AlertsTab = "firing" | "history" | "rules" | "channels";

type HistoryPage = { events: AlertEventView[]; total: number; page: number; perPage: number };

type Props = {
  initialTab: AlertsTab;
  channels: AlertChannelView[];
  rules: AlertRuleView[];
  /** Subjects firing now. */
  firing?: FiringAlertView[];
  /** The newest events (firing and resolved), for the last 7 days. */
  recent?: AlertEventView[];
  /** A page of the full history (the History tab). */
  history: HistoryPage;
  /** The daily security digest, for readers of the AI settings (ai:read); null otherwise. */
  digest?: DigestSettingsView | null;
  /** An AI provider is set up (rule explanations, the digest summary). */
  aiConfigured?: boolean;
  /** The user's role includes alerts:write; true when omitted. */
  canWrite?: boolean;
  /** Proxy hosts a rule can be limited to, and the names subjects refer to. */
  proxyHosts?: HostChoice[];
  /** When the page was rendered (ms), so durations match on the server and the client. */
  now?: number;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The Alerts page: what is open now, the history, the rules that watch the
 * install (built-in ones and your own) and the channels alerts go to, with
 * the daily digest.
 */
export default function AlertsClient({
  initialTab,
  channels,
  rules,
  firing = [],
  recent = [],
  history,
  digest = null,
  aiConfigured = false,
  canWrite = true,
  proxyHosts = [],
  now: renderedAt,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [now] = useState(() => renderedAt ?? Date.now());
  const [tab, setTab] = useState<AlertsTab>(initialTab);
  // Links (a page of the history, Add a channel) change the tab through the URL.
  const [linkedTab, setLinkedTab] = useState<AlertsTab>(initialTab);
  if (initialTab !== linkedTab) {
    setLinkedTab(initialTab);
    setTab(initialTab);
  }
  // A new key per opening, so the editor's form starts from the rule each time.
  const [editor, setEditor] = useState<{ key: number; open: boolean; rule: AlertRuleView | null }>({ key: 0, open: false, rule: null });
  const [silence, setSilence] = useState<{ key: number; open: boolean; target: SilenceTarget | null }>({ key: 0, open: false, target: null });

  const episodes = useMemo(() => buildEpisodes(recent, now - WEEK_MS), [recent, now]);
  const hostNames = useMemo(() => new Map(proxyHosts.map((host) => [host.id, host.name])), [proxyHosts]);

  function changeTab(value: string) {
    const next = value as AlertsTab;
    setTab(next);
    router.replace(next === "firing" ? pathname : `${pathname}?tab=${next}`, { scroll: false });
  }

  function openEditor(rule: AlertRuleView | null) {
    setEditor((current) => ({ key: current.key + 1, open: true, rule }));
  }

  function openSilence(target: SilenceTarget) {
    setSilence((current) => ({ key: current.key + 1, open: true, target }));
  }

  // Dismiss dismisses: until the alert resolves, for everyone, at once. The card then
  // shows who dismissed it, with Undo; a time limit or a muted rule is in the menu next to it.
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [, startDismiss] = useTransition();
  function dismissNow(alert: FiringAlertView) {
    const key = `${alert.ruleId}:${alert.subjectKey}`;
    setDismissing(key);
    startDismiss(async () => {
      const result = await silenceAlertAction({ ruleId: alert.ruleId, subjectKey: alert.subjectKey }).catch(() => ({
        ok: false as const,
        error: "The server did not answer: the alert was not dismissed.",
      }));
      if (result.ok) toast.success("Dismissed for everyone until it resolves");
      else toast.error(result.error);
      router.refresh();
      setDismissing(null);
    });
  }

  // Dismissed alerts and alerts of muted rules are listed, but do not need attention.
  const active = firing.filter((alert) => !alert.dismissal && !alert.mute).length;
  const enabledChannels = new Set(channels.filter((channel) => channel.enabled).map((channel) => channel.id));
  const notifying = rules.some((rule) => rule.enabled && rule.channelIds.some((id) => enabledChannels.has(id)));

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <Tabs value={tab} onValueChange={changeTab} className="flex min-w-0 flex-col gap-5">
        <PageHeader
          className="mb-0"
          breadcrumb={["Observe", "Alerts"]}
          title="Alerts"
          actions={
            canWrite &&
            tab === "rules" && (
              <Button onClick={() => openEditor(null)}>
                <Plus /> New rule
              </Button>
            )
          }
        >
          <TabsList aria-label="Alert sections">
            <TabsTrigger value="firing">
              Open <TabCount value={active} warn={active > 0} />
            </TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="rules">
              Rules <TabCount value={rules.length} />
            </TabsTrigger>
            <TabsTrigger value="channels">
              Channels <TabCount value={channels.length} />
            </TabsTrigger>
          </TabsList>
        </PageHeader>

        {!notifying && (tab === "firing" || tab === "rules") && (
          <Banner
            tone="info"
            title="Alerts are not sent anywhere"
            actions={
              canWrite ? (
                <Button asChild variant="outline" size="sm">
                  <Link href="/alerts?tab=channels">{channels.length === 0 ? "Add a channel" : "Open channels"}</Link>
                </Button>
              ) : undefined
            }
          >
            {channels.length === 0
              ? "They are listed here and under Needs attention on the overview. Add a channel, then choose it in the rules that should notify it."
              : "No enabled rule notifies an enabled channel. Edit a rule and choose where its alerts go."}
          </Banner>
        )}

        <TabsContent value="firing" className="mt-0">
          <FiringTab
            firing={firing}
            rules={rules}
            hostNames={hostNames}
            now={now}
            onEditRule={(rule) => openEditor(rule)}
            canWrite={canWrite}
            onDismiss={dismissNow}
            onDismissOptions={(alert, kind) =>
              openSilence(kind === "mute" ? { kind: "mute", rule: { id: alert.ruleId, name: alert.ruleName } } : { kind: "dismiss", alert })
            }
            dismissing={dismissing}
            onCreateRule={() => openEditor(null)}
          />
        </TabsContent>
        <TabsContent value="history" className="mt-0 flex flex-col gap-5">
          <RecentAlerts episodes={episodes} hostNames={hostNames} now={now} />
          <HistoryTab history={history} />
        </TabsContent>
        <TabsContent value="rules" className="mt-0">
          <RulesTab
            rules={rules}
            channels={channels}
            canWrite={canWrite}
            onCreate={() => openEditor(null)}
            onEdit={(rule) => openEditor(rule)}
            onMute={(rule) => openSilence({ kind: "mute", rule: { id: rule.id, name: rule.name } })}
            now={now}
          />
        </TabsContent>
        <TabsContent value="channels" className="mt-0">
          <ChannelsTab channels={channels} rules={rules} canWrite={canWrite} digest={digest} aiConfigured={aiConfigured} />
        </TabsContent>
      </Tabs>

      {canWrite && (
        <SilenceDialog
          key={`silence-${silence.key}`}
          open={silence.open}
          target={silence.target}
          onClose={() => setSilence((current) => ({ ...current, open: false }))}
        />
      )}
      {canWrite && (
        <RuleEditor
          key={editor.key}
          open={editor.open}
          rule={editor.rule}
          onClose={() => setEditor((current) => ({ ...current, open: false }))}
          channels={channels}
          proxyHosts={proxyHosts}
          aiConfigured={aiConfigured}
        />
      )}
    </div>
  );
}
