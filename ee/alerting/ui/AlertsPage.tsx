// SPDX-License-Identifier: Elastic-2.0
import { redirect } from "next/navigation";
import { requirePermission } from "@/src/lib/auth";
import { can, scopeTagsFor } from "@/src/lib/permissions";
import { listProxyHosts } from "@/src/lib/models/proxy-hosts";
import { listAlertChannels } from "@/ee/alerting/channels";
import { listAlertRules } from "@/ee/alerting/rules";
import { listAlertEvents, listFiringAlerts } from "@/ee/alerting/events";
import { ensureBuiltInAlertRulesOnce } from "@/ee/alerting/builtins";
import { getAiSettingsView } from "@/ee/ai/settings";
import { getDigestSettingsView } from "@/ee/ai/digest-settings";
import { DEFAULT_PAGE_SIZE, parsePageParam } from "@/src/lib/pagination";
import AlertsClient, { type AlertsTab } from "./AlertsClient";

export const metadata = { title: "Alerts" };

const HISTORY_PER_PAGE = DEFAULT_PAGE_SIZE;
/** The newest events read for the "Last 7 days" table. */
const RECENT_EVENTS = 200;
const TABS: readonly AlertsTab[] = ["firing", "history", "rules", "channels"];

interface PageProps {
  searchParams: Promise<{ tab?: string; page?: string | string[] }>;
}

/** A page of the history; the last one when the page asked for is past the end. */
async function historyPage(page: number) {
  const result = await listAlertEvents({ page, perPage: HISTORY_PER_PAGE });
  const last = Math.max(1, Math.ceil(result.total / HISTORY_PER_PAGE));
  return page > last ? listAlertEvents({ page: last, perPage: HISTORY_PER_PAGE }) : result;
}

export default async function AlertsPage({ searchParams }: PageProps) {
  const { access } = await requirePermission("alerts:read");
  const { tab: tabParam, page: pageParam } = await searchParams;
  // The AI tab moved to AI settings (/settings/ai).
  if (tabParam === "ai") redirect("/settings/ai");
  const canAi = can(access, "ai:read");
  const canWrite = can(access, "alerts:write");
  const tab = TABS.find((candidate) => candidate === tabParam) ?? "firing";
  const page = parsePageParam(pageParam);
  const now = Date.now();
  // A fresh install shows its built-in rules before the evaluator's first run.
  await ensureBuiltInAlertRulesOnce().catch(() => undefined);
  // Every view below is already free of credentials; proxy hosts are reduced to ids and names.
  const [channels, rules, firing, recent, history, hosts, ai, digest] = await Promise.all([
    listAlertChannels(),
    listAlertRules(),
    listFiringAlerts(),
    listAlertEvents({ page: 1, perPage: RECENT_EVENTS }),
    tab === "history" ? historyPage(page) : Promise.resolve({ events: [], total: 0, page: 1, perPage: HISTORY_PER_PAGE }),
    // Only the hosts the user may read are offered and named.
    can(access, "proxy_hosts:read")
      ? listProxyHosts(scopeTagsFor(access, "proxy_hosts"))
      : Promise.resolve([]),
    getAiSettingsView(),
    canAi ? getDigestSettingsView() : Promise.resolve(null),
  ]);
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  return (
    <AlertsClient
      initialTab={tab}
      channels={channels}
      rules={rules}
      firing={firing}
      recent={recent.events.filter((event) => event.createdAt >= weekAgo)}
      history={history}
      digest={digest}
      aiConfigured={ai.configured}
      canWrite={canWrite}
      proxyHosts={hosts.map((host) => ({ id: host.id, name: host.name || host.domains[0] || `Host #${host.id}` })).sort((a, b) => a.name.localeCompare(b.name))}
      now={now}
    />
  );
}
