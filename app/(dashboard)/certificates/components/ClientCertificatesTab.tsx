"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, BadgeCheck, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { SectionCard } from "@/components/ui/SectionCard";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { StatusDot } from "@/components/ui/StatusDot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { paginate } from "@/src/lib/pagination";
import { usePreferences } from "@/src/components/preferences/PreferencesProvider";
import { revokeIssuedClientCertificateAction, revokeIssuedClientCertificatesAction } from "../ca-actions";
import type { CaCertificateView, IssuedClientCertificateView, MtlsRoleView } from "../page";
import {
  CLIENT_CERT_SORT_LABELS,
  DEFAULT_SORT_DIRECTION,
  NO_CLIENT_CERT_FILTERS,
  clientCertSortFromPreference,
  clientCertStatus,
  clientCertStatusCounts,
  filterClientCerts,
  sortClientCerts,
  type ClientCertFilters,
  type ClientCertSort,
  type ClientCertSortKey,
  type ClientCertStatusFilter,
} from "../client-list";
import { formatDate, formatShortDate } from "../format";
import { ListSearch } from "./ListSearch";
import { MtlsRoles } from "./MtlsRoles";

const DAY_MS = 86_400_000;

type Props = {
  clientCertificates: IssuedClientCertificateView[];
  roles: MtlsRoleView[];
  caCertificates: CaCertificateView[];
  generatedAt: string;
  canWrite: boolean;
  onIssue: (ca: CaCertificateView) => void;
  /** The search and filters of the list (kept by the page, so a certificate authority can set them). */
  filters: ClientCertFilters;
  onFiltersChange: (filters: ClientCertFilters) => void;
};

/** The phone sort menu: a column and its direction. */
const PHONE_SORTS: { sort: ClientCertSort; label: string }[] = [
  { sort: { key: "expires", dir: "asc" }, label: "Expires, soonest first" },
  { sort: { key: "expires", dir: "desc" }, label: "Expires, latest first" },
  { sort: { key: "issued", dir: "desc" }, label: "Newest first" },
  { sort: { key: "issued", dir: "asc" }, label: "Oldest first" },
  { sort: { key: "name", dir: "asc" }, label: "Common name" },
  { sort: { key: "ca", dir: "asc" }, label: "Issued by" },
];

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/**
 * The "Issue client certificate" button: a menu of the certificate
 * authorities whose private key is stored (only those can sign).
 */
export function IssueClientCertificateMenu({
  caCertificates,
  onIssue,
  variant = "default",
}: {
  caCertificates: CaCertificateView[];
  onIssue: (ca: CaCertificateView) => void;
  variant?: "default" | "outline";
}) {
  const signers = caCertificates.filter((ca) => ca.hasPrivateKey);
  if (signers.length === 0) {
    return (
      <Button variant={variant} disabled title="Add a certificate authority with a stored private key first">
        Issue client certificate
      </Button>
    );
  }
  if (signers.length === 1) {
    return (
      <Button variant={variant} onClick={() => onIssue(signers[0])}>
        Issue client certificate
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant}>
          Issue client certificate
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Signed by</DropdownMenuLabel>
        {signers.map((ca) => (
          <DropdownMenuItem key={ca.id} onSelect={() => onIssue(ca)}>
            {ca.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CertStatus({ cert, now }: { cert: IssuedClientCertificateView; now: number }) {
  switch (clientCertStatus(cert, now)) {
    case "revoked":
      return <StatusDot tone="off" label={`Revoked ${formatShortDate(cert.revokedAt!)}`} />;
    case "expired":
      return <StatusDot tone="bad" label="Expired" />;
    case "expiring": {
      const days = Math.floor((Date.parse(cert.validTo) - now) / DAY_MS);
      return <StatusDot tone="warn" label={days < 1 ? "Expires today" : `Expires in ${plural(days, "day")}`} />;
    }
    default:
      return <StatusDot tone="ok" label="Active" />;
  }
}

function SortHeader({
  sortKey,
  sort,
  onSort,
  className,
}: {
  sortKey: ClientCertSortKey;
  sort: ClientCertSort;
  onSort: (key: ClientCertSortKey) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  const Icon = active ? (sort.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={cn("border-b border-line px-2.5 py-2 font-medium", className)}
    >
      <button type="button" onClick={() => onSort(sortKey)} className="inline-flex items-center gap-1 rounded hover:text-foreground">
        {CLIENT_CERT_SORT_LABELS[sortKey]}
        <Icon aria-hidden="true" className={cn("h-3.5 w-3.5", !active && "opacity-50")} />
      </button>
    </th>
  );
}

const PLAIN_HEADER = "border-b border-line px-2.5 py-2 font-medium";

export function ClientCertificatesTab({
  clientCertificates,
  roles,
  caCertificates,
  generatedAt,
  canWrite,
  onIssue,
  filters,
  onFiltersChange,
}: Props) {
  const now = new Date(generatedAt).getTime();
  const { preferences } = usePreferences();
  const [sort, setSort] = useState<ClientCertSort>(
    () => clientCertSortFromPreference(preferences.clientCertificatesSort)
  );
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [revoking, setRevoking] = useState<IssuedClientCertificateView[] | null>(null);
  // Back to the first page whenever the filters change, here or from a certificate authority.
  const [pagedFilters, setPagedFilters] = useState(filters);
  if (pagedFilters !== filters) {
    setPagedFilters(filters);
    setPage(1);
  }

  const filtered = useMemo(
    () => sortClientCerts(filterClientCerts(clientCertificates, filters, now), sort),
    [clientCertificates, filters, now, sort]
  );
  const counts = useMemo(
    () => clientCertStatusCounts(clientCertificates, { query: filters.query, caId: filters.caId }, now),
    [clientCertificates, filters.query, filters.caId, now]
  );
  const slice = paginate(filtered, page);
  const filtering = filters.query.trim() !== "" || filters.caId !== null || filters.status !== "all";

  // The CA filter offers the certificate authorities that issued certificates here.
  const issuers = caCertificates.filter((ca) => ca.issued.active + ca.issued.revoked > 0 || ca.id === filters.caId);
  const caFilterName = filters.caId === null ? null : caCertificates.find((ca) => ca.id === filters.caId)?.name ?? "Unknown";

  // Selection: certificates that can still be revoked, kept across pages and filters.
  const selectedCerts = sortClientCerts(
    clientCertificates.filter((cert) => selected.has(cert.id) && !cert.revokedAt),
    sort
  );
  const pageRevocable = slice.items.filter((cert) => !cert.revokedAt);
  const pageSelected = pageRevocable.filter((cert) => selected.has(cert.id)).length;
  const matchingRevocable = filtered.filter((cert) => !cert.revokedAt);
  const matchingUnselected = matchingRevocable.filter((cert) => !selected.has(cert.id)).length;

  function updateFilters(next: Partial<ClientCertFilters>) {
    onFiltersChange({ ...filters, ...next });
  }

  function sortBy(key: ClientCertSortKey) {
    setSort((current) =>
      current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: DEFAULT_SORT_DIRECTION[key] }
    );
    setPage(1);
  }

  function toggle(ids: number[], on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  const checkbox = (cert: IssuedClientCertificateView, className?: string) =>
    cert.revokedAt ? (
      <span aria-hidden="true" className={cn("inline-block h-4 w-4", className)} />
    ) : (
      <Checkbox
        className={className}
        aria-label={`Select ${cert.commonName}`}
        checked={selected.has(cert.id)}
        onCheckedChange={(checked) => toggle([cert.id], checked === true)}
      />
    );

  const revokeButton = (cert: IssuedClientCertificateView) =>
    canWrite && !cert.revokedAt ? (
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-bad"
        aria-label={`Revoke ${cert.commonName}`}
        onClick={() => setRevoking([cert])}
      >
        Revoke
      </Button>
    ) : null;

  const phoneSort = PHONE_SORTS.find((option) => option.sort.key === sort.key && option.sort.dir === sort.dir);

  return (
    <div className="flex flex-col gap-4">
      <MtlsRoles roles={roles} clientCertificates={clientCertificates} canWrite={canWrite} />

      <SectionCard title="Client certificates" count={clientCertificates.length} divided={clientCertificates.length === 0}>
        {clientCertificates.length === 0 ? (
          <EmptyState
            compact
            icon={BadgeCheck}
            title="No client certificates yet"
            action={
              canWrite ? <IssueClientCertificateMenu caCertificates={caCertificates} onIssue={onIssue} variant="outline" /> : undefined
            }
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-[18px] pb-3">
              <ListSearch
                label="Search client certificates"
                placeholder="Common name, serial, role or CA"
                value={filters.query}
                onChange={(query) => updateFilters({ query })}
              />
              <SegmentedControl<ClientCertStatusFilter>
                label="Status"
                value={filters.status}
                onChange={(status) => updateFilters({ status })}
                options={[
                  { value: "all", label: <>All <span className="num text-muted-foreground">{counts.all}</span></> },
                  { value: "active", label: <>Active <span className="num text-muted-foreground">{counts.active}</span></> },
                  {
                    value: "expiring",
                    label: (
                      <>
                        Expiring <span className={cn("num", counts.expiring > 0 ? "text-warn" : "text-muted-foreground")}>{counts.expiring}</span>
                      </>
                    ),
                  },
                  {
                    value: "expired",
                    label: (
                      <>
                        Expired <span className={cn("num", counts.expired > 0 ? "text-bad" : "text-muted-foreground")}>{counts.expired}</span>
                      </>
                    ),
                  },
                  { value: "revoked", label: <>Revoked <span className="num text-muted-foreground">{counts.revoked}</span></> },
                ]}
              />
              {(issuers.length > 1 || filters.caId !== null) && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="h-[38px] max-w-[280px]">
                      <span className="truncate">{caFilterName ? `CA: ${caFilterName}` : "CA"}</span>
                      <ChevronDown aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
                    <DropdownMenuLabel>Issued by</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={filters.caId === null ? "any" : String(filters.caId)}
                      onValueChange={(value) => updateFilters({ caId: value === "any" ? null : Number(value) })}
                    >
                      <DropdownMenuRadioItem value="any">Any certificate authority</DropdownMenuRadioItem>
                      {issuers.map((ca) => (
                        <DropdownMenuRadioItem key={ca.id} value={String(ca.id)}>
                          {ca.name}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="h-[38px] md:hidden">
                    {phoneSort?.label ?? CLIENT_CERT_SORT_LABELS[sort.key]}
                    <ChevronDown aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuLabel>Sort</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={`${sort.key}:${sort.dir}`}
                    onValueChange={(value) => {
                      const option = PHONE_SORTS.find((o) => `${o.sort.key}:${o.sort.dir}` === value);
                      if (option) {
                        setSort(option.sort);
                        setPage(1);
                      }
                    }}
                  >
                    {PHONE_SORTS.map((option) => (
                      <DropdownMenuRadioItem key={`${option.sort.key}:${option.sort.dir}`} value={`${option.sort.key}:${option.sort.dir}`}>
                        {option.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              {filtering && (
                <Button variant="ghost" size="sm" onClick={() => onFiltersChange(NO_CLIENT_CERT_FILTERS)}>
                  Clear filters
                </Button>
              )}
            </div>

            {canWrite && selectedCerts.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-b border-line bg-brand-tint px-[18px] py-2.5">
                <span className="mr-2 font-semibold" aria-live="polite">
                  {plural(selectedCerts.length, "certificate")} selected
                </span>
                {matchingUnselected > 0 && pageSelected === pageRevocable.length && (
                  <Button variant="outline" size="sm" onClick={() => toggle(matchingRevocable.map((cert) => cert.id), true)}>
                    Select all {matchingRevocable.length.toLocaleString("en-US")} matching
                  </Button>
                )}
                <Button variant="danger" size="sm" onClick={() => setRevoking(selectedCerts)}>
                  Revoke
                </Button>
                <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSelected(new Set())}>
                  Clear selection
                </Button>
              </div>
            )}

            {filtered.length === 0 ? (
              <EmptyState
                compact
                icon={null}
                title="No client certificate matches these filters"
                action={
                  <Button variant="secondary" size="sm" onClick={() => onFiltersChange(NO_CLIENT_CERT_FILTERS)}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <>
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full min-w-[720px] border-collapse text-[13px]">
                    <thead>
                      <tr className="text-left text-xs text-soft">
                        {canWrite && (
                          <th scope="col" className="w-5 border-b border-line py-2 pl-[18px] pr-2">
                            <Checkbox
                              aria-label="Select every client certificate on this page"
                              disabled={pageRevocable.length === 0}
                              checked={
                                pageRevocable.length > 0 && pageSelected === pageRevocable.length
                                  ? true
                                  : pageSelected > 0
                                    ? "indeterminate"
                                    : false
                              }
                              onCheckedChange={(checked) => toggle(pageRevocable.map((cert) => cert.id), checked === true)}
                            />
                          </th>
                        )}
                        <SortHeader sortKey="name" sort={sort} onSort={sortBy} className={cn(!canWrite && "pl-[18px]")} />
                        <th scope="col" className={cn(PLAIN_HEADER, "hidden lg:table-cell")}>
                          Serial
                        </th>
                        <th scope="col" className={PLAIN_HEADER}>
                          Role
                        </th>
                        <SortHeader sortKey="ca" sort={sort} onSort={sortBy} />
                        <SortHeader sortKey="issued" sort={sort} onSort={sortBy} className="hidden xl:table-cell" />
                        <SortHeader sortKey="expires" sort={sort} onSort={sortBy} />
                        <th scope="col" className={PLAIN_HEADER}>
                          Status
                        </th>
                        {canWrite && (
                          <th scope="col" className={cn(PLAIN_HEADER, "pr-[18px]")}>
                            <span className="sr-only">Actions</span>
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {slice.items.map((cert) => {
                        const isSelected = selected.has(cert.id) && !cert.revokedAt;
                        return (
                          <tr
                            key={cert.id}
                            className={cn(
                              "border-b border-line whitespace-nowrap last:border-b-0 hover:bg-panel2",
                              isSelected && "bg-brand-tint hover:bg-brand-tint",
                              cert.revokedAt && "text-muted-foreground"
                            )}
                          >
                            {canWrite && <td className="w-5 py-2 pl-[18px] pr-2 align-middle">{checkbox(cert, "align-middle")}</td>}
                            <th
                              scope="row"
                              className={cn("max-w-[280px] px-2.5 py-2 text-left font-normal", !canWrite && "pl-[18px]")}
                            >
                              <span className={cn("num block truncate", !cert.revokedAt && "text-foreground")} title={cert.commonName}>
                                {cert.commonName}
                              </span>
                            </th>
                            <td className="hidden max-w-[160px] px-2.5 py-2 lg:table-cell">
                              <span className="num block truncate text-xs text-muted-foreground" title={`SHA-256 ${cert.fingerprintSha256}`}>
                                {cert.serialNumber}
                              </span>
                            </td>
                            <td className={cn("max-w-[200px] px-2.5 py-2", cert.roles.length === 0 && "text-soft")}>
                              <span className="block truncate" title={cert.roles.join(", ")}>
                                {cert.roles.length > 0 ? cert.roles.join(", ") : "–"}
                              </span>
                            </td>
                            <td className="max-w-[200px] px-2.5 py-2 text-muted-foreground">
                              <span className="block truncate">{cert.caName ?? "Unknown"}</span>
                            </td>
                            <td className="hidden px-2.5 py-2 text-muted-foreground xl:table-cell">{formatDate(cert.createdAt)}</td>
                            <td className="px-2.5 py-2">{formatDate(cert.validTo)}</td>
                            <td className="px-2.5 py-2">
                              <CertStatus cert={cert} now={now} />
                            </td>
                            {canWrite && <td className="py-1.5 pl-1.5 pr-[18px] text-right">{revokeButton(cert)}</td>}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <ul aria-label="Client certificates" className="m-0 flex list-none flex-col p-0 md:hidden">
                  {slice.items.map((cert) => (
                    <li
                      key={cert.id}
                      className={cn(
                        "flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0",
                        selected.has(cert.id) && !cert.revokedAt && "bg-brand-tint"
                      )}
                    >
                      {canWrite && checkbox(cert, "mt-0.5 shrink-0")}
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <span
                          className={cn(
                            "num font-semibold [overflow-wrap:anywhere]",
                            cert.revokedAt ? "text-muted-foreground" : "text-foreground"
                          )}
                        >
                          {cert.commonName}
                        </span>
                        <CertStatus cert={cert} now={now} />
                        <span className="truncate text-xs text-soft">
                          {[cert.caName ?? "Unknown CA", cert.roles.join(", ")].filter(Boolean).join(" · ")}
                        </span>
                        <span className="truncate text-xs text-soft">
                          Expires {formatDate(cert.validTo)} · <span className="num">{cert.serialNumber}</span>
                        </span>
                      </div>
                      <div className="shrink-0">{revokeButton(cert)}</div>
                    </li>
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
                  noun="client certificates"
                  label="Pages of client certificates"
                  onPageChange={setPage}
                />
              </div>
            )}
          </>
        )}
      </SectionCard>

      {revoking && (
        <RevokeDialog
          certs={revoking}
          onClose={() => setRevoking(null)}
          onRevoked={(ids) => toggle(ids, false)}
        />
      )}
    </div>
  );
}

function RevokeDialog({
  certs,
  onClose,
  onRevoked,
}: {
  certs: IssuedClientCertificateView[];
  onClose: () => void;
  /** Called with the certificates once they are revoked. */
  onRevoked: (ids: number[]) => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const single = certs.length === 1;

  function revoke() {
    setError(null);
    const ids = certs.map((cert) => cert.id);
    startTransition(async () => {
      try {
        if (single) {
          await revokeIssuedClientCertificateAction(ids[0]);
        } else {
          const result = await revokeIssuedClientCertificatesAction(ids);
          if (!result.ok) {
            // Some were revoked: show them as such, and say what failed.
            router.refresh();
            setError(result.message);
            return;
          }
          toast.success(result.message);
        }
        router.refresh();
        onRevoked(ids);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to revoke the certificate");
      }
    });
  }

  return (
    <AppDialog
      open
      onClose={() => {
        if (!isPending) onClose();
      }}
      title={single ? "Revoke client certificate" : `Revoke ${plural(certs.length, "client certificate")}`}
      maxWidth={single ? "sm" : "md"}
      actions={
        <>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={revoke} disabled={isPending}>
            {isPending ? "Revoking…" : single ? "Revoke certificate" : `Revoke ${plural(certs.length, "certificate")}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        {single ? (
          <p className="m-0 text-muted-foreground">
            Revoke <strong className="num text-foreground">{certs[0].commonName}</strong>? Proxy hosts stop accepting it at once.
            This cannot be undone; issue a new certificate to let the client back in.
          </p>
        ) : (
          <>
            <p className="m-0 text-muted-foreground">Proxy hosts stop accepting these certificates at once:</p>
            <ul className="m-0 flex max-h-48 list-none flex-col gap-1 overflow-y-auto rounded-lg border border-line bg-panel2 px-3 py-2">
              {certs.map((cert) => (
                <li key={cert.id} className="num [overflow-wrap:anywhere]">
                  {cert.commonName}
                  {cert.caName && <span className="ml-1.5 font-sans text-soft">{cert.caName}</span>}
                </li>
              ))}
            </ul>
            <p className="m-0 font-medium text-bad">This cannot be undone; issue new certificates to let the clients back in.</p>
          </>
        )}
        {error && <p className="m-0 text-bad">{error}</p>}
      </div>
    </AppDialog>
  );
}
