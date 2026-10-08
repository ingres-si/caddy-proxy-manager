// SPDX-License-Identifier: Elastic-2.0
/**
 * Rule evaluators: turn the current state of the system into findings.
 *
 * A finding is one subject that matches a rule right now (one expiring
 * certificate, one failing upstream, ...). Titles and messages are written
 * here; anything that came from requests or logs only appears in `facts`.
 * An evaluator that cannot tell (Caddy unreachable, ClickHouse not configured)
 * returns "skipped" so that firing alerts are not resolved by mistake.
 */
import { X509Certificate } from "node:crypto";
import { and, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import {
  accessReviewCampaigns,
  accessReviewItems,
  backupDestinations,
  caCertificates,
  certificates,
  changeRequests,
  fleetEnvironments,
  fleetInstances,
  fleetRollouts,
  instances,
  issuedClientCertificates,
  proxyHosts,
} from "@/src/lib/db/schema";
import { isAnalyticsEnabled, queryTopWafRulesWithHosts, queryWafEventStatsWithSearch } from "@/src/lib/clickhouse/client";
import { getCaddyApplyStatus } from "@/src/lib/caddy-apply-status";
import { getInstanceMode } from "@/src/lib/instance-sync";
import { sanitizeInstanceSyncError } from "@/src/lib/instance-sync-error";
import { parseUpstreamTarget } from "@/src/lib/caddy-utils";
import { isDomainCoveredByCert } from "@/src/lib/cert-domain-match";
import { getManagedCertificates, type ManagedCertificateReport, type ManagedCertificateStatus } from "@/src/lib/managed-certificates";
import { fetchCaddyUpstreams } from "@/src/lib/caddy-upstreams";
import { queryErrorBreakdown, queryHostErrorCounts, queryWafBlockedByHost } from "./traffic";
import type { StoredRule } from "./rules";
import type {
  BackupFailedParams,
  CertExpiringParams,
  ErrorRateParams,
  RuleScope,
  RuleType,
  Severity,
  UpstreamDownParams,
  WafSpikeParams,
} from "./types";
import { desc } from "@/src/lib/db/ops";

export type Finding = {
  /** Stable id of the subject within the rule, e.g. "certificate:3". */
  subjectKey: string;
  /** Stable description of the condition, used when it resolves, e.g. `Certificate "x" expiring`. */
  label: string;
  /** Current one-line summary. */
  title: string;
  message: string;
  severity: Severity;
  /** Structured, aggregated facts (for webhooks and AI explanations). */
  facts: Record<string, unknown>;
};

/**
 * "ok": the findings are everything that matches now; firing subjects not
 * among them resolve, except those named in `preserveKeys` or starting with
 * one of `preservePrefixes`: the evaluator could not tell about them this
 * time (e.g. Caddy's HTTPS port was unreachable while imported certificates
 * could still be checked), so they keep their state.
 */
export type Evaluation =
  | { status: "ok"; findings: Finding[]; preserveKeys?: string[]; preservePrefixes?: string[] }
  | { status: "skipped"; reason: string };

const ALL_HOSTS: RuleScope = { type: "all" };

type ScopedHost = { id: number; name: string; domains: string[]; upstreams: string[]; certificateId: number | null };

/** The enabled proxy hosts a scope names, or null for every host. */
async function scopedHosts(scope: RuleScope): Promise<ScopedHost[] | null> {
  if (scope.type === "all") return null;
  if (scope.proxyHostIds.length === 0) return [];
  const rows = await appDb
    .select({ id: proxyHosts.id, name: proxyHosts.name, domains: proxyHosts.domains, upstreams: proxyHosts.upstreams, certificateId: proxyHosts.certificateId })
    .from(proxyHosts)
    .where(and(inArray(proxyHosts.id, scope.proxyHostIds), eq(proxyHosts.enabled, true)))
    .orderBy(proxyHosts.id);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    domains: parseJsonArray(row.domains).map((domain) => domain.trim().toLowerCase()),
    upstreams: parseJsonArray(row.upstreams),
    certificateId: row.certificateId,
  }));
}

async function allEnabledHosts(): Promise<ScopedHost[]> {
  const rows = await appDb
    .select({ id: proxyHosts.id, name: proxyHosts.name, domains: proxyHosts.domains, upstreams: proxyHosts.upstreams, certificateId: proxyHosts.certificateId })
    .from(proxyHosts)
    .where(eq(proxyHosts.enabled, true))
    .orderBy(proxyHosts.id);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    domains: parseJsonArray(row.domains).map((domain) => domain.trim().toLowerCase()),
    upstreams: parseJsonArray(row.upstreams),
    certificateId: row.certificateId,
  }));
}

/** The proxy host a request Host header belongs to: an exact domain first, then a wildcard. */
export function matchRequestHost(requestHost: string, hosts: readonly ScopedHost[]): ScopedHost | null {
  const name = requestHost.toLowerCase().replace(/:\d+$/, "");
  return hosts.find((host) => host.domains.includes(name)) ?? hosts.find((host) => isDomainCoveredByCert(name, host.domains)) ?? null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LISTED = 10;

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function quote(value: string): string {
  return `"${value.replace(/\p{Cc}+/gu, " ").slice(0, 120)}"`;
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function pemValidTo(pem: string | null): Date | null {
  if (!pem) return null;
  try {
    const date = new Date(new X509Certificate(pem).validTo);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

function expiryPhrase(validTo: Date, now: Date): { text: string; daysLeft: number; expired: boolean } {
  const ms = validTo.getTime() - now.getTime();
  const daysLeft = Math.floor(ms / DAY_MS);
  if (ms <= 0) return { text: `expired on ${day(validTo)}`, daysLeft, expired: true };
  if (daysLeft === 0) return { text: `expires today (${validTo.toISOString().slice(0, 16).replace("T", " ")} UTC)`, daysLeft, expired: false };
  return { text: `expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"} (on ${day(validTo)})`, daysLeft, expired: false };
}

// ── cert_expiring ──────────────────────────────────────────────────────

export type CertExpiringDependencies = {
  managedCertificates: (options: { now: Date }) => Promise<ManagedCertificateReport>;
};

const defaultCertDependencies: CertExpiringDependencies = {
  managedCertificates: ({ now }) => getManagedCertificates({ now }),
};

/** A certificate Caddy issued less than this long ago may still be on its way. */
const NEW_HOST_GRACE_MS = 15 * 60 * 1000;

function managedFinding(status: ManagedCertificateStatus, params: CertExpiringParams, now: Date): Finding | null {
  const limit = now.getTime() + params.days * DAY_MS;
  const hosts = status.proxyHosts.map((host) => host.name).slice(0, MAX_LISTED);
  const usedBy = hosts.length ? `, used by ${hosts.map(quote).join(", ")}` : "";
  const subject = `Certificate for ${status.domain}`;
  const baseFacts = {
    certificateKind: "Certificate managed by Caddy",
    domain: status.domain,
    proxyHosts: hosts,
    issuer: status.issuer,
    expiresAt: status.validTo,
    daysLeft: status.daysLeft,
    renewsAt: status.renewsAt,
    state: status.state,
    thresholdDays: params.days,
    source: "TLS handshake with Caddy",
  };
  if (status.state === "missing") {
    return {
      subjectKey: `managed_certificate:${status.servername}`,
      label: `${subject} missing`,
      title: `Caddy has no certificate for ${status.domain}`,
      message:
        `Caddy answered the TLS handshake for ${status.domain}${usedBy} without a certificate: obtaining one has not worked yet. ` +
        "Check that the domain points at this server and ports 80 and 443 are reachable from the internet (or the DNS provider credentials, for DNS challenges), and Caddy's log.",
      severity: "critical",
      facts: baseFacts,
    };
  }
  if (status.state === "mismatch") {
    return {
      subjectKey: `managed_certificate:${status.servername}`,
      label: `${subject} does not match`,
      title: `Caddy serves a certificate that does not cover ${status.domain}`,
      message:
        `The certificate Caddy presents for ${status.domain}${usedBy} does not include that name, so browsers refuse it. ` +
        "Caddy has probably not obtained the right certificate yet; check its log.",
      severity: "warning",
      facts: baseFacts,
    };
  }
  if (!status.validTo || status.daysLeft === null) return null;
  const validTo = new Date(status.validTo);
  const phrase = expiryPhrase(validTo, now);
  const issuer = status.issuer ? ` from ${status.issuer}` : "";
  if (status.state === "renewal_overdue") {
    return {
      subjectKey: `managed_certificate:${status.servername}`,
      label: `Renewal of the certificate for ${status.domain} overdue`,
      title: `Renewal of the certificate for ${status.domain} is overdue: it ${phrase.text}`,
      message:
        `Caddy should have renewed the certificate${issuer} for ${status.domain}${usedBy} from ${status.renewsAt?.slice(0, 10)}, and it ${phrase.text}. ` +
        "The renewal is failing: check that the domain still points at this server and ports 80 and 443 are reachable (or the DNS provider credentials, for DNS challenges), and Caddy's log.",
      severity: phrase.daysLeft < 7 ? "critical" : "warning",
      facts: baseFacts,
    };
  }
  if (validTo.getTime() > limit) return null;
  return {
    subjectKey: `managed_certificate:${status.servername}`,
    label: `${subject} expiring`,
    title: `${subject} ${phrase.text}`,
    message:
      `The certificate${issuer} Caddy manages for ${status.domain}${usedBy} ${phrase.text}. ` +
      (phrase.expired
        ? "Caddy could not renew it; check its log."
        : status.state === "renewal_due"
          ? "Caddy is renewing it now; the alert resolves when the new certificate is in place."
          : `Caddy renews it once a third of its lifetime is left, from ${status.renewsAt?.slice(0, 10)}; the alert resolves when the new certificate is in place.`),
    severity: phrase.expired || phrase.daysLeft < 3 ? "critical" : "warning",
    facts: baseFacts,
  };
}

export async function evaluateCertExpiring(
  params: CertExpiringParams,
  now: Date,
  scope: RuleScope = ALL_HOSTS,
  deps: CertExpiringDependencies = defaultCertDependencies
): Promise<Evaluation> {
  const limit = now.getTime() + params.days * DAY_MS;
  const findings: Finding[] = [];
  const preserveKeys: string[] = [];
  const preservePrefixes: string[] = [];
  const inScope = await scopedHosts(scope);
  const scopedCertIds = inScope ? new Set(inScope.map((host) => host.certificateId).filter((id): id is number => id !== null)) : null;
  const scopedHostIds = inScope ? new Set(inScope.map((host) => host.id)) : null;
  const add = (input: { subjectKey: string; kind: string; name: string; domains: string[]; validTo: Date; advice: string }) => {
    if (input.validTo.getTime() > limit) return;
    const phrase = expiryPhrase(input.validTo, now);
    const subject = `${input.kind} ${quote(input.name)}`;
    const domains = input.domains.slice(0, MAX_LISTED);
    findings.push({
      subjectKey: input.subjectKey,
      label: `${subject} expiring`,
      title: `${subject} ${phrase.text}`,
      message:
        `The ${input.kind.toLowerCase()} ${quote(input.name)}` +
        (domains.length ? ` (${domains.join(", ")}${input.domains.length > domains.length ? ", …" : ""})` : "") +
        ` ${phrase.text}. ${input.advice}`,
      severity: phrase.expired || phrase.daysLeft < 3 ? "critical" : "warning",
      facts: {
        certificateKind: input.kind,
        name: input.name,
        domains,
        expiresAt: input.validTo.toISOString(),
        daysLeft: phrase.daysLeft,
        expired: phrase.expired,
        thresholdDays: params.days,
      },
    });
  };

  const imported = await appDb
    .select({ id: certificates.id, name: certificates.name, domainNames: certificates.domainNames, pem: certificates.certificatePem })
    .from(certificates)
    .where(and(eq(certificates.type, "imported"), isNotNull(certificates.certificatePem)))
    .orderBy(certificates.id);
  for (const cert of imported) {
    if (scopedCertIds && !scopedCertIds.has(cert.id)) continue;
    const validTo = pemValidTo(cert.pem);
    if (!validTo) continue;
    add({
      subjectKey: `certificate:${cert.id}`,
      kind: "Certificate",
      name: cert.name,
      domains: parseJsonArray(cert.domainNames),
      validTo,
      advice: "Import a renewed certificate on the Certificates page.",
    });
  }

  // CA and client certificates belong to no single host: only an unscoped rule covers them.
  const cas = inScope ? [] : await appDb.select({ id: caCertificates.id, name: caCertificates.name, pem: caCertificates.certificatePem }).from(caCertificates).orderBy(caCertificates.id);
  for (const ca of cas) {
    const validTo = pemValidTo(ca.pem);
    if (!validTo) continue;
    add({
      subjectKey: `ca_certificate:${ca.id}`,
      kind: "CA certificate",
      name: ca.name,
      domains: [],
      validTo,
      advice: "Client certificates it issued stop working when it expires; replace the CA and reissue them.",
    });
  }

  if (params.includeClientCertificates && !inScope) {
    const issued = await appDb
      .select({ id: issuedClientCertificates.id, commonName: issuedClientCertificates.commonName, validTo: issuedClientCertificates.validTo })
      .from(issuedClientCertificates)
      .where(isNull(issuedClientCertificates.revokedAt))
      .orderBy(issuedClientCertificates.id);
    for (const cert of issued) {
      const validTo = new Date(cert.validTo);
      if (Number.isNaN(validTo.getTime())) continue;
      add({
        subjectKey: `client_certificate:${cert.id}`,
        kind: "Client certificate",
        name: cert.commonName,
        domains: [],
        validTo,
        advice: "Issue a new client certificate and revoke this one.",
      });
    }
  }

  if (params.includeManagedCertificates) {
    let report: ManagedCertificateReport | null;
    try {
      report = await deps.managedCertificates({ now });
    } catch {
      report = null;
    }
    if (!report || !report.available) {
      // Caddy could not be asked: what was firing for its certificates stays as it is.
      preservePrefixes.push("managed_certificate:");
    } else {
      for (const status of report.certificates) {
        if (scopedHostIds && !status.proxyHosts.some((host) => scopedHostIds.has(host.id))) continue;
        const key = `managed_certificate:${status.servername}`;
        if (status.state === "error") {
          preserveKeys.push(key);
          continue;
        }
        if (status.state === "missing" && status.changedAt && now.getTime() - Date.parse(status.changedAt) < NEW_HOST_GRACE_MS) {
          // A host saved a moment ago: Caddy may still be obtaining its first certificate.
          preserveKeys.push(key);
          continue;
        }
        const finding = managedFinding(status, params, now);
        if (finding) findings.push(finding);
      }
    }
  }
  return { status: "ok", findings, preserveKeys, preservePrefixes };
}

// ── upstream_down ──────────────────────────────────────────────────────

async function proxyHostsByDial(): Promise<Map<string, string[]>> {
  const rows = await appDb.select({ name: proxyHosts.name, upstreams: proxyHosts.upstreams }).from(proxyHosts).orderBy(proxyHosts.id);
  const map = new Map<string, string[]>();
  for (const row of rows) {
    for (const upstream of parseJsonArray(row.upstreams)) {
      const dial = parseUpstreamTarget(upstream).dial;
      const names = map.get(dial) ?? [];
      if (!names.includes(row.name)) names.push(row.name);
      map.set(dial, names);
    }
  }
  return map;
}

export async function evaluateUpstreamDown(params: UpstreamDownParams, scope: RuleScope = ALL_HOSTS): Promise<Evaluation> {
  let upstreams;
  try {
    upstreams = await fetchCaddyUpstreams();
  } catch {
    return { status: "skipped", reason: "The Caddy admin API could not be reached" };
  }
  const inScope = await scopedHosts(scope);
  const scopedDials = inScope ? new Set(inScope.flatMap((host) => host.upstreams.map((upstream) => parseUpstreamTarget(upstream).dial))) : null;
  const failing = upstreams.filter((upstream) => upstream.fails >= params.minFails && (!scopedDials || scopedDials.has(upstream.address)));
  if (failing.length === 0) return { status: "ok", findings: [] };
  const hosts = await proxyHostsByDial();
  return {
    status: "ok",
    findings: failing.map((upstream) => {
      const usedBy = (hosts.get(upstream.address) ?? []).slice(0, MAX_LISTED);
      return {
        subjectKey: `upstream:${upstream.address}`,
        label: `Upstream ${upstream.address} failing`,
        title: `Upstream ${upstream.address} is failing (${upstream.fails} recent failure${upstream.fails === 1 ? "" : "s"})`,
        message:
          `Caddy counted ${upstream.fails} recent failed request${upstream.fails === 1 ? "" : "s"} to upstream ${upstream.address}` +
          (usedBy.length ? `, used by ${usedBy.map(quote).join(", ")}` : "") +
          ". Check that the service is running and reachable from Caddy.",
        severity: "critical" as const,
        facts: {
          upstream: upstream.address,
          recentFailures: upstream.fails,
          requestsInFlight: upstream.numRequests,
          minFails: params.minFails,
          proxyHosts: usedBy,
          source: "Caddy passive health checks (failures within fail_duration)",
        },
      };
    }),
  };
}

// ── waf_spike ──────────────────────────────────────────────────────────

export async function evaluateWafSpike(params: WafSpikeParams, now: Date, scope: RuleScope = ALL_HOSTS): Promise<Evaluation> {
  if (!isAnalyticsEnabled()) return { status: "skipped", reason: "ClickHouse analytics is not configured" };
  const to = Math.floor(now.getTime() / 1000);
  const from = to - params.windowMinutes * 60;
  const inScope = await scopedHosts(scope);
  let blocked: number;
  try {
    if (inScope) {
      const perHost = await queryWafBlockedByHost(from, to);
      blocked = perHost.filter((row) => matchRequestHost(row.host, inScope) !== null).reduce((sum, row) => sum + row.blocked, 0);
    } else {
      blocked = (await queryWafEventStatsWithSearch(undefined, from, to)).blocked;
    }
  } catch {
    return { status: "skipped", reason: "ClickHouse could not be queried" };
  }
  if (blocked < params.threshold) return { status: "ok", findings: [] };

  let topRules: { ruleId: number; count: number; message: string | null; hosts: { host: string; count: number }[] }[] = [];
  try {
    topRules = await queryTopWafRulesWithHosts(from, to, 5, inScope ? inScope.flatMap((host) => host.domains.filter((domain) => !domain.startsWith("*."))) : []);
  } catch {
    // The count is what the rule is about; the breakdown is optional.
  }
  return {
    status: "ok",
    findings: [
      {
        subjectKey: "waf",
        label: "WAF block spike",
        title: `WAF blocked ${blocked} requests in the last ${params.windowMinutes} minutes${inScope ? ` on ${inScope.length} chosen host${inScope.length === 1 ? "" : "s"}` : ""}`,
        message:
          `The WAF blocked ${blocked} requests in the last ${params.windowMinutes} minutes${inScope ? ` on the rule's ${inScope.length} chosen host${inScope.length === 1 ? "" : "s"}` : ""} ` +
          `(threshold ${params.threshold}). Review the WAF events page for the rules and hosts involved.`,
        severity: "warning",
        facts: {
          blockedRequests: blocked,
          threshold: params.threshold,
          windowMinutes: params.windowMinutes,
          topRules: topRules.map((rule) => ({
            ruleId: rule.ruleId,
            matchedEvents: rule.count,
            ruleMessage: rule.message ? rule.message.slice(0, 200) : null,
            topHosts: rule.hosts.slice(0, 3).map((host) => ({ host: host.host.slice(0, 253), events: host.count })),
          })),
        },
      },
    ],
  };
}

// ── error_rate ─────────────────────────────────────────────────────────

export type TrafficReader = {
  analyticsEnabled: () => boolean;
  hostErrorCounts: typeof queryHostErrorCounts;
  errorBreakdown: typeof queryErrorBreakdown;
};

const defaultTrafficReader: TrafficReader = {
  analyticsEnabled: isAnalyticsEnabled,
  hostErrorCounts: queryHostErrorCounts,
  errorBreakdown: queryErrorBreakdown,
};

/** Findings with a breakdown of their 5xx responses; the rest keep only their counts. */
const MAX_BREAKDOWNS = 10;

function percentText(value: number): string {
  return `${value < 1 ? value.toFixed(2) : value.toFixed(1)}%`;
}

function thresholdText(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

type HostTotals = { host: ScopedHost | null; requests: number; errors: number; requestHosts: string[] };

export async function evaluateErrorRate(
  params: ErrorRateParams,
  now: Date,
  scope: RuleScope = ALL_HOSTS,
  reader: TrafficReader = defaultTrafficReader
): Promise<Evaluation> {
  if (!reader.analyticsEnabled()) return { status: "skipped", reason: "ClickHouse analytics is not configured" };
  const to = Math.floor(now.getTime() / 1000);
  const from = to - params.windowMinutes * 60;
  let counts;
  try {
    counts = await reader.hostErrorCounts(from, to);
  } catch {
    return { status: "skipped", reason: "ClickHouse could not be queried" };
  }
  const hosts = (await scopedHosts(scope)) ?? (await allEnabledHosts());
  const totals = new Map<number, HostTotals>();
  for (const row of counts) {
    const host = matchRequestHost(row.host, hosts);
    if (!host) continue;
    const entry = totals.get(host.id) ?? { host, requests: 0, errors: 0, requestHosts: [] };
    entry.requests += row.requests;
    entry.errors += row.errors5xx;
    if (row.errors5xx > 0) entry.requestHosts.push(row.host);
    totals.set(host.id, entry);
  }
  const groups: { key: string; totals: HostTotals; label: string; named: string }[] = [];
  if (params.perHost) {
    for (const entry of totals.values()) {
      groups.push({ key: `proxy_host:${entry.host!.id}`, totals: entry, label: `proxy host ${quote(entry.host!.name)}`, named: quote(entry.host!.name) });
    }
  } else {
    const all: HostTotals = { host: null, requests: 0, errors: 0, requestHosts: [] };
    for (const entry of totals.values()) {
      all.requests += entry.requests;
      all.errors += entry.errors;
      all.requestHosts.push(...entry.requestHosts);
    }
    const what = scope.type === "all" ? "all proxy hosts" : `the rule's ${hosts.length} chosen proxy host${hosts.length === 1 ? "" : "s"}`;
    groups.push({ key: "hosts", totals: all, label: what, named: what });
  }

  const findings: Finding[] = [];
  for (const group of groups) {
    const { requests, errors } = group.totals;
    if (requests < params.minRequests || requests === 0) continue;
    const rate = (errors * 100) / requests;
    if (rate <= params.thresholdPercent) continue;
    let breakdown: Awaited<ReturnType<typeof queryErrorBreakdown>> = [];
    if (findings.length < MAX_BREAKDOWNS) {
      try {
        breakdown = await reader.errorBreakdown(from, to, [...new Set(group.totals.requestHosts)]);
      } catch {
        // The rate is what the rule is about; the breakdown is optional.
      }
    }
    const top = breakdown[0];
    const domains = group.totals.host ? group.totals.host.domains.slice(0, MAX_LISTED) : [];
    findings.push({
      subjectKey: group.key,
      label: `5xx rate on ${group.label} above ${thresholdText(params.thresholdPercent)}`,
      title: `5xx responses at ${percentText(rate)} on ${group.named} (${errors} of ${requests} requests in ${params.windowMinutes} minute${params.windowMinutes === 1 ? "" : "s"})`,
      message:
        `${errors} of ${requests} requests to ${group.label}${domains.length ? ` (${domains.join(", ")})` : ""} got a 5xx response in the last ` +
        `${params.windowMinutes} minute${params.windowMinutes === 1 ? "" : "s"}: ${percentText(rate)}, above the threshold of ${thresholdText(params.thresholdPercent)}.` +
        (top ? ` The most frequent was status ${top.status} (${top.count} response${top.count === 1 ? "" : "s"}).` : "") +
        " Check the host's upstream and the analytics for the paths involved.",
      severity: "critical",
      facts: {
        proxyHost: group.totals.host ? group.totals.host.name : null,
        domains,
        requests,
        errors5xx: errors,
        ratePercent: Math.round(rate * 100) / 100,
        thresholdPercent: params.thresholdPercent,
        minRequests: params.minRequests,
        windowMinutes: params.windowMinutes,
        topErrors: breakdown.map((item) => ({
          status: item.status,
          method: item.method,
          path: item.path,
          responses: item.count,
          firstAt: item.firstAt,
          lastAt: item.lastAt,
        })),
        source: "ClickHouse traffic analytics",
      },
    });
  }
  return { status: "ok", findings };
}

// ── instance_sync_failed ───────────────────────────────────────────────

export async function evaluateInstanceSyncFailed(): Promise<Evaluation> {
  if ((await getInstanceMode()) !== "master") return { status: "ok", findings: [] };
  const rows = await appDb
    .select({ id: instances.id, name: instances.name, lastSyncAt: instances.lastSyncAt, lastSyncError: instances.lastSyncError })
    .from(instances)
    .where(and(eq(instances.enabled, true), isNotNull(instances.lastSyncError)))
    .orderBy(instances.id);
  return {
    status: "ok",
    findings: rows.map((row) => {
      const error = sanitizeInstanceSyncError(row.lastSyncError) ?? "unknown error";
      return {
        subjectKey: `instance:${row.id}`,
        label: `Sync to instance ${quote(row.name)} failing`,
        title: `Sync to instance ${quote(row.name)} failed`,
        message: `The last configuration sync to instance ${quote(row.name)} failed: ${error}. The instance keeps its previous configuration until a sync succeeds.`,
        severity: "warning",
        facts: { instanceName: row.name, error, lastAttemptAt: row.lastSyncAt },
      };
    }),
  };
}

// ── caddy_apply_failed ─────────────────────────────────────────────────

export async function evaluateCaddyApplyFailed(): Promise<Evaluation> {
  const status = await getCaddyApplyStatus();
  if (!status || status.ok) return { status: "ok", findings: [] };
  return {
    status: "ok",
    findings: [
      {
        subjectKey: "caddy",
        label: "Caddy config apply failing",
        title: "Applying the configuration to Caddy failed",
        message:
          `The last attempt to apply the configuration to Caddy failed: ${status.message ?? status.code}. ` +
          "Caddy keeps serving its previous configuration, so recent changes are not live.",
        severity: "critical",
        facts: { code: status.code, reason: status.message, failedAt: status.at, consecutiveFailures: status.consecutiveFailures },
      },
    ],
  };
}

// ── backup_failed ──────────────────────────────────────────────────────

export async function evaluateBackupFailed(params: BackupFailedParams): Promise<Evaluation> {
  const rows = await appDb
    .select({
      id: backupDestinations.id,
      name: backupDestinations.name,
      lastRunAt: backupDestinations.lastRunAt,
      lastError: backupDestinations.lastError,
      lastSuccessAt: backupDestinations.lastSuccessAt,
      consecutiveFailures: backupDestinations.consecutiveFailures,
      nextRunAt: backupDestinations.nextRunAt,
    })
    .from(backupDestinations)
    .where(
      and(
        eq(backupDestinations.enabled, true),
        eq(backupDestinations.lastStatus, "failed"),
        gte(backupDestinations.consecutiveFailures, params.minFailures)
      )
    )
    .orderBy(backupDestinations.id);
  return {
    status: "ok",
    findings: rows.map((row) => {
      const failures = row.consecutiveFailures;
      const error = (row.lastError ?? "unknown error").replace(/\p{Cc}+/gu, " ").slice(0, 300);
      return {
        subjectKey: `backup_destination:${row.id}`,
        label: `Backups to ${quote(row.name)} failing`,
        title: `Backup to ${quote(row.name)} failed${failures > 1 ? ` ${failures} times in a row` : ""}`,
        message:
          `The last configuration backup to ${quote(row.name)} failed${row.lastRunAt ? ` at ${row.lastRunAt}` : ""}: ${error}. ` +
          (row.lastSuccessAt ? `The last successful backup was at ${row.lastSuccessAt}. ` : "No backup to it has succeeded yet. ") +
          "Check the destination on the History page; failed backups are retried with increasing delays.",
        severity: failures >= 3 ? "critical" : "warning",
        facts: {
          destinationName: row.name,
          error,
          consecutiveFailures: failures,
          lastAttemptAt: row.lastRunAt,
          lastSuccessAt: row.lastSuccessAt,
          nextAttemptAt: row.nextRunAt,
          minFailures: params.minFailures,
        },
      };
    }),
  };
}

// ── approval_pending ───────────────────────────────────────────────────

/**
 * One finding per change request waiting for approval (ee/approvals), so a
 * channel hears about each request once, when it is made; it resolves when
 * the request is approved, rejected, cancelled or expires. Facts name the
 * host and the requester's user id, never the requested values.
 */
export async function evaluateApprovalPending(now: Date): Promise<Evaluation> {
  const rows = await appDb
    .select({
      id: changeRequests.id,
      targetType: changeRequests.targetType,
      targetName: changeRequests.targetName,
      operation: changeRequests.operation,
      requestedBy: changeRequests.requestedBy,
      requiredApprovals: changeRequests.requiredApprovals,
      expiresAt: changeRequests.expiresAt,
      createdAt: changeRequests.createdAt,
    })
    .from(changeRequests)
    .where(eq(changeRequests.status, "pending"))
    .orderBy(changeRequests.id);
  return {
    status: "ok",
    findings: rows
      .filter((row) => Date.parse(row.expiresAt) > now.getTime())
      .map((row) => {
        const target = `${row.targetType === "l4_proxy_host" ? "L4 proxy host" : "proxy host"} ${quote(row.targetName)}`;
        const approvals = `${row.requiredApprovals} approval${row.requiredApprovals === 1 ? "" : "s"}`;
        return {
          subjectKey: `change_request:${row.id}`,
          label: `Change request #${row.id} awaiting approval`,
          title: `Change request #${row.id} awaits approval: ${row.operation} ${target}`,
          message:
            `A change to ${target} (${row.operation}) is waiting for ${approvals} from someone other than the requester. ` +
            `Review it on the Approvals page before it expires at ${row.expiresAt}.`,
          severity: "info" as const,
          facts: {
            changeRequestId: row.id,
            targetType: row.targetType,
            targetName: row.targetName,
            operation: row.operation,
            requestedByUserId: row.requestedBy,
            requiredApprovals: row.requiredApprovals,
            requestedAt: row.createdAt,
            expiresAt: row.expiresAt,
          },
        };
      }),
  };
}

// ── access_review_started / access_review_overdue ─────────────────────

type OpenReview = { id: number; name: string; dueAt: Date; pending: number; total: number; scheduleId: number | null };

async function openAccessReviews(): Promise<OpenReview[]> {
  const campaigns = await appDb
    .select({ id: accessReviewCampaigns.id, name: accessReviewCampaigns.name, dueAt: accessReviewCampaigns.dueAt, scheduleId: accessReviewCampaigns.scheduleId })
    .from(accessReviewCampaigns)
    .where(eq(accessReviewCampaigns.status, "open"))
    .orderBy(accessReviewCampaigns.id);
  const result: OpenReview[] = [];
  for (const campaign of campaigns) {
    const items = await appDb
      .select({ confirmedAt: accessReviewItems.confirmedAt, outcome: accessReviewItems.outcome })
      .from(accessReviewItems)
      .where(eq(accessReviewItems.campaignId, campaign.id));
    result.push({
      id: campaign.id,
      name: campaign.name,
      dueAt: new Date(campaign.dueAt),
      pending: items.filter((item) => item.confirmedAt === null && item.outcome === null).length,
      total: items.length,
      scheduleId: campaign.scheduleId,
    });
  }
  return result;
}

export async function evaluateAccessReviewStarted(): Promise<Evaluation> {
  const reviews = await openAccessReviews();
  return {
    status: "ok",
    findings: reviews.map((review) => ({
      subjectKey: `access_review:${review.id}`,
      label: `Access review ${quote(review.name)}`,
      title: `Access review ${quote(review.name)} started`,
      message:
        `The access review ${quote(review.name)} is open with ${review.total} item${review.total === 1 ? "" : "s"} to review, ` +
        `due on ${day(review.dueAt)}. Reviewers find their items under My reviews in the dashboard.`,
      severity: "info" as Severity,
      facts: { reviewName: review.name, items: review.total, pending: review.pending, dueAt: review.dueAt.toISOString(), scheduled: review.scheduleId !== null },
    })),
  };
}

export async function evaluateAccessReviewOverdue(now: Date): Promise<Evaluation> {
  const reviews = (await openAccessReviews()).filter((review) => review.pending > 0 && review.dueAt.getTime() < now.getTime());
  return {
    status: "ok",
    findings: reviews.map((review) => ({
      subjectKey: `access_review:${review.id}`,
      label: `Access review ${quote(review.name)} overdue`,
      title: `Access review ${quote(review.name)} is overdue`,
      message:
        `The access review ${quote(review.name)} was due on ${day(review.dueAt)} and ${review.pending} of ${review.total} ` +
        `item${review.total === 1 ? "" : "s"} still wait for a reviewer's confirmed decision.`,
      severity: "warning" as Severity,
      facts: { reviewName: review.name, pending: review.pending, items: review.total, dueAt: review.dueAt.toISOString() },
    })),
  };
}

// ── fleet_drift ────────────────────────────────────────────────────────

export async function evaluateFleetDrift(): Promise<Evaluation> {
  if ((await getInstanceMode()) !== "master") return { status: "ok", findings: [] };
  const rows = await appDb
    .select({
      id: instances.id,
      name: instances.name,
      environmentName: fleetEnvironments.name,
      detail: fleetInstances.driftDetail,
      since: fleetInstances.driftSince,
      checkedAt: fleetInstances.driftCheckedAt,
      reportedVersion: fleetInstances.reportedVersion,
      localChanges: fleetInstances.localChanges,
    })
    .from(fleetInstances)
    .innerJoin(instances, eq(instances.id, fleetInstances.instanceId))
    .leftJoin(fleetEnvironments, eq(fleetEnvironments.id, fleetInstances.environmentId))
    .where(and(eq(instances.enabled, true), eq(fleetInstances.driftStatus, "drifted")))
    .orderBy(instances.id);
  return {
    status: "ok",
    findings: rows.map((row) => {
      const where = row.environmentName ? ` in environment ${quote(row.environmentName)}` : "";
      return {
        subjectKey: `instance:${row.id}`,
        label: `Instance ${quote(row.name)} drifted`,
        title: `Instance ${quote(row.name)}${where} drifted from the configuration the master pushed`,
        message:
          `Instance ${quote(row.name)}${where} does not run the configuration the master last pushed to it` +
          `${row.detail ? `: ${row.detail}` : ""}. Re-sync it on the Fleet page to put it back.`,
        severity: "warning",
        facts: {
          instanceName: row.name,
          environment: row.environmentName,
          detail: row.detail,
          driftedSince: row.since,
          checkedAt: row.checkedAt,
          localChanges: row.localChanges,
          reportedVersion: row.reportedVersion,
        },
      };
    }),
  };
}

// ── fleet_rollout_failed ───────────────────────────────────────────────

export async function evaluateFleetRolloutFailed(): Promise<Evaluation> {
  if ((await getInstanceMode()) !== "master") return { status: "ok", findings: [] };
  const environments = await appDb.select({ id: fleetEnvironments.id, name: fleetEnvironments.name }).from(fleetEnvironments).orderBy(fleetEnvironments.id);
  const findings: Finding[] = [];
  for (const environment of environments) {
    const [latest] = await appDb
      .select()
      .from(fleetRollouts)
      .where(eq(fleetRollouts.environmentId, environment.id))
      .orderBy(desc(fleetRollouts.id))
      .limit(1);
    if (!latest || latest.status !== "failed") continue;
    const error = (latest.error ?? "unknown error").replace(/\p{Cc}+/gu, " ").slice(0, 300);
    findings.push({
      subjectKey: `rollout:${latest.id}`,
      label: `Rollout #${latest.id} to ${quote(environment.name)} failed`,
      title: `Rollout of revision #${latest.revisionId} to environment ${quote(environment.name)} failed`,
      message:
        `Rollout #${latest.id} of revision #${latest.revisionId} to environment ${quote(environment.name)} failed: ${error}. ` +
        "Instances it had not reached stay on the previous revision. Fix the cause and promote again, or roll back on the Fleet page.",
      severity: "critical",
      facts: {
        environment: environment.name,
        rolloutId: latest.id,
        revisionId: latest.revisionId,
        previousRevisionId: latest.fromRevisionId,
        kind: latest.kind,
        error,
        failedAt: latest.finishedAt,
      },
    });
  }
  return { status: "ok", findings };
}

export async function evaluateRule(rule: StoredRule, now: Date): Promise<Evaluation> {
  const type: RuleType = rule.type;
  const scope = rule.scope ?? ALL_HOSTS;
  switch (type) {
    case "cert_expiring":
      return evaluateCertExpiring(rule.params as CertExpiringParams, now, scope);
    case "upstream_down":
      return evaluateUpstreamDown(rule.params as UpstreamDownParams, scope);
    case "waf_spike":
      return evaluateWafSpike(rule.params as WafSpikeParams, now, scope);
    case "error_rate":
      return evaluateErrorRate(rule.params as ErrorRateParams, now, scope);
    case "instance_sync_failed":
      return evaluateInstanceSyncFailed();
    case "caddy_apply_failed":
      return evaluateCaddyApplyFailed();
    case "backup_failed":
      return evaluateBackupFailed(rule.params as BackupFailedParams);
    case "approval_pending":
      return evaluateApprovalPending(now);
    case "access_review_started":
      return evaluateAccessReviewStarted();
    case "access_review_overdue":
      return evaluateAccessReviewOverdue(now);
    case "fleet_drift":
      return evaluateFleetDrift();
    case "fleet_rollout_failed":
      return evaluateFleetRolloutFailed();
  }
}
