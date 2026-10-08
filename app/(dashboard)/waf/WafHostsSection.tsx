"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pagination } from "@/components/ui/Pagination";
import { SearchField } from "@/components/ui/SearchField";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { paginate } from "@/src/lib/pagination";
import type { WafSettings } from "@/src/lib/settings";
import type { WafHostMode } from "@/src/lib/waf-host-mode";
import { setWafHostModeAction } from "./actions";
import { Segmented } from "./Segmented";
import { EFFECTIVE_MODE_LABELS, EFFECTIVE_MODE_TONES, ToneDot, type WafHostRow } from "./waf-settings-shared";

type Filter = "all" | WafHostRow["effectiveMode"];

const SETTINGS_LABELS: Record<WafHostRow["settings"], string> = {
  follows: "Follows global",
  merges: "Merges with global",
  overrides: "Overrides global",
  off: "Turned off",
};

const GLOBAL_MODE_LABELS: Record<WafSettings["mode"], string> = { On: "Blocking", DetectionOnly: "Detection only", Off: "Off" };
const fmt = (value: number) => value.toLocaleString("en-US");

/** Hosts with WAF settings of their own, exclusions or events come first; the rest keep their order. */
function notableFirst(hosts: WafHostRow[]): WafHostRow[] {
  const notable = (host: WafHostRow) => host.configured || host.events.count > 0 || host.exclusions > 0;
  return [...hosts.filter(notable), ...hosts.filter((host) => !notable(host))];
}

function matchesSearch(host: WafHostRow, needle: string): boolean {
  if (!needle) return true;
  return host.name.toLowerCase().includes(needle) || host.domains.some((domain) => domain.toLowerCase().includes(needle));
}

/** The per-host table: each host's settings, mode and events, with the mode editable in place. */
export function WafHostsSection({
  hosts,
  globalMode,
  canWrite,
}: {
  hosts: WafHostRow[];
  globalMode: WafSettings["mode"];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pending, startTransition] = useTransition();

  const counts = {
    block: hosts.filter((host) => host.effectiveMode === "block").length,
    detection_only: hosts.filter((host) => host.effectiveMode === "detection_only").length,
    off: hosts.filter((host) => host.effectiveMode === "off").length,
  };
  const ordered = useMemo(() => notableFirst(hosts), [hosts]);
  const needle = search.trim().toLowerCase();
  const filtered = ordered.filter((host) => (filter === "all" || host.effectiveMode === filter) && matchesSearch(host, needle));
  const shown = paginate(filtered, page);

  function changeMode(host: WafHostRow, mode: WafHostMode) {
    startTransition(async () => {
      const result = await setWafHostModeAction(host.id, mode);
      if (result.ok) {
        toast.success(`WAF on ${host.name}: ${EFFECTIVE_MODE_LABELS[result.value.effectiveMode].toLowerCase()}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <section aria-labelledby="waf-hosts-title" className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3.5">
        <h2 id="waf-hosts-title" className="mr-auto text-base font-semibold">Per-host settings</h2>
        <SearchField
          type="search"
          aria-label="Search hosts"
          placeholder="Search hosts"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          className="w-full sm:w-56"
        />
        <Segmented
          label="Show hosts"
          value={filter}
          onChange={(value) => {
            setFilter(value as Filter);
            setPage(1);
          }}
          options={[
            { value: "all", label: "All", count: hosts.length },
            { value: "block", label: "Blocking", count: counts.block },
            { value: "detection_only", label: "Detection only", count: counts.detection_only },
            { value: "off", label: "Off", count: counts.off },
          ]}
        />
      </div>
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[940px] border-collapse text-sm">
          <thead>
            <tr className="border-y text-left text-xs text-muted-foreground">
              <th scope="col" className="px-4 py-2 font-medium">Host</th>
              <th scope="col" className="px-2.5 py-2 font-medium">Settings</th>
              <th scope="col" className="px-2.5 py-2 font-medium">Mode</th>
              <th scope="col" className="px-2.5 py-2 font-medium">Differences from global</th>
              <th scope="col" className="whitespace-nowrap px-2.5 py-2 text-right font-medium">Events, 7 days</th>
              <th scope="col" className="py-2 pl-2.5 pr-4"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {shown.items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                  {hosts.length === 0 ? "No proxy hosts yet." : "No host matches."}
                </td>
              </tr>
            )}
            {shown.items.map((host) => (
              <tr key={host.id} className="border-b last:border-b-0 hover:bg-muted/30">
                <td className="px-4 py-2.5">
                  <span className="font-semibold">{host.name}</span>
                  {host.domains.length > 0 && (
                    <span className="block text-xs text-muted-foreground">
                      {host.domains[0]}
                      {host.domains.length > 1 && ` + ${host.domains.length - 1} more`}
                    </span>
                  )}
                </td>
                <td className={host.settings === "follows" ? "px-2.5 py-2.5 text-muted-foreground" : "px-2.5 py-2.5"}>
                  {SETTINGS_LABELS[host.settings]}
                </td>
                <td className="whitespace-nowrap px-2.5 py-2.5">
                  {canWrite ? (
                    <Select value={host.mode} onValueChange={(value) => changeMode(host, value as WafHostMode)} disabled={pending}>
                      <SelectTrigger className="h-8 w-[220px]" aria-label={`WAF mode of ${host.name}`}>
                        <span className="flex items-center gap-2">
                          <ToneDot tone={EFFECTIVE_MODE_TONES[host.effectiveMode]} />
                          <SelectValue />
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="inherit">Global mode ({GLOBAL_MODE_LABELS[globalMode].toLowerCase()})</SelectItem>
                        <SelectItem value="block">Blocking</SelectItem>
                        <SelectItem value="detection_only">Detection only</SelectItem>
                        <SelectItem value="off">Off</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      <ToneDot tone={EFFECTIVE_MODE_TONES[host.effectiveMode]} />
                      {EFFECTIVE_MODE_LABELS[host.effectiveMode]}
                    </span>
                  )}
                </td>
                <td className={host.differences.length === 0 ? "px-2.5 py-2.5 text-muted-foreground" : "px-2.5 py-2.5"}>
                  {host.differences.length === 0
                    ? "None"
                    : host.differences.join(" · ").replace(/^./, (first) => first.toUpperCase())}
                </td>
                <td className="px-2.5 py-2.5 text-right">
                  {host.effectiveMode === "off" && host.events.count === 0 ? (
                    <span className="text-muted-foreground">Not inspected</span>
                  ) : (
                    <span className="inline-flex flex-col items-end">
                      <span className="font-mono">{fmt(host.events.count)}</span>
                      {host.events.count > 0 && host.events.blocked < host.events.count && (
                        <span className="text-xs text-muted-foreground">
                          {host.events.blocked === 0 ? "logged, not blocked" : `${fmt(host.events.blocked)} blocked`}
                        </span>
                      )}
                    </span>
                  )}
                </td>
                <td className="py-2.5 pl-2.5 pr-4 text-right">
                  <Link
                    href={`/proxy-hosts/${host.id}#waf`}
                    aria-label={`Edit WAF settings for ${host.name}`}
                    className="text-sm text-primary hover:underline"
                  >
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.pageCount > 1 && (
        <Pagination
          page={shown.page}
          perPage={shown.perPage}
          total={shown.total}
          noun="hosts"
          label="Pages of hosts"
          onPageChange={setPage}
          className="border-t px-4 py-3"
        />
      )}
    </section>
  );
}
