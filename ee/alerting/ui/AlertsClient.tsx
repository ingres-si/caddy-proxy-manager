// SPDX-License-Identifier: Elastic-2.0
"use client";

import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AlertChannelView, AlertEventView, AlertRuleView, FiringAlertView } from "@/ee/alerting/types";
import type { AiSettingsView } from "@/ee/ai/settings";
import type { DigestSettingsView } from "@/ee/ai/types";
import type { QuestionSettingsView } from "@/ee/ai/questions/types";
import FiringTab from "./FiringTab";
import RulesTab from "./RulesTab";
import ChannelsTab from "./ChannelsTab";
import HistoryTab from "./HistoryTab";
import AiTab from "@/ee/ai/ui/AiTab";
import RuleEditor, { type HostChoice } from "./RuleEditor";
import { SilenceDialog, type SilenceTarget } from "./silence";
import { buildEpisodes } from "./format";
import { TabCount } from "./parts";

/** history is the full list behind "Full history"; it has no tab of its own. */
export type AlertsTab = "firing" | "rules" | "channels" | "ai" | "history";

type HistoryPage = { events: AlertEventView[]; total: number; page: number; perPage: number };

type Props = {
  initialTab: AlertsTab;
  channels: AlertChannelView[];
  rules: AlertRuleView[];
  /** Subjects firing now. */
  firing?: FiringAlertView[];
  /** The newest events (firing and resolved), for the last 7 days. */
  recent?: AlertEventView[];
  /** A page of the full history (the history view). */
  history: HistoryPage;
  ai: AiSettingsView;
  digest?: DigestSettingsView;
  /** Settings of plain-language analytics questions (ee/ai/questions). */
  questions?: QuestionSettingsView;
  /** The user's role includes ai:read (custom roles); true when omitted. */
  canAi?: boolean;
  /** The user's role includes alerts:write; true when omitted. */
  canWrite?: boolean;
  /** Proxy hosts a rule can be limited to, and the names subjects refer to. */
  proxyHosts?: HostChoice[];
  /** When the page was rendered (ms), so durations match on the server and the client. */
  now?: number;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export default function AlertsClient({
  initialTab,
  channels,
  rules,
  firing = [],
  recent = [],
  history,
  ai,
  digest,
  questions,
  canAi = true,
  canWrite = true,
  proxyHosts = [],
  now: renderedAt,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [now] = useState(() => renderedAt ?? Date.now());
  const startTab = initialTab === "ai" && !canAi ? "firing" : initialTab;
  const [tab, setTab] = useState<AlertsTab>(startTab);
  // Links (Full history, back to firing alerts) change the tab through the URL.
  const [linkedTab, setLinkedTab] = useState<AlertsTab>(startTab);
  if (startTab !== linkedTab) {
    setLinkedTab(startTab);
    setTab(startTab);
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

  // Dismissed alerts and alerts of muted rules are listed, but do not need attention.
  const active = firing.filter((alert) => !alert.dismissal && !alert.mute).length;

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <Tabs value={tab === "history" ? "firing" : tab} onValueChange={changeTab} className="flex min-w-0 flex-col gap-5">
        <PageHeader
          className="mb-0"
          breadcrumb={["Observe", "Alerts"]}
          title="Alerts"
          actions={
            canWrite && (
              <Button onClick={() => openEditor(null)}>
                <Plus /> New rule
              </Button>
            )
          }
        >
          <TabsList aria-label="Alert sections">
            <TabsTrigger value="firing">
              Firing <TabCount value={firing.length} warn={active > 0} />
            </TabsTrigger>
            <TabsTrigger value="rules">
              Rules <TabCount value={rules.length} />
            </TabsTrigger>
            <TabsTrigger value="channels">
              Channels <TabCount value={channels.length} />
            </TabsTrigger>
            {canAi && <TabsTrigger value="ai">AI</TabsTrigger>}
          </TabsList>
        </PageHeader>

        <TabsContent value="firing" className="mt-0">
          {tab === "history" ? (
            <HistoryTab history={history} />
          ) : (
            <FiringTab
              firing={firing}
              episodes={episodes}
              rules={rules}
              hostNames={hostNames}
              now={now}
              onEditRule={(rule) => openEditor(rule)}
              canWrite={canWrite}
              onDismiss={(alert) => openSilence({ kind: "dismiss", alert })}
              onCreateRule={() => openEditor(null)}
            />
          )}
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
          <ChannelsTab channels={channels} rules={rules} canWrite={canWrite} />
        </TabsContent>
        {canAi && (
          <TabsContent value="ai" className="mt-0">
            <AiTab settings={ai} digest={digest} channels={channels} questions={questions} />
          </TabsContent>
        )}
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
          aiConfigured={ai.configured}
        />
      )}
    </div>
  );
}
