"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { MoreHorizontal, Plus, ShieldCheck } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ExpiryTimeline, type ExpiryItem } from "@/components/ui/ExpiryTimeline";
import { Pagination } from "@/components/ui/Pagination";
import { SectionCard } from "@/components/ui/SectionCard";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { StatusDot } from "@/components/ui/StatusDot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { DEFAULT_PAGE_SIZE, paginate } from "@/src/lib/pagination";
import {
  RENEWAL_WINDOW_DAYS,
  isHealthy,
  needsAttention,
  type CertificateOverviewRow,
} from "@/src/lib/certificate-renewal";
import { NEW_HOST_HREF } from "../../proxy-hosts/links";
import { deleteCertificateAction } from "../actions";
import {
  daysLeftText,
  expiryToneFor,
  formatDate,
  obtainedView,
  renewalView,
  rowSearchText,
  timelineDetail,
  usedBySummary,
  userHref,
} from "../format";
import type { ImportedCertView } from "../page";
import { HostsCell, type HostLink } from "./HostsCell";
import { ListSearch } from "./ListSearch";

const TIMELINE_DAYS = 90;

type StatusFilter = "all" | "due" | "ok";

type Props = {
  rows: CertificateOverviewRow[];
  generatedAt: string;
  canWrite: boolean;
  onEditImported: (cert: ImportedCertView) => void;
};

function rowDomId(id: string): string {
  return `certificate-row-${id.replace(/[^a-z0-9-]/gi, "-")}`;
}

/** The row's table row or, on phones, its card: whichever is shown. */
function shownRowElement(id: string): HTMLElement | null {
  const rowId = rowDomId(id);
  for (const element of [document.getElementById(rowId), document.getElementById(`${rowId}-card`)]) {
    if (element && element.offsetParent !== null) return element;
  }
  return null;
}

function rowLabel(row: CertificateOverviewRow): string {
  return row.domains[0] ?? row.name;
}

export function CertificatesTab({ rows, generatedAt, canWrite, onEditImported }: Props) {
  const now = new Date(generatedAt).getTime();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [deleting, setDeleting] = useState<CertificateOverviewRow | null>(null);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      rows.filter((row) => {
        if (status === "due" && !needsAttention(row)) return false;
        if (status === "ok" && !isHealthy(row)) return false;
        return !q || rowSearchText(row).includes(q);
      }),
    [rows, status, q]
  );
  const slice = paginate(filtered, page);
  const filtering = q !== "" || status !== "all";

  const dueCount = rows.filter(needsAttention).length;
  const healthyCount = rows.filter(isHealthy).length;
  const withExpiry = rows.filter((row) => row.daysLeft !== null && row.renewal.state !== "inactive");
  const items: ExpiryItem[] = withExpiry
    .filter((row) => row.daysLeft! <= TIMELINE_DAYS)
    .map((row) => ({
      id: row.id,
      label: rowLabel(row),
      daysLeft: row.daysLeft!,
      detail: timelineDetail(row),
      tone: expiryToneFor(row),
    }));

  useEffect(() => {
    if (!selectedId) return;
    shownRowElement(selectedId)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  function selectFromTimeline(item: ExpiryItem) {
    if (selectedId === item.id) {
      setSelectedId(null);
      return;
    }
    // Show the row: clear the filters and turn to its page.
    setQuery("");
    setStatus("all");
    const index = rows.findIndex((row) => row.id === item.id);
    setPage(index >= 0 ? Math.floor(index / DEFAULT_PAGE_SIZE) + 1 : 1);
    setSelectedId(item.id);
  }

  function clearFilters() {
    setQuery("");
    setStatus("all");
    setPage(1);
  }

  if (rows.length === 0) {
    return (
      <SectionCard title="Certificates" divided={false}>
        <EmptyState
          icon={ShieldCheck}
          title="No certificates yet"
          action={
            <Button asChild variant="outline">
              <Link href={NEW_HOST_HREF}>
                <Plus />
                New proxy host
              </Link>
            </Button>
          }
        />
      </SectionCard>
    );
  }

  const editRow = (row: CertificateOverviewRow) => () =>
    onEditImported({ id: row.certificateId!, name: row.name, domains: row.domains });

  return (
    <div className="flex flex-col gap-4">
      <SectionCard title={`Expiry, next ${TIMELINE_DAYS} days`} divided={false} contentClassName="px-5 pb-4">
        {items.length === 0 ? (
          <p className="m-0 text-[13px] text-muted-foreground">
            {withExpiry.length === 0 ? "No expiry dates known yet." : `Nothing expires in the next ${TIMELINE_DAYS} days.`}
          </p>
        ) : (
          <ExpiryTimeline
            items={items}
            title={`Expiry, next ${TIMELINE_DAYS} days`}
            maxDays={TIMELINE_DAYS}
            renewalDays={RENEWAL_WINDOW_DAYS}
            now={now}
            selectedId={selectedId}
            onSelect={selectFromTimeline}
          />
        )}
      </SectionCard>

      <div className="flex flex-wrap items-center gap-2.5">
        <ListSearch
          label="Search certificates"
          placeholder="Domain or host"
          value={query}
          onChange={(value) => {
            setQuery(value);
            setPage(1);
          }}
          className="flex-[1_1_280px]"
        />
        <SegmentedControl<StatusFilter>
          label="Status"
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
          options={[
            { value: "all", label: <>All <span className="num text-muted-foreground">{rows.length}</span></> },
            { value: "due", label: <>Due for renewal <span className="num text-warn">{dueCount}</span></> },
            { value: "ok", label: <>Healthy <span className="num text-muted-foreground">{healthyCount}</span></> },
          ]}
        />
        {filtering && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </div>

      <section aria-label="Certificates" className="min-w-0 overflow-hidden rounded-2xl border border-line bg-panel">
        {filtered.length === 0 ? (
          <EmptyState
            compact
            icon={null}
            title="No certificate matches these filters"
            action={
              <Button variant="secondary" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <>
            <div className="hidden md:block">
              <Table className="min-w-[1040px]">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Domains</TableHead>
                    <TableHead scope="col">Issuer</TableHead>
                    <TableHead scope="col">Obtained by</TableHead>
                    <TableHead scope="col">Expires</TableHead>
                    <TableHead scope="col">Renewal</TableHead>
                    <TableHead scope="col">Used by</TableHead>
                    <TableHead scope="col" className="w-12">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {slice.items.map((row) => (
                    <CertificateTableRow
                      key={row.id}
                      row={row}
                      now={now}
                      selected={row.id === selectedId}
                      canWrite={canWrite}
                      onEdit={editRow(row)}
                      onDelete={() => setDeleting(row)}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
            <ul aria-label="Certificates" className="m-0 flex list-none flex-col p-0 md:hidden">
              {slice.items.map((row) => (
                <CertificateCard
                  key={row.id}
                  row={row}
                  now={now}
                  selected={row.id === selectedId}
                  canWrite={canWrite}
                  onEdit={editRow(row)}
                  onDelete={() => setDeleting(row)}
                />
              ))}
            </ul>
          </>
        )}
        {slice.pageCount > 1 && (
          <div className="border-t border-line px-[18px] py-2.5">
            <Pagination
              page={slice.page}
              perPage={slice.perPage}
              total={slice.total}
              noun="certificates"
              label="Pages of certificates"
              onPageChange={setPage}
            />
          </div>
        )}
      </section>

      {deleting && <DeleteCertificateDialog row={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

/** What the table row and the phone card show of a certificate. */
function rowParts(row: CertificateOverviewRow, now: number) {
  const label = rowLabel(row);
  const extraDomains = row.domains.length - 1;
  const more = row.kind === "acme" ? Math.max(0, extraDomains - 1) : Math.max(0, extraDomains);
  const second = row.kind === "acme" ? row.domains[1] ?? null : row.name !== label ? row.name : null;
  const obtained = obtainedView(row.obtainedBy);
  const expiryTone =
    row.daysLeft === null
      ? "text-soft"
      : row.renewal.state === "expired" || row.renewal.state === "overdue"
        ? "font-semibold text-bad"
        : needsAttention(row)
          ? "font-semibold text-warn"
          : "text-soft";
  const hostLinks: HostLink[] = row.usedBy.map((user) => ({
    key: `${user.kind}-${user.id}`,
    name: user.name,
    href: userHref(user),
    note: user.kind === "l4_host" ? "L4" : undefined,
  }));
  return {
    label,
    more,
    second,
    // Entries left from earlier versions: Caddy obtains these on its own, and the entry can be deleted.
    obtained: row.kind === "managed" ? { label: obtained.label, detail: "Older entry" } : obtained,
    renewal: renewalView(row, now),
    expiryTone,
    hostLinks,
  };
}

function CertificateTableRow({
  row,
  now,
  selected,
  canWrite,
  onEdit,
  onDelete,
}: {
  row: CertificateOverviewRow;
  now: number;
  selected: boolean;
  canWrite: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { label, more, second, obtained, renewal, expiryTone, hostLinks } = rowParts(row, now);

  return (
    <TableRow id={rowDomId(row.id)} className={cn(selected && "bg-brand-tint hover:bg-brand-tint", !row.active && "text-muted-foreground")}>
      <th scope="row" className="max-w-[320px] px-3 py-2.5 text-left align-middle font-normal first:pl-4">
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-semibold text-foreground" title={row.domains.join(", ")}>
            {label}
            {more > 0 && <span className="ml-1.5 font-normal text-soft">+{more}</span>}
          </span>
          {second && <span className={cn("truncate text-xs text-soft", row.kind === "acme" && "num")}>{second}</span>}
        </span>
      </th>
      <TableCell>
        <span className="flex flex-col">
          <span className={cn(!row.issuer && "text-soft")}>{row.issuer ?? "Unknown"}</span>
          <span className="text-xs text-soft">{row.keyType ?? (row.issuerFromCertificate ? "" : "Configured CA")}</span>
        </span>
      </TableCell>
      <TableCell>
        <span className="flex flex-col">
          <span className={cn(row.obtainedBy.method === "acme" && "num")}>{obtained.label}</span>
          {obtained.detail && <span className="text-xs text-soft">{obtained.detail}</span>}
        </span>
      </TableCell>
      <TableCell>
        {row.validTo ? (
          <span className="flex flex-col">
            <span>{formatDate(row.validTo)}</span>
            <span className={cn("num text-xs", expiryTone)}>{daysLeftText(row.daysLeft!)}</span>
          </span>
        ) : (
          <span className="text-soft">Not read yet</span>
        )}
      </TableCell>
      <TableCell>
        <span className="flex flex-col">
          <StatusDot tone={renewal.tone} label={renewal.label} className={cn(renewal.tone !== "ok" && renewal.tone !== "off" && "font-semibold")} />
          {renewal.detail && <span className="text-xs text-soft">{renewal.detail}</span>}
        </span>
      </TableCell>
      <TableCell>
        <HostsCell hosts={hostLinks} summary={row.usedBy.length > 0 ? usedBySummary(row.usedBy) : undefined} emptyText="Not used" />
      </TableCell>
      <TableCell className="text-right">
        <RowActions row={row} canWrite={canWrite} onEdit={onEdit} onDelete={onDelete} />
      </TableCell>
    </TableRow>
  );
}

function CertificateCard({
  row,
  now,
  selected,
  canWrite,
  onEdit,
  onDelete,
}: {
  row: CertificateOverviewRow;
  now: number;
  selected: boolean;
  canWrite: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { label, obtained, renewal, expiryTone, hostLinks } = rowParts(row, now);
  const more = row.domains.length - 1;
  return (
    <li
      id={`${rowDomId(row.id)}-card`}
      className={cn(
        "flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0",
        selected && "bg-brand-tint",
        !row.active && "text-muted-foreground"
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate font-semibold text-foreground" title={row.domains.join(", ")}>
          {label}
          {more > 0 && <span className="ml-1.5 font-normal text-soft">+{more}</span>}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <StatusDot tone={renewal.tone} label={renewal.label} className={cn(renewal.tone !== "ok" && renewal.tone !== "off" && "font-semibold")} />
          {renewal.detail && <span className="text-xs text-soft">{renewal.detail}</span>}
        </span>
        <span className="text-xs text-soft">
          {row.validTo ? (
            <>
              Expires {formatDate(row.validTo)} · <span className={cn("num", expiryTone)}>{daysLeftText(row.daysLeft!)}</span>
            </>
          ) : (
            "Expiry not read yet"
          )}
        </span>
        <span className="truncate text-xs text-soft">
          {[row.issuer ?? "Unknown issuer", obtained.label, obtained.detail].filter(Boolean).join(" · ")}
        </span>
        <div className="text-xs">
          <HostsCell hosts={hostLinks} emptyText="Not used" />
        </div>
      </div>
      <div className="shrink-0">
        <RowActions row={row} canWrite={canWrite} onEdit={onEdit} onDelete={onDelete} />
      </div>
    </li>
  );
}

function RowActions({
  row,
  canWrite,
  onEdit,
  onDelete,
}: {
  row: CertificateOverviewRow;
  canWrite: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const host = row.kind === "acme" ? row.usedBy.find((user) => user.kind === "proxy_host" && user.id === row.hostId) : null;
  const editable = canWrite && row.kind === "imported";
  const deletable = canWrite && row.kind !== "acme";
  if (!host && !editable && !deletable) return null;
  const name = row.kind === "acme" ? rowLabel(row) : row.name;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${name}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {host && (
          <DropdownMenuItem asChild>
            <Link href={userHref(host)}>Open proxy host</Link>
          </DropdownMenuItem>
        )}
        {editable && <DropdownMenuItem onSelect={onEdit}>Edit</DropdownMenuItem>}
        {deletable && (
          <DropdownMenuItem className="text-bad focus:text-bad" onSelect={onDelete}>
            Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DeleteCertificateDialog({ row, onClose }: { row: CertificateOverviewRow; onClose: () => void }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const imported = row.kind === "imported";

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await deleteCertificateAction(row.certificateId!);
        if (result.ok) onClose();
        else setError(result.error);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete certificate");
      }
    });
  }

  return (
    <AppDialog
      open
      onClose={() => {
        if (!isPending) onClose();
      }}
      title={imported ? "Delete imported certificate" : "Delete certificate entry"}
      maxWidth="sm"
      actions={
        <>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleDelete} disabled={isPending}>
            {isPending ? "Deleting…" : "Delete certificate"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="m-0 text-sm text-muted-foreground">
          Delete <strong className="text-foreground">{row.name}</strong>? This cannot be undone.
          {row.usedBy.length > 0 && ` ${row.usedBy.length === 1 ? "1 host uses" : `${row.usedBy.length} hosts use`} it.`}
        </p>
        {row.usedBy.some((user) => user.kind === "proxy_host") && (
          <p className="m-0 text-sm text-muted-foreground">
            Its proxy hosts switch to a certificate Caddy obtains, which needs their domains to point at this server (or a
            DNS provider).
          </p>
        )}
        {error && <p className="m-0 text-sm text-bad">{error}</p>}
      </div>
    </AppDialog>
  );
}
