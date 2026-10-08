/**
 * The issued client certificate list: each certificate's status, the search,
 * the filters and the sort. Pure, so the list and its tests share it.
 */
import type { IssuedClientCertificateView } from "./page";
import {
  CLIENT_CERTIFICATE_SORT_KEYS,
  parseStoredSortPreference,
  type ClientCertificateSortKey,
  type ClientCertificatesSortPreference,
  type SortDirection as ListSortDirection,
} from "@/src/lib/list-sort-preferences";

const DAY_MS = 86_400_000;

/** Under this many days left, an active client certificate counts as expiring. */
export const EXPIRING_DAYS = 30;

/** A query matches serial numbers from this many characters, so a short name does not match every hex serial. */
const SERIAL_MIN_LENGTH = 4;

export type ClientCertStatus = "active" | "expiring" | "expired" | "revoked";
/** "active" includes the expiring ones. */
export type ClientCertStatusFilter = "all" | ClientCertStatus;
export const CLIENT_CERT_SORT_KEYS = CLIENT_CERTIFICATE_SORT_KEYS;
export type ClientCertSortKey = ClientCertificateSortKey;
export type SortDirection = ListSortDirection;
export type ClientCertSort = { key: ClientCertSortKey; dir: SortDirection };

export const DEFAULT_CLIENT_CERT_SORT: ClientCertSort = { key: "expires", dir: "asc" };

export function clientCertSortFromPreference(preference: ClientCertificatesSortPreference): ClientCertSort {
  return parseStoredSortPreference(preference) ?? DEFAULT_CLIENT_CERT_SORT;
}

/** The direction a column sorts in when it is picked. */
export const DEFAULT_SORT_DIRECTION: Record<ClientCertSortKey, SortDirection> = {
  name: "asc",
  ca: "asc",
  issued: "desc",
  expires: "asc",
};

export const CLIENT_CERT_SORT_LABELS: Record<ClientCertSortKey, string> = {
  name: "Common name",
  ca: "Issued by",
  issued: "Issued",
  expires: "Expires",
};

export type ClientCertFilters = {
  query: string;
  /** Only the certificates this CA issued. */
  caId: number | null;
  status: ClientCertStatusFilter;
};

export const NO_CLIENT_CERT_FILTERS: ClientCertFilters = { query: "", caId: null, status: "all" };

type ListedCert = Pick<
  IssuedClientCertificateView,
  "id" | "commonName" | "serialNumber" | "caCertificateId" | "caName" | "roles" | "validTo" | "revokedAt" | "createdAt"
>;

export function clientCertStatus(cert: Pick<ListedCert, "validTo" | "revokedAt">, now: number): ClientCertStatus {
  if (cert.revokedAt) return "revoked";
  const left = Date.parse(cert.validTo) - now;
  if (left <= 0) return "expired";
  if (left < EXPIRING_DAYS * DAY_MS) return "expiring";
  return "active";
}

export function matchesStatus(status: ClientCertStatus, filter: ClientCertStatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return status === "active" || status === "expiring";
  return status === filter;
}

/** Common name, CA, role names, and the serial number (from four characters, colons and spaces ignored). */
export function matchesClientCertQuery(cert: ListedCert, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (cert.commonName.toLowerCase().includes(q)) return true;
  if (cert.caName?.toLowerCase().includes(q)) return true;
  if (cert.roles.some((role) => role.toLowerCase().includes(q))) return true;
  const serial = q.replace(/[\s:]/g, "");
  return serial.length >= SERIAL_MIN_LENGTH && cert.serialNumber.toLowerCase().replace(/[\s:]/g, "").includes(serial);
}

export function filterClientCerts<T extends ListedCert>(certs: readonly T[], filters: ClientCertFilters, now: number): T[] {
  return certs.filter(
    (cert) =>
      (filters.caId === null || cert.caCertificateId === filters.caId) &&
      matchesStatus(clientCertStatus(cert, now), filters.status) &&
      matchesClientCertQuery(cert, filters.query)
  );
}

/** How many certificates each status filter shows, after the search and the CA filter. */
export function clientCertStatusCounts(
  certs: readonly ListedCert[],
  filters: Omit<ClientCertFilters, "status">,
  now: number
): Record<ClientCertStatusFilter, number> {
  const counts: Record<ClientCertStatusFilter, number> = { all: 0, active: 0, expiring: 0, expired: 0, revoked: 0 };
  for (const cert of certs) {
    if (filters.caId !== null && cert.caCertificateId !== filters.caId) continue;
    if (!matchesClientCertQuery(cert, filters.query)) continue;
    const status = clientCertStatus(cert, now);
    counts.all++;
    counts[status]++;
    if (status === "expiring") counts.active++;
  }
  return counts;
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * Sorted by the column, then by common name. By expiry, revoked certificates
 * come last whichever the direction.
 */
export function sortClientCerts<T extends ListedCert>(certs: readonly T[], sort: ClientCertSort): T[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const byName = (a: T, b: T) => collator.compare(a.commonName, b.commonName) || a.id - b.id;
  const primary = (a: T, b: T): number => {
    switch (sort.key) {
      case "name":
        return collator.compare(a.commonName, b.commonName);
      case "ca":
        return collator.compare(a.caName ?? "", b.caName ?? "");
      case "issued":
        return Date.parse(a.createdAt) - Date.parse(b.createdAt);
      case "expires":
        return Date.parse(a.validTo) - Date.parse(b.validTo);
    }
  };
  return [...certs].sort((a, b) => {
    if (sort.key === "expires") {
      const revoked = Number(Boolean(a.revokedAt)) - Number(Boolean(b.revokedAt));
      if (revoked !== 0) return revoked;
    }
    return sign * primary(a, b) || byName(a, b);
  });
}
