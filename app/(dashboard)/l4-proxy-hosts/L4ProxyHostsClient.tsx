"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { ArrowDown, ArrowUp, ArrowUpDown, MoreHorizontal, Network, Plus } from "lucide-react";
import { toast } from "sonner";
import type { L4ProxyHost } from "@/src/lib/models/l4-proxy-hosts";
import type { HostApprovalContext } from "@/ee/approvals/types";
import { toggleL4ProxyHostAction } from "./actions";
import { bulkL4ProxyHostsAction, type L4BulkOperation } from "./bulk-actions";
import { PageHeader } from "@/components/ui/PageHeader";
import { ListSearchField } from "@/components/ui/ListSearchField";
import { EmptyState } from "@/components/ui/EmptyState";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { StatusDot, type StatusTone } from "@/components/ui/StatusDot";
import { Pagination, useUrlPage } from "@/components/ui/Pagination";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { DeleteL4HostDialog } from "@/components/l4-proxy-hosts/L4HostDialogs";
import { L4PortsApplyBanner, portMappingFor, type PortsDiff } from "@/components/l4-proxy-hosts/L4PortsApplyBanner";
import {
  L4_DEFAULT_SORT_DIR,
  L4_SORT_LABELS,
  serverNameSummary,
  type L4ListQuery,
  type L4ProtocolFilter,
  type L4SortKey,
  type L4StatusFilter,
} from "./list";

type Props = {
  /** The hosts on this page of the list. */
  hosts: L4ProxyHost[];
  /** Every L4 host the user may see, before filters. */
  totalHosts: number;
  pagination: { total: number; page: number; perPage: number };
  query: L4ListQuery;
  /** Hosts per protocol, after the search and the status filter. */
  protocolCounts: Record<L4ProtocolFilter, number>;
  /** Hosts per status, after the search and the protocol filter. */
  statusCounts: Record<L4StatusFilter, number>;
  /** Some host has tags: the list gets a Tags column. */
  showTags?: boolean;
  /** The user may create, change and delete hosts (l4_proxy_hosts:write); true when omitted. */
  canWrite?: boolean;
  /** Change approval policies (ee/approvals), so the delete dialogs can say a host is protected. */
  approval?: HostApprovalContext | null;
};

export type L4HostStatus = { tone: StatusTone; label: string };

/** Disabled, waiting for its port to be published, or active. */
export function l4HostStatus(host: L4ProxyHost, portsDiff: PortsDiff | null): L4HostStatus {
  if (!host.enabled) return { tone: "off", label: "Disabled" };
  const mapping = portMappingFor(host);
  if (portsDiff && mapping && portsDiff.requiredPorts.includes(mapping) && !portsDiff.currentPorts.includes(mapping)) {
    return { tone: "warn", label: "Port not published" };
  }
  return { tone: "ok", label: "Active" };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function SortHeader({
  label,
  sortKey,
  query,
  onSort,
  className,
}: {
  label: string;
  sortKey: L4SortKey;
  query: L4ListQuery;
  onSort: (key: L4SortKey) => void;
  className?: string;
}) {
  const active = query.sortBy === sortKey;
  const Icon = active ? (query.sortDir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (query.sortDir === "asc" ? "ascending" : "descending") : "none"}
      className={cn("border-b border-line px-2.5 py-2 font-medium", className)}
    >
      <button type="button" onClick={() => onSort(sortKey)} className="inline-flex items-center gap-1 rounded hover:text-foreground">
        {label}
        <Icon aria-hidden="true" className={cn("h-3.5 w-3.5", !active && "opacity-50")} />
      </button>
    </th>
  );
}

function ProtocolChip({ protocol }: { protocol: string }) {
  return (
    <span data-chip className="num shrink-0 rounded bg-raise px-[5px] text-[11px] leading-[18px] text-muted-foreground">{protocol.toUpperCase()}</span>
  );
}

function Listen({ host, className }: { host: L4ProxyHost; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 whitespace-nowrap", className)}>
      <ProtocolChip protocol={host.protocol} />
      <span className="num min-w-0 truncate">{host.listenAddress}</span>
    </span>
  );
}

/** The first of a list, cut short when it does not fit, and how many more; all of them in the tooltip. */
function FirstAndMore({ items, className }: { items: readonly string[]; className?: string }) {
  if (items.length === 0) return null;
  return (
    <span className={cn("num flex min-w-0 items-baseline whitespace-nowrap", className)} title={items.length > 1 ? items.join("\n") : items[0]}>
      <span className="min-w-0 truncate">{items[0]}</span>
      {items.length > 1 && <span className="ml-1 shrink-0 text-soft">+{items.length - 1}</span>}
    </span>
  );
}

/** The SNI or HTTP Host names an L4 host matches: the first and how many more. */
function ServerNames({ host, className }: { host: L4ProxyHost; className?: string }) {
  if (!serverNameSummary(host)) return null;
  return <FirstAndMore items={host.matcherValue} className={cn("text-xs text-soft", className)} />;
}

/** Up to two tags on one line, then "+N". */
function TagChips({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return <span className="text-soft">–</span>;
  return (
    <span className="flex min-w-0 items-center gap-1 whitespace-nowrap" data-testid="host-tag-badges" title={tags.length > 2 ? tags.join(", ") : undefined}>
      {tags.slice(0, 2).map((tag) => (
        <span key={tag} data-chip className="num min-w-0 truncate rounded bg-raise px-1.5 text-[11px] leading-[18px] text-muted-foreground">
          {tag}
        </span>
      ))}
      {tags.length > 2 && <span className="shrink-0 text-[11px] text-soft">+{tags.length - 2}</span>}
    </span>
  );
}

function CountLabel({ label, count }: { label: string; count: number }): ReactNode {
  return (
    <>
      {label} <span className="num text-muted-foreground">{count}</span>
    </>
  );
}

export default function L4ProxyHostsClient({
  hosts,
  totalHosts,
  pagination,
  query,
  protocolCounts,
  statusCounts,
  showTags = false,
  canWrite = true,
  approval = null,
}: Props) {
  const [deleteHost, setDeleteHost] = useState<L4ProxyHost | null>(null);
  const [searchTerm, setSearchTerm] = useState(query.search);
  const [bannerRefresh, setBannerRefresh] = useState(0);
  const [portsDiff, setPortsDiff] = useState<PortsDiff | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkPending, startBulk] = useTransition();

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { hrefFor } = useUrlPage();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const signalBannerRefresh = () => setBannerRefresh(n => n + 1);

  useEffect(() => {
    setSearchTerm(query.search);
  }, [query.search]);

  // Keep only selected (and shown) hosts that are still on the page.
  useEffect(() => {
    const onPage = new Set(hosts.map((host) => host.id));
    setSelected((current) => {
      const kept = [...current].filter((id) => onPage.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [hosts]);

  const statusById = useMemo(() => new Map(hosts.map((host) => [host.id, l4HostStatus(host, portsDiff)])), [hosts, portsDiff]);

  function pushParams(update: (params: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString());
    update(params);
    // A new search, filter or sort starts on the first page.
    params.delete("page");
    const rest = params.toString();
    router.push(rest ? `${pathname}?${rest}` : pathname);
  }

  // Typing replaces the address instead of adding a history entry per word, keeps the scroll
  // position, and shows a spinner in the field until the list has caught up.
  const [searching, startSearch] = useTransition();
  function handleSearchChange(value: string) {
    setSearchTerm(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (value.trim()) params.set("search", value.trim());
      else params.delete("search");
      params.delete("page");
      const rest = params.toString();
      startSearch(() => router.replace(rest ? `${pathname}?${rest}` : pathname, { scroll: false }));
    }, 250);
  }

  function handleProtocolChange(value: L4ProtocolFilter) {
    pushParams((params) => {
      if (value === "all") params.delete("protocol");
      else params.set("protocol", value);
    });
  }

  function handleStatusChange(value: L4StatusFilter) {
    pushParams((params) => {
      if (value === "all") params.delete("status");
      else params.set("status", value);
    });
  }

  function handleSort(key: L4SortKey) {
    const dir = query.sortBy === key ? (query.sortDir === "asc" ? "desc" : "asc") : L4_DEFAULT_SORT_DIR[key];
    pushParams((params) => {
      params.set("sortBy", key);
      params.set("sortDir", dir);
    });
  }

  function clearFilters() {
    setSearchTerm("");
    pushParams((params) => {
      for (const key of ["search", "protocol", "status"]) params.delete(key);
    });
  }

  const handleToggleEnabled = async (id: number, enabled: boolean) => {
    const result = await toggleL4ProxyHostAction(id, enabled);
    signalBannerRefresh();
    // A protected host is not toggled at once: the change waits for approval (ee/approvals).
    if (result.status === "error") toast.error(result.message ?? "Failed to toggle L4 proxy host");
    else if (result.changeRequest) toast.info(result.message ?? "Submitted for approval", { duration: 10000 });
    router.refresh();
  };

  // ── Selection and bulk actions ──
  const selectedHosts = hosts.filter((host) => selected.has(host.id));
  const allSelected = hosts.length > 0 && selectedHosts.length === hosts.length;
  const someSelected = selectedHosts.length > 0 && !allSelected;
  const anyEnabled = selectedHosts.some((host) => host.enabled);
  const anyDisabled = selectedHosts.some((host) => !host.enabled);

  function toggleRow(id: number, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(hosts.map((host) => host.id)) : new Set());
  }

  function runBulk(operation: L4BulkOperation) {
    const ids = selectedHosts.map((host) => host.id);
    startBulk(async () => {
      try {
        const result = await bulkL4ProxyHostsAction(ids, operation);
        if (result.ok) toast.success(result.message);
        else toast.error(result.message, { duration: 10000 });
        if (result.changed + result.submitted + result.unchanged > 0) setSelected(new Set());
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "The bulk action failed.");
      }
      setBulkDeleteOpen(false);
      signalBannerRefresh();
      router.refresh();
    });
  }

  const actionsMenu = (host: L4ProxyHost) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${host.name}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={`/l4-proxy-hosts/${host.id}`}>Open</Link>
        </DropdownMenuItem>
        {canWrite && (
          <>
            <DropdownMenuItem asChild>
              <Link href={`/l4-proxy-hosts/${host.id}#routing`}>Edit</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/l4-proxy-hosts/new?from=${host.id}`}>Duplicate</Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-bad focus:text-bad" onSelect={() => setDeleteHost(host)}>
              Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const enabledSwitch = (host: L4ProxyHost) =>
    canWrite && (
      <Switch
        checked={host.enabled}
        aria-label={`${host.enabled ? "Disable" : "Enable"} ${host.name}`}
        onCheckedChange={(checked) => handleToggleEnabled(host.id, checked)}
      />
    );

  const nameLink = (host: L4ProxyHost, className?: string) => (
    <Link href={`/l4-proxy-hosts/${host.id}`} className={cn("min-w-0 truncate font-semibold text-foreground underline-offset-4 hover:underline", className)}>
      {host.name}
    </Link>
  );

  const filtering = Boolean(query.search) || query.protocol !== "all" || query.status !== "all";

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader
        className="mb-0"
        breadcrumb={["Traffic", "L4 hosts"]}
        title="L4 hosts"
        count={totalHosts}
        actions={
          canWrite ? (
            <Button asChild>
              <Link href="/l4-proxy-hosts/new">
                <Plus />
                New L4 host
              </Link>
            </Button>
          ) : undefined
        }
      />

      <L4PortsApplyBanner refreshSignal={bannerRefresh} canApply={canWrite} hosts={hosts} onDiff={setPortsDiff} />

      {totalHosts === 0 ? (
        <section aria-label="L4 hosts" className="rounded-2xl border border-line bg-panel">
          <EmptyState
            icon={Network}
            title="No L4 hosts yet"
            description="Forward TCP or UDP traffic, such as SSH, mail or WireGuard, to a service on your network."
            action={
              canWrite ? (
                <Button asChild>
                  <Link href="/l4-proxy-hosts/new">
                    <Plus />
                    New L4 host
                  </Link>
                </Button>
              ) : undefined
            }
          />
        </section>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2.5">
            <ListSearchField
              className="flex-[1_1_280px]"
              value={searchTerm}
              onChange={handleSearchChange}
              placeholder="Name, port, upstream or server name"
              label="Filter L4 hosts"
              pending={searching}
            />
            <SegmentedControl<L4ProtocolFilter>
              label="Protocol"
              className="max-md:order-3"
              value={query.protocol}
              onChange={handleProtocolChange}
              options={[
                { value: "all", label: <CountLabel label="All" count={protocolCounts.all} /> },
                { value: "tcp", label: <CountLabel label="TCP" count={protocolCounts.tcp} /> },
                { value: "udp", label: <CountLabel label="UDP" count={protocolCounts.udp} /> },
              ]}
            />
            <SegmentedControl<L4StatusFilter>
              label="Status"
              className="max-md:order-1"
              value={query.status}
              onChange={handleStatusChange}
              options={[
                { value: "all", label: <CountLabel label="All" count={statusCounts.all} /> },
                { value: "enabled", label: <CountLabel label="Enabled" count={statusCounts.enabled} /> },
                { value: "disabled", label: <CountLabel label="Disabled" count={statusCounts.disabled} /> },
              ]}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="h-[38px] w-[38px] max-md:order-2 md:hidden" title={`Sort: ${L4_SORT_LABELS[query.sortBy]}`}>
                  <ArrowUpDown aria-hidden="true" />
                  <span className="sr-only">Sort: {L4_SORT_LABELS[query.sortBy]}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                {(Object.keys(L4_SORT_LABELS) as L4SortKey[]).map((key) => (
                  <DropdownMenuItem key={key} onSelect={() => handleSort(key)} className="justify-between">
                    {L4_SORT_LABELS[key]}
                    {query.sortBy === key &&
                      (query.sortDir === "asc" ? (
                        <ArrowUp aria-label="ascending" className="h-3.5 w-3.5" />
                      ) : (
                        <ArrowDown aria-label="descending" className="h-3.5 w-3.5" />
                      ))}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {filtering && hosts.length > 0 && (
              <Button variant="ghost" size="sm" className="max-md:order-4" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </div>

          <section aria-label="L4 hosts" className="min-w-0 overflow-hidden rounded-2xl border border-line bg-panel">
            {canWrite && selectedHosts.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-b border-line bg-brand-tint px-[18px] py-2.5">
                <span className="mr-2 font-semibold" aria-live="polite">
                  {plural(selectedHosts.length, "host")} selected
                </span>
                {anyDisabled && (
                  <Button variant="outline" size="sm" disabled={bulkPending} onClick={() => runBulk({ type: "enable" })}>
                    Enable
                  </Button>
                )}
                {anyEnabled && (
                  <Button variant="outline" size="sm" disabled={bulkPending} onClick={() => runBulk({ type: "disable" })}>
                    Disable
                  </Button>
                )}
                <Button variant="danger" size="sm" disabled={bulkPending} onClick={() => setBulkDeleteOpen(true)}>
                  Delete
                </Button>
                <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSelected(new Set())}>
                  Clear selection
                </Button>
              </div>
            )}

            {hosts.length === 0 ? (
              <EmptyState
                compact
                icon={null}
                title="No L4 host matches these filters."
                action={
                  <Button variant="secondary" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <>
                <div className="hidden overflow-x-auto md:block">
                  {/* Fixed column widths: long names, upstreams and tags are cut short instead of widening the table. */}
                  <table className="w-full min-w-[880px] table-fixed border-collapse text-[13px]">
                    <colgroup>
                      {canWrite && <col className="w-[44px]" />}
                      <col />
                      <col className="w-[170px]" />
                      <col className="w-[20%]" />
                      {showTags && <col className="w-[160px]" />}
                      <col className="w-[170px]" />
                      <col className={canWrite ? "w-[104px]" : "w-[64px]"} />
                    </colgroup>
                    <thead>
                      <tr className="text-left text-xs text-soft">
                        {canWrite && (
                          <th scope="col" className="border-b border-line py-2 pl-[18px] pr-2">
                            <Checkbox
                              aria-label="Select every host on this page"
                              checked={allSelected ? true : someSelected ? "indeterminate" : false}
                              onCheckedChange={(checked) => toggleAll(checked === true)}
                            />
                          </th>
                        )}
                        <SortHeader label="Name" sortKey="name" query={query} onSort={handleSort} className={cn(!canWrite && "pl-[18px]")} />
                        <SortHeader label="Listen" sortKey="listenAddress" query={query} onSort={handleSort} />
                        <SortHeader label="Upstream" sortKey="upstreams" query={query} onSort={handleSort} />
                        {showTags && (
                          <th scope="col" className="border-b border-line px-2.5 py-2 font-medium">
                            Tags
                          </th>
                        )}
                        <SortHeader label="Status" sortKey="enabled" query={query} onSort={handleSort} />
                        <th scope="col" className="border-b border-line py-2 pl-1.5 pr-[18px]">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {hosts.map((host) => {
                        const isSelected = selected.has(host.id);
                        const status = statusById.get(host.id)!;
                        return (
                          <tr
                            key={host.id}
                            className={cn(
                              "border-b border-line last:border-b-0 hover:bg-panel2",
                              // Chips keep their contrast on the tint.
                              isSelected && "bg-brand-tint hover:bg-brand-tint [&_[data-chip]]:bg-panel",
                              !host.enabled && "text-muted-foreground"
                            )}
                          >
                            {canWrite && (
                              <td className="py-2.5 pl-[18px] pr-2">
                                <Checkbox
                                  aria-label={`Select ${host.name}`}
                                  checked={isSelected}
                                  onCheckedChange={(checked) => toggleRow(host.id, checked === true)}
                                />
                              </td>
                            )}
                            <td className={cn("px-2.5 py-2.5", !canWrite && "pl-[18px]")}>
                              <span className="flex min-w-0 items-baseline gap-2">
                                {nameLink(host, "max-w-full shrink-0")}
                                <ServerNames host={host} />
                              </span>
                            </td>
                            <td className="px-2.5 py-2.5">
                              <Listen host={host} />
                            </td>
                            <td className="px-2.5 py-2.5">
                              <FirstAndMore items={host.upstreams} />
                            </td>
                            {showTags && (
                              <td className="px-2.5 py-2.5">
                                <TagChips tags={host.tags} />
                              </td>
                            )}
                            <td className="px-2.5 py-2.5">
                              <StatusDot tone={status.tone} label={status.label} className="whitespace-nowrap" />
                            </td>
                            <td className="py-2 pl-1.5 pr-[18px]">
                              <span className="flex items-center justify-end gap-2">
                                {enabledSwitch(host)}
                                {actionsMenu(host)}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <ul className="flex flex-col md:hidden" aria-label="L4 hosts">
                  {hosts.map((host) => {
                    const status = statusById.get(host.id)!;
                    return (
                      <li
                        key={host.id}
                        className={cn("flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0", selected.has(host.id) && "bg-brand-tint [&_[data-chip]]:bg-panel")}
                      >
                        {canWrite && (
                          <Checkbox
                            className="mt-1"
                            aria-label={`Select ${host.name}`}
                            checked={selected.has(host.id)}
                            onCheckedChange={(checked) => toggleRow(host.id, checked === true)}
                          />
                        )}
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          {nameLink(host)}
                          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                            <Listen host={host} className="shrink-0" />
                            <span aria-hidden="true" className="text-soft">→</span>
                            <FirstAndMore items={host.upstreams} />
                          </span>
                          <ServerNames host={host} />
                          <StatusDot tone={status.tone} label={status.label} className="text-xs" />
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {enabledSwitch(host)}
                          {actionsMenu(host)}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}

            <Pagination
              page={pagination.page}
              perPage={pagination.perPage}
              total={pagination.total}
              noun="hosts"
              label="Pages of L4 hosts"
              hrefFor={hrefFor}
              className="border-t border-line px-[18px] py-3"
            />
          </section>
        </>
      )}

      {deleteHost && (
        <DeleteL4HostDialog
          open={!!deleteHost}
          host={deleteHost}
          onClose={() => { setDeleteHost(null); signalBannerRefresh(); router.refresh(); }}
          approval={approval}
        />
      )}

      <AppDialog
        open={bulkDeleteOpen}
        onClose={() => setBulkDeleteOpen(false)}
        title={`Delete ${plural(selectedHosts.length, "L4 host")}`}
        maxWidth="md"
        submitLabel="Delete"
        isSubmitting={bulkPending}
        onSubmit={() => runBulk({ type: "delete" })}
      >
        <div className="flex flex-col gap-3 text-sm">
          <p>These hosts stop forwarding traffic on their ports:</p>
          <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-lg border border-line bg-panel2 px-3 py-2">
            {selectedHosts.map((host) => (
              <li key={host.id} className="flex min-w-0 items-baseline gap-2">
                <span className="truncate">{host.name}</span>
                <span className="num shrink-0 text-xs text-soft">
                  {host.listenAddress}/{host.protocol}
                </span>
              </li>
            ))}
          </ul>
          {approval && approval.policies.length > 0 && (
            <p className="text-muted-foreground">Hosts a change approval policy protects get a change request instead.</p>
          )}
          <p className="font-medium text-bad">This cannot be undone.</p>
        </div>
      </AppDialog>
    </div>
  );
}
