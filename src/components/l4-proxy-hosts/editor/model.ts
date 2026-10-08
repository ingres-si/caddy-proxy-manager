/**
 * The L4 host editor's form: the host as the fields hold it, built from a
 * saved host (or a copy, or nothing), checked before saving, compared with
 * the saved host to count unsaved changes per tab, and turned into the form
 * data the L4 host actions read (app/(dashboard)/l4-proxy-hosts/actions.ts).
 * Pure functions.
 */
import type { L4ProxyHost } from "@/src/lib/models/l4-proxy-hosts";
import { extractL4ListenPort, RESERVED_L4_PORTS } from "@/src/lib/l4-reserved-ports";

export type L4SectionId = "routing" | "load-balancing" | "security" | "advanced";

export const L4_SECTIONS: readonly L4SectionId[] = ["routing", "load-balancing", "security", "advanced"];

export const L4_SECTION_LABELS: Record<L4SectionId, string> = {
  routing: "Routing",
  "load-balancing": "Load balancing",
  security: "Security",
  advanced: "Advanced",
};

export function isL4SectionId(value: string): value is L4SectionId {
  return (L4_SECTIONS as readonly string[]).includes(value);
}

export const L4_LB_POLICIES = [
  { value: "random", label: "Random", description: "Any upstream, picked at random." },
  { value: "round_robin", label: "Round robin", description: "Each upstream in turn." },
  { value: "least_conn", label: "Least connections", description: "The upstream with the fewest open connections." },
  { value: "ip_hash", label: "Client IP hash", description: "The same client keeps reaching the same upstream." },
  { value: "first", label: "First available", description: "The first upstream that is up; the others stand by." },
] as const;

export type L4Policy = (typeof L4_LB_POLICIES)[number]["value"];

export type L4Form = {
  name: string;
  tags: string[];
  enabled: boolean;
  protocol: "tcp" | "udp";
  listenAddress: string;
  upstreams: string[];
  matcherType: "none" | "tls_sni" | "http_host" | "proxy_protocol";
  matcherValue: string[];
  tlsTermination: boolean;
  proxyProtocolReceive: boolean;
  proxyProtocolVersion: "" | "v1" | "v2";
  lb: {
    enabled: boolean;
    policy: L4Policy;
    tryDuration: string;
    tryInterval: string;
    active: { enabled: boolean; port: string; interval: string; timeout: string };
    passive: { enabled: boolean; failDuration: string; maxFails: string };
  };
  dns: { enabled: boolean; resolvers: string[]; fallbacks: string[]; timeout: string };
  pinning: { mode: "inherit" | "enabled" | "disabled"; family: "inherit" | "both" | "ipv4" | "ipv6" };
  geo: {
    enabled: boolean;
    mode: "merge" | "override";
    blockCountries: string[];
    blockContinents: string[];
    blockAsns: string[];
    blockCidrs: string[];
    blockIps: string[];
    allowCountries: string[];
    allowContinents: string[];
    allowAsns: string[];
    allowCidrs: string[];
    allowIps: string[];
  };
};

export function newL4Form(scopeTags: readonly string[] = []): L4Form {
  return {
    name: "",
    // A scoped role's host needs one of its tags.
    tags: scopeTags.slice(0, 1),
    enabled: true,
    protocol: "tcp",
    listenAddress: "",
    upstreams: [""],
    matcherType: "none",
    matcherValue: [],
    tlsTermination: false,
    proxyProtocolReceive: false,
    proxyProtocolVersion: "",
    lb: {
      enabled: false,
      policy: "random",
      tryDuration: "",
      tryInterval: "",
      active: { enabled: false, port: "", interval: "", timeout: "" },
      passive: { enabled: false, failDuration: "", maxFails: "" },
    },
    dns: { enabled: false, resolvers: [], fallbacks: [], timeout: "" },
    pinning: { mode: "inherit", family: "inherit" },
    geo: {
      enabled: false,
      mode: "merge",
      blockCountries: [],
      blockContinents: [],
      blockAsns: [],
      blockCidrs: [],
      blockIps: [],
      allowCountries: [],
      allowContinents: [],
      allowAsns: [],
      allowCidrs: [],
      allowIps: [],
    },
  };
}

const text = (value: string | number | null | undefined) => (value === null || value === undefined ? "" : String(value));

export function l4HostToForm(host: L4ProxyHost): L4Form {
  const lb = host.loadBalancer;
  const geo = host.geoblock;
  const pinning = host.upstreamDnsResolution;
  return {
    name: host.name,
    tags: [...host.tags],
    enabled: host.enabled,
    protocol: host.protocol,
    listenAddress: host.listenAddress,
    upstreams: host.upstreams.length > 0 ? [...host.upstreams] : [""],
    matcherType: host.matcherType,
    matcherValue: [...host.matcherValue],
    tlsTermination: host.protocol === "tcp" && host.tlsTermination,
    proxyProtocolReceive: host.proxyProtocolReceive,
    proxyProtocolVersion: host.proxyProtocolVersion ?? "",
    lb: {
      enabled: lb?.enabled ?? false,
      policy: (L4_LB_POLICIES.some((entry) => entry.value === lb?.policy) ? lb?.policy : "random") as L4Policy,
      tryDuration: text(lb?.tryDuration),
      tryInterval: text(lb?.tryInterval),
      active: {
        enabled: lb?.activeHealthCheck?.enabled ?? false,
        port: text(lb?.activeHealthCheck?.port),
        interval: text(lb?.activeHealthCheck?.interval),
        timeout: text(lb?.activeHealthCheck?.timeout),
      },
      passive: {
        enabled: lb?.passiveHealthCheck?.enabled ?? false,
        failDuration: text(lb?.passiveHealthCheck?.failDuration),
        maxFails: text(lb?.passiveHealthCheck?.maxFails),
      },
    },
    dns: {
      enabled: host.dnsResolver?.enabled ?? false,
      resolvers: [...(host.dnsResolver?.resolvers ?? [])],
      fallbacks: [...(host.dnsResolver?.fallbacks ?? [])],
      timeout: text(host.dnsResolver?.timeout),
    },
    pinning: {
      mode: pinning?.enabled === true ? "enabled" : pinning?.enabled === false ? "disabled" : "inherit",
      family: pinning?.family ?? "inherit",
    },
    geo: {
      enabled: geo?.enabled ?? false,
      mode: host.geoblockMode,
      blockCountries: [...(geo?.block_countries ?? [])],
      blockContinents: [...(geo?.block_continents ?? [])],
      blockAsns: (geo?.block_asns ?? []).map(String),
      blockCidrs: [...(geo?.block_cidrs ?? [])],
      blockIps: [...(geo?.block_ips ?? [])],
      allowCountries: [...(geo?.allow_countries ?? [])],
      allowContinents: [...(geo?.allow_continents ?? [])],
      allowAsns: (geo?.allow_asns ?? []).map(String),
      allowCidrs: [...(geo?.allow_cidrs ?? [])],
      allowIps: [...(geo?.allow_ips ?? [])],
    },
  };
}

/** A new host that starts as a copy of `host`; the role's tags only, for a scoped role. */
export function copyL4Form(host: L4ProxyHost, scopeTags: readonly string[] = []): L4Form {
  const form = l4HostToForm(host);
  form.name = `${host.name} (copy)`;
  if (scopeTags.length > 0) {
    const kept = form.tags.filter((tag) => scopeTags.includes(tag));
    form.tags = kept.length > 0 ? kept : scopeTags.slice(0, 1);
  }
  return form;
}

const filled = (values: readonly string[]) => values.map((value) => value.trim()).filter(Boolean);

export type L4FieldErrors = Record<string, { message: string; section: L4SectionId }>;

/**
 * Name and tags: in Routing for a new host (it needs a name first), in
 * Advanced for an existing one, as in the proxy host editor.
 */
export function nameSectionOf(creating: boolean): L4SectionId {
  return creating ? "routing" : "advanced";
}

/** Problems to fix before saving, by field id. */
export function validateL4Form(form: L4Form, nameSection: L4SectionId): L4FieldErrors {
  const errors: L4FieldErrors = {};
  if (!form.name.trim()) errors["l4-name"] = { message: "Give the host a name.", section: nameSection };
  const listen = form.listenAddress.trim();
  if (!listen) {
    errors["l4-listen"] = { message: "Enter the address to listen on, such as :5432.", section: "routing" };
  } else {
    const port = extractL4ListenPort(listen);
    if (port === null) errors["l4-listen"] = { message: "Use :PORT or HOST:PORT, with a port from 1 to 65535.", section: "routing" };
    else if ((RESERVED_L4_PORTS as readonly number[]).includes(port))
      errors["l4-listen"] = { message: `Port ${port} is Caddy's own (80, 443 and 2019 are reserved).`, section: "routing" };
  }
  const upstreams = filled(form.upstreams);
  if (upstreams.length === 0) errors["l4-up-0"] = { message: "Add at least one upstream.", section: "routing" };
  form.upstreams.forEach((upstream, index) => {
    const value = upstream.trim();
    if (value && !/:\d+$/.test(value)) errors[`l4-up-${index}`] = { message: "Use host:port, such as 10.0.0.5:5432.", section: "routing" };
  });
  if ((form.matcherType === "tls_sni" || form.matcherType === "http_host") && filled(form.matcherValue).length === 0) {
    errors["l4-matcher-value"] = { message: "Add at least one server name to match.", section: "routing" };
  }
  const numeric = (id: string, value: string, section: L4SectionId, what: string) => {
    if (value.trim() && !/^\d+$/.test(value.trim())) errors[id] = { message: `${what} is a whole number.`, section };
  };
  if (form.lb.enabled) {
    numeric("l4-lb-active-port", form.lb.active.port, "load-balancing", "The port");
    numeric("l4-lb-passive-max", form.lb.passive.maxFails, "load-balancing", "The number of failures");
  }
  for (const [id, values] of [
    ["l4-geo-block-asns", form.geo.blockAsns],
    ["l4-geo-allow-asns", form.geo.allowAsns],
  ] as const) {
    if (values.some((value) => !/^(AS)?\d+$/i.test(value.trim()))) errors[id] = { message: "ASNs are numbers, such as 13335.", section: "security" };
  }
  return errors;
}

/** One unsaved change: the tab it is in and what it is called. */
export type L4Change = { section: L4SectionId; label: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What differs between the saved host and the form, one entry per setting. */
export function l4FormChanges(saved: L4Form, form: L4Form, nameSection: L4SectionId): L4Change[] {
  const changes: L4Change[] = [];
  const check = (section: L4SectionId, label: string, a: unknown, b: unknown) => {
    if (!same(a, b)) changes.push({ section, label });
  };
  check(nameSection, "Name", saved.name.trim(), form.name.trim());
  check(nameSection, "Tags", [...saved.tags].sort(), [...form.tags].sort());
  check("routing", "Protocol", saved.protocol, form.protocol);
  check("routing", "Listen address", saved.listenAddress.trim(), form.listenAddress.trim());
  check("routing", "Upstreams", filled(saved.upstreams), filled(form.upstreams));
  check("routing", "Matcher", [saved.matcherType, filled(saved.matcherValue)], [form.matcherType, filled(form.matcherValue)]);
  check("routing", "TLS termination", saved.protocol === "tcp" && saved.tlsTermination, form.protocol === "tcp" && form.tlsTermination);
  check("routing", "Inbound PROXY protocol", saved.proxyProtocolReceive, form.proxyProtocolReceive);
  check("routing", "PROXY protocol to the upstream", saved.proxyProtocolVersion, form.proxyProtocolVersion);
  check("load-balancing", "Load balancing", [saved.lb.enabled, saved.lb.policy, saved.lb.tryDuration.trim(), saved.lb.tryInterval.trim()], [form.lb.enabled, form.lb.policy, form.lb.tryDuration.trim(), form.lb.tryInterval.trim()]);
  check("load-balancing", "Active health checks", saved.lb.active, form.lb.active);
  check("load-balancing", "Passive health checks", saved.lb.passive, form.lb.passive);
  check("security", "Geo blocking", saved.geo, form.geo);
  check("advanced", "DNS resolvers", [saved.dns.enabled, filled(saved.dns.resolvers), filled(saved.dns.fallbacks), saved.dns.timeout.trim()], [form.dns.enabled, filled(form.dns.resolvers), filled(form.dns.fallbacks), form.dns.timeout.trim()]);
  check("advanced", "Upstream DNS pinning", saved.pinning, form.pinning);
  return changes;
}

/**
 * The form as the L4 host actions read it (the fields of the former dialog).
 * `enabled: false` leaves the host's on/off state out (an existing host's is
 * switched from its page header).
 */
export function l4FormData(form: L4Form, options: { enabled: boolean } = { enabled: true }): FormData {
  const data = new FormData();
  const set = (key: string, value: string) => data.set(key, value);
  const on = (key: string, value: boolean) => {
    if (value) data.set(key, "on");
  };
  set("name", form.name.trim());
  set("tags", form.tags.join(", "));
  if (options.enabled) {
    set("enabledPresent", "1");
    on("enabled", form.enabled);
  }
  set("protocol", form.protocol);
  set("listenAddress", form.listenAddress.trim());
  set("upstreams", filled(form.upstreams).join("\n"));
  set("matcherType", form.matcherType);
  if (form.matcherType === "tls_sni" || form.matcherType === "http_host") set("matcherValue", filled(form.matcherValue).join(", "));
  on("tlsTermination", form.protocol === "tcp" && form.tlsTermination);
  on("proxyProtocolReceive", form.proxyProtocolReceive);
  if (form.proxyProtocolVersion) set("proxyProtocolVersion", form.proxyProtocolVersion);

  set("lbPresent", "1");
  set("lbEnabledPresent", "1");
  on("lbEnabled", form.lb.enabled);
  set("lbPolicy", form.lb.policy);
  set("lbTryDuration", form.lb.tryDuration.trim());
  set("lbTryInterval", form.lb.tryInterval.trim());
  set("lbActiveHealthEnabledPresent", "1");
  on("lbActiveHealthEnabled", form.lb.active.enabled);
  set("lbActiveHealthPort", form.lb.active.port.trim());
  set("lbActiveHealthInterval", form.lb.active.interval.trim());
  set("lbActiveHealthTimeout", form.lb.active.timeout.trim());
  set("lbPassiveHealthEnabledPresent", "1");
  on("lbPassiveHealthEnabled", form.lb.passive.enabled);
  set("lbPassiveHealthFailDuration", form.lb.passive.failDuration.trim());
  set("lbPassiveHealthMaxFails", form.lb.passive.maxFails.trim());

  set("dnsPresent", "1");
  set("dnsEnabledPresent", "1");
  on("dnsEnabled", form.dns.enabled);
  set("dnsResolvers", filled(form.dns.resolvers).join("\n"));
  set("dnsFallbacks", filled(form.dns.fallbacks).join("\n"));
  set("dnsTimeout", form.dns.timeout.trim());

  set("upstreamDnsResolutionPresent", "1");
  set("upstreamDnsResolutionMode", form.pinning.mode);
  set("upstreamDnsResolutionFamily", form.pinning.family);

  set("geoblockPresent", "1");
  on("geoblockEnabled", form.geo.enabled);
  set("geoblockMode", form.geo.mode);
  const list = (values: readonly string[]) => filled(values).join(", ");
  const asns = (values: readonly string[]) => filled(values).map((value) => value.replace(/^AS/i, "")).join(", ");
  set("geoblockBlockCountries", list(form.geo.blockCountries));
  set("geoblockBlockContinents", list(form.geo.blockContinents));
  set("geoblockBlockAsns", asns(form.geo.blockAsns));
  set("geoblockBlockCidrs", list(form.geo.blockCidrs));
  set("geoblockBlockIps", list(form.geo.blockIps));
  set("geoblockAllowCountries", list(form.geo.allowCountries));
  set("geoblockAllowContinents", list(form.geo.allowContinents));
  set("geoblockAllowAsns", asns(form.geo.allowAsns));
  set("geoblockAllowCidrs", list(form.geo.allowCidrs));
  set("geoblockAllowIps", list(form.geo.allowIps));
  return data;
}

/** The field a server error is about, so the editor can show it there; null when it is about none. */
export function l4FieldOfServerError(message: string, nameSection: L4SectionId): { id: string; section: L4SectionId } | null {
  if (/listen address|port \d+ is reserved|port must be|already (uses|listens)|port .* in use/i.test(message)) return { id: "l4-listen", section: "routing" };
  if (/upstream/i.test(message)) return { id: "l4-up-0", section: "routing" };
  if (/matcher value/i.test(message)) return { id: "l4-matcher-value", section: "routing" };
  if (/name is required/i.test(message)) return { id: "l4-name", section: nameSection };
  if (/tag/i.test(message)) return { id: "l4-tags", section: nameSection };
  return null;
}
