/**
 * The L4 hosts list: its query (search, filters, sort and page from the URL),
 * filtering, counting, sorting and paging, and the plain-language
 * descriptions of a host. Pure functions, shared by the server page and its
 * client.
 */
import type { L4ProxyHost } from "@/src/lib/models/l4-proxy-hosts";
import { paginate, parsePageParam, type PageSlice } from "@/src/lib/pagination";
import {
  L4_PROXY_HOST_SORT_KEYS,
  type L4ProxyHostSortKey,
  type SortDirection,
} from "@/src/lib/list-sort-preferences";

export type L4ProtocolFilter = "all" | "tcp" | "udp";
export type L4StatusFilter = "all" | "enabled" | "disabled";

export const L4_SORT_KEYS = L4_PROXY_HOST_SORT_KEYS;
export type L4SortKey = L4ProxyHostSortKey;
export type L4SortDir = SortDirection;

/** The direction a column sorts in when it is picked. */
export const L4_DEFAULT_SORT_DIR: Record<L4SortKey, L4SortDir> = {
  name: "asc",
  protocol: "asc",
  listenAddress: "asc",
  upstreams: "asc",
  enabled: "asc",
  createdAt: "desc",
};

/** The sort menu on narrow screens, where there are no column headings. */
export const L4_SORT_LABELS: Record<L4SortKey, string> = {
  createdAt: "Date added",
  name: "Name",
  listenAddress: "Port",
  protocol: "Protocol",
  upstreams: "Upstream",
  enabled: "Status",
};

export function isL4SortKey(value: string | undefined): value is L4SortKey {
  return (L4_SORT_KEYS as readonly string[]).includes(value ?? "");
}

export type L4ListQuery = {
  search: string;
  protocol: L4ProtocolFilter;
  status: L4StatusFilter;
  sortBy: L4SortKey;
  sortDir: L4SortDir;
  page: number;
};

type RawParams = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The list's state from the URL; anything unknown falls back to the default. */
export function parseL4ListQuery(
  params: RawParams,
  preferredSort: { key: L4SortKey; dir: L4SortDir } | null = null
): L4ListQuery {
  const search = (firstParam(params.search) ?? "").trim().slice(0, 200);
  const protocolParam = firstParam(params.protocol);
  const protocol: L4ProtocolFilter = protocolParam === "tcp" || protocolParam === "udp" ? protocolParam : "all";
  const statusParam = firstParam(params.status);
  const status: L4StatusFilter = statusParam === "enabled" || statusParam === "disabled" ? statusParam : "all";
  const sortParam = firstParam(params.sortBy);
  const dirParam = firstParam(params.sortDir);
  const usePreference = sortParam === undefined && dirParam === undefined && preferredSort !== null;
  const sortBy: L4SortKey =
    isL4SortKey(sortParam) ? sortParam : usePreference && preferredSort ? preferredSort.key : "createdAt";
  const sortDir: L4SortDir =
    dirParam === "asc" || dirParam === "desc"
      ? dirParam
      : usePreference && preferredSort?.key === sortBy
        ? preferredSort.dir
        : L4_DEFAULT_SORT_DIR[sortBy];
  return { search, protocol, status, sortBy, sortDir, page: parsePageParam(params.page) };
}

/** Matches name, listen address, upstreams, server names (SNI or HTTP Host) and tags, case-insensitively. */
export function matchesL4Search(host: L4ProxyHost, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return [host.name, host.listenAddress, ...host.upstreams, ...host.matcherValue, ...host.tags].some((value) =>
    value.toLowerCase().includes(q)
  );
}

function matchesProtocol(host: L4ProxyHost, protocol: L4ProtocolFilter): boolean {
  return protocol === "all" || host.protocol === protocol;
}

function matchesStatus(host: L4ProxyHost, status: L4StatusFilter): boolean {
  return status === "all" || host.enabled === (status === "enabled");
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** The port of a listen address (":5432", "0.0.0.0:53", "[::]:853"), or null. */
export function listenPort(listenAddress: string): number | null {
  const match = listenAddress.trim().match(/:(\d+)$/);
  return match ? Number(match[1]) : null;
}

function compareBy(sortBy: L4SortKey, a: L4ProxyHost, b: L4ProxyHost): number {
  switch (sortBy) {
    case "name":
      return collator.compare(a.name, b.name);
    case "protocol":
      return collator.compare(a.protocol, b.protocol);
    case "listenAddress": {
      // By port first: ":25" before ":853" before "0.0.0.0:2222".
      const byPort = (listenPort(a.listenAddress) ?? Infinity) - (listenPort(b.listenAddress) ?? Infinity);
      return (Number.isNaN(byPort) ? 0 : byPort) || collator.compare(a.listenAddress, b.listenAddress);
    }
    case "upstreams":
      return collator.compare(a.upstreams.join(","), b.upstreams.join(","));
    case "enabled":
      // Ascending: enabled hosts first.
      return Number(b.enabled) - Number(a.enabled);
    case "createdAt":
    default:
      return collator.compare(a.createdAt, b.createdAt);
  }
}

/** Sorted by `sortBy`, then by name and id, so that every page is the same on every load. */
export function sortL4Hosts(hosts: readonly L4ProxyHost[], sortBy: L4SortKey, sortDir: L4SortDir): L4ProxyHost[] {
  const sign = sortDir === "asc" ? 1 : -1;
  return [...hosts].sort((a, b) => sign * (compareBy(sortBy, a, b) || collator.compare(a.name, b.name) || a.id - b.id));
}

export type L4ListView = {
  page: PageSlice<L4ProxyHost>;
  /** Hosts per protocol, after the search and the status filter. */
  protocolCounts: Record<L4ProtocolFilter, number>;
  /** Hosts per status, after the search and the protocol filter. */
  statusCounts: Record<L4StatusFilter, number>;
};

/** Filters, counts, sorts and pages the hosts the user may see. */
export function buildL4ListView(hosts: readonly L4ProxyHost[], query: L4ListQuery, perPage?: number): L4ListView {
  const searched = query.search ? hosts.filter((host) => matchesL4Search(host, query.search)) : [...hosts];
  const byStatus = searched.filter((host) => matchesStatus(host, query.status));
  const byProtocol = searched.filter((host) => matchesProtocol(host, query.protocol));
  const matching = byStatus.filter((host) => matchesProtocol(host, query.protocol));
  return {
    page: paginate(sortL4Hosts(matching, query.sortBy, query.sortDir), query.page, perPage),
    protocolCounts: {
      all: byStatus.length,
      tcp: byStatus.filter((host) => host.protocol === "tcp").length,
      udp: byStatus.filter((host) => host.protocol === "udp").length,
    },
    statusCounts: {
      all: byProtocol.length,
      enabled: byProtocol.filter((host) => host.enabled).length,
      disabled: byProtocol.filter((host) => !host.enabled).length,
    },
  };
}

/** The first server name a host matches (TLS SNI or HTTP Host) and how many more; null for other matchers. */
export function serverNameSummary(host: L4ProxyHost): { first: string; more: number } | null {
  if ((host.matcherType !== "tls_sni" && host.matcherType !== "http_host") || host.matcherValue.length === 0) return null;
  return { first: host.matcherValue[0], more: host.matcherValue.length - 1 };
}

export type L4DetailItem = { label: string; value: string; mono?: boolean };
export type L4DetailGroup = { title: string; items: L4DetailItem[] };

const POLICY_LABELS: Record<string, string> = {
  random: "Random",
  round_robin: "Round robin",
  least_conn: "Fewest connections",
  ip_hash: "Client IP hash",
  first: "First available",
};

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "TLS SNI: dns.example.com", "None, every connection". */
export function matcherText(host: L4ProxyHost): string {
  switch (host.matcherType) {
    case "tls_sni":
      return `TLS SNI: ${host.matcherValue.join(", ")}`;
    case "http_host":
      return `HTTP Host: ${host.matcherValue.join(", ")}`;
    case "proxy_protocol":
      return "PROXY protocol header";
    default:
      return host.protocol === "udp" ? "None, every datagram" : "None, every connection";
  }
}

function geoSummary(host: L4ProxyHost): string {
  const geo = host.geoblock;
  if (!geo?.enabled) {
    return geo && host.geoblockMode === "override" ? "Off for this host, global rules ignored" : "Global rules only";
  }
  const describe = (verb: string, entries: Array<[readonly (string | number)[], string, string]>) => {
    const values = entries.flatMap(([list]) => list.map(String));
    if (values.length === 0) return null;
    if (values.length <= 3) return `${verb} ${values.join(", ")}`;
    const counts = entries
      .filter(([list]) => list.length > 0)
      .map(([list, one, many]) => `${list.length} ${list.length === 1 ? one : many}`);
    return `${verb} ${joinList(counts)}`;
  };
  const block = describe("block", [
    [geo.block_countries, "country", "countries"],
    [geo.block_continents, "continent", "continents"],
    [geo.block_asns, "ASN", "ASNs"],
    [geo.block_cidrs, "range", "ranges"],
    [geo.block_ips, "address", "addresses"],
  ]);
  const allow = describe("allow", [
    [geo.allow_countries, "country", "countries"],
    [geo.allow_continents, "continent", "continents"],
    [geo.allow_asns, "ASN", "ASNs"],
    [geo.allow_cidrs, "range", "ranges"],
    [geo.allow_ips, "address", "addresses"],
  ]);
  const rules = [allow, block].filter(Boolean).join("; ") || "no rules yet";
  return host.geoblockMode === "override" ? `Own rules only: ${rules}` : `Own rules added to the global ones: ${rules}`;
}

function healthText(host: L4ProxyHost): string {
  const lb = host.loadBalancer;
  const parts: string[] = [];
  if (lb?.enabled && lb.activeHealthCheck?.enabled) {
    const port = lb.activeHealthCheck.port ? `port ${lb.activeHealthCheck.port}` : "the upstream port";
    parts.push(`Connect to ${port} every ${lb.activeHealthCheck.interval ?? "30s"}`);
  }
  if (lb?.enabled && lb.passiveHealthCheck?.enabled) {
    const fails = lb.passiveHealthCheck.maxFails ?? 1;
    parts.push(
      `skip an upstream after ${fails} failed ${fails === 1 ? "connection" : "connections"}${
        lb.passiveHealthCheck.failDuration ? ` for ${lb.passiveHealthCheck.failDuration}` : ""
      }`
    );
  }
  if (parts.length === 0) return "Off";
  const text = parts.join("; ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function loadBalancingText(host: L4ProxyHost): string {
  const lb = host.loadBalancer;
  if (lb?.enabled) {
    const policy = POLICY_LABELS[lb.policy] ?? lb.policy;
    return lb.tryDuration ? `${policy}, keeps trying for ${lb.tryDuration}` : policy;
  }
  return host.upstreams.length > 1 ? "Off, random upstream" : "Off, one upstream";
}

function dnsPinningText(host: L4ProxyHost): string {
  const pinning = host.upstreamDnsResolution;
  if (!pinning || pinning.enabled === null) return "Inherit global";
  if (!pinning.enabled) return "Off";
  const family = pinning.family === "ipv4" ? "IPv4" : pinning.family === "ipv6" ? "IPv6" : "IPv4 and IPv6";
  return `On, ${family}`;
}

function resolverText(host: L4ProxyHost): string {
  const resolver = host.dnsResolver;
  if (!resolver?.enabled || resolver.resolvers.length === 0) return "Global resolvers";
  return resolver.resolvers.join(", ");
}

/** The detail panel's groups, from the host's own settings. */
export function l4DetailGroups(host: L4ProxyHost): L4DetailGroup[] {
  const tls =
    host.protocol === "udp"
      ? "Not available for UDP"
      : host.tlsTermination
        ? host.matcherType === "tls_sni" && host.matcherValue.length > 0
          ? `On, certificate for ${host.matcherValue.join(", ")}`
          : "On, certificate for the client's server name"
        : "Off";
  return [
    {
      title: "Listening",
      items: [
        { label: "Protocol", value: host.protocol.toUpperCase() },
        { label: "Listen address", value: host.listenAddress, mono: true },
        { label: "Matcher", value: matcherText(host) },
      ],
    },
    {
      title: "Upstream",
      items: [
        { label: host.upstreams.length === 1 ? "Upstream" : "Upstreams", value: host.upstreams.join(", "), mono: true },
        { label: "Load balancing", value: loadBalancingText(host) },
        { label: "Health check", value: healthText(host) },
      ],
    },
    {
      title: "TLS and PROXY protocol",
      items: [
        { label: "TLS termination", value: tls },
        { label: "Accept inbound PROXY protocol", value: host.proxyProtocolReceive ? "On" : "Off" },
        { label: "Send PROXY protocol to upstream", value: host.proxyProtocolVersion ?? "None" },
      ],
    },
    {
      title: "Access and DNS",
      items: [
        { label: "Geo blocking", value: geoSummary(host) },
        { label: "Upstream DNS pinning", value: dnsPinningText(host) },
        { label: "DNS resolver", value: resolverText(host) },
        { label: "Tags", value: host.tags.length ? host.tags.join(", ") : "None" },
      ],
    },
  ];
}
