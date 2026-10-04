"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/src/lib/auth";
import { actionError, actionSuccess, INITIAL_ACTION_STATE, type ActionState } from "@/src/lib/actions";
import {
  createProxyHost,
  deleteProxyHost,
  updateProxyHost,
  type ProxyHostAuthentikInput,
  type ProxyHostForwardAuthInput,
  type LoadBalancerInput,
  type LoadBalancingPolicy,
  type DnsResolverInput,
  type UpstreamDnsResolutionInput,
  type GeoBlockMode,
  type WafHostConfig,
  type MtlsConfig,
  type RedirectRule,
  type RewriteConfig,
  type PathAllowRule,
  type PathBlockRule,
  type PathRewriteRule,
  type ErrorPageRule,
  type CpmForwardAuthInput,
  PATH_BLOCK_STATUS_CODES,
  sanitizeErrorPageRules
} from "@/src/lib/models/proxy-hosts";
import { parseBodyLimitMib } from "@/src/lib/caddy-waf";
import { getCertificate } from "@/src/lib/models/certificates";
import { setForwardAuthAccess } from "@/src/lib/models/forward-auth";
import { getCloudflareSettings, type GeoBlockSettings } from "@/src/lib/settings";
import {
  parseCsv,
  parseUpstreams,
  parseCheckbox,
  parseOptionalText,
  parseCertificateId,
  parseAccessListId,
  parseOptionalNumber,
} from "@/src/lib/form-parse";

async function validateAndSanitizeCertificateId(
  certificateId: number | null,
  cloudflareConfigured: boolean
): Promise<{ certificateId: number | null; warning?: string }> {
  // null is valid (Caddy Auto)
  if (certificateId === null) {
    return { certificateId: null };
  }

  // Check if certificate exists
  const certificate = await getCertificate(certificateId);

  if (!certificate) {
    // Build helpful warning message
    let warning: string;

    if (!cloudflareConfigured) {
      warning = `Certificate ID ${certificateId} not found. Automatically using 'Managed by Caddy (Auto)'. Note: Without Cloudflare DNS integration, wildcard certificates require port 80 to be accessible for HTTP-01 challenges. Configure Cloudflare in Settings to enable DNS-01 challenges.`;
    } else {
      warning = `Certificate ID ${certificateId} not found. Automatically using 'Managed by Caddy (Auto)' which will provision certificates automatically using Caddy.`;
    }

    return { certificateId: null, warning };
  }

  return { certificateId };
}

function parseAuthentikConfig(formData: FormData): ProxyHostAuthentikInput | undefined {
  if (!formData.has("authentikPresent")) {
    return undefined;
  }

  const enabledIndicator = formData.has("authentikEnabledPresent");
  const enabledValue = enabledIndicator
    ? formData.has("authentikEnabled")
      ? parseCheckbox(formData.get("authentikEnabled"))
      : false
    : undefined;
  const outpostDomain = parseOptionalText(formData.get("authentikOutpostDomain"));
  const outpostUpstream = parseOptionalText(formData.get("authentikOutpostUpstream"));
  const authEndpoint = parseOptionalText(formData.get("authentikAuthEndpoint"));
  const copyHeaders = parseCsv(formData.get("authentikCopyHeaders"));
  const trustedProxies = parseCsv(formData.get("authentikTrustedProxies"));
  const protectedPaths = parseCsv(formData.get("authentikProtectedPaths"));
  const excludedPaths = parseCsv(formData.get("authentikExcludedPaths"));
  const setHostHeader = formData.has("authentikSetHostHeaderPresent")
    ? parseCheckbox(formData.get("authentikSetHostHeader"))
    : undefined;

  const result: ProxyHostAuthentikInput = {};
  if (enabledValue !== undefined) {
    result.enabled = enabledValue;
  }
  if (outpostDomain !== null) {
    result.outpostDomain = outpostDomain;
  }
  if (outpostUpstream !== null) {
    result.outpostUpstream = outpostUpstream;
  }
  if (authEndpoint !== null) {
    result.authEndpoint = authEndpoint;
  }
  if (copyHeaders.length > 0 || formData.has("authentikCopyHeaders")) {
    result.copyHeaders = copyHeaders;
  }
  if (trustedProxies.length > 0 || formData.has("authentikTrustedProxies")) {
    result.trustedProxies = trustedProxies;
  }
  if (protectedPaths.length > 0 || formData.has("authentikProtectedPaths")) {
    result.protectedPaths = protectedPaths;
  }
  if (excludedPaths.length > 0 || formData.has("authentikExcludedPaths")) {
    result.excludedPaths = excludedPaths;
  }
  if (setHostHeader !== undefined) {
    result.setOutpostHostHeader = setHostHeader;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseCpmForwardAuthConfig(formData: FormData): CpmForwardAuthInput | undefined {
  if (!formData.has("cpmForwardAuthPresent")) {
    return undefined;
  }

  const enabledIndicator = formData.has("cpmForwardAuthEnabledPresent");
  const enabledValue = enabledIndicator
    ? formData.has("cpmForwardAuthEnabled")
      ? parseCheckbox(formData.get("cpmForwardAuthEnabled"))
      : false
    : undefined;
  const protectedPaths = parseCsv(formData.get("cpmForwardAuthProtectedPaths"));
  const excludedPaths = parseCsv(formData.get("cpmForwardAuthExcludedPaths"));

  const result: CpmForwardAuthInput = {};
  if (enabledValue !== undefined) {
    result.enabled = enabledValue;
  }
  if (protectedPaths.length > 0 || formData.has("cpmForwardAuthProtectedPaths")) {
    result.protected_paths = protectedPaths.length > 0 ? protectedPaths : null;
  }
  if (excludedPaths.length > 0 || formData.has("cpmForwardAuthExcludedPaths")) {
    result.excluded_paths = excludedPaths.length > 0 ? excludedPaths : null;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseForwardAuthConfig(formData: FormData): ProxyHostForwardAuthInput | undefined {
  if (!formData.has("forwardAuthPresent")) {
    return undefined;
  }

  const enabledIndicator = formData.has("forwardAuthEnabledPresent");
  const enabledValue = enabledIndicator
    ? formData.has("forwardAuthEnabled")
      ? parseCheckbox(formData.get("forwardAuthEnabled"))
      : false
    : undefined;
  const providerRaw = parseOptionalText(formData.get("forwardAuthProvider"));
  const provider =
    providerRaw === "authelia" || providerRaw === "custom" ? providerRaw : undefined;
  const authUpstream = parseOptionalText(formData.get("forwardAuthUpstream"));
  const authEndpoint = parseOptionalText(formData.get("forwardAuthEndpoint"));
  const copyHeaders = parseCsv(formData.get("forwardAuthCopyHeaders"));
  const trustedProxies = parseCsv(formData.get("forwardAuthTrustedProxies"));
  const apiSplit = formData.has("forwardAuthApiSplitPresent")
    ? parseCheckbox(formData.get("forwardAuthApiSplit"))
    : undefined;
  const apiBypassHeaders = parseCsv(formData.get("forwardAuthApiBypassHeaders"));
  const protectedPaths = parseCsv(formData.get("forwardAuthProtectedPaths"));
  const excludedPaths = parseCsv(formData.get("forwardAuthExcludedPaths"));

  const result: ProxyHostForwardAuthInput = {};
  if (enabledValue !== undefined) {
    result.enabled = enabledValue;
  }
  if (provider !== undefined) {
    result.provider = provider;
  }
  if (authUpstream !== null) {
    result.authUpstream = authUpstream;
  }
  if (authEndpoint !== null) {
    result.authEndpoint = authEndpoint;
  }
  if (copyHeaders.length > 0 || formData.has("forwardAuthCopyHeaders")) {
    result.copyHeaders = copyHeaders;
  }
  if (trustedProxies.length > 0 || formData.has("forwardAuthTrustedProxies")) {
    result.trustedProxies = trustedProxies;
  }
  if (apiSplit !== undefined) {
    result.apiSplit = apiSplit;
  }
  if (apiBypassHeaders.length > 0 || formData.has("forwardAuthApiBypassHeaders")) {
    result.apiBypassHeaders = apiBypassHeaders;
  }
  if (protectedPaths.length > 0 || formData.has("forwardAuthProtectedPaths")) {
    result.protectedPaths = protectedPaths;
  }
  if (excludedPaths.length > 0 || formData.has("forwardAuthExcludedPaths")) {
    result.excludedPaths = excludedPaths;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseRedirectUrl(raw: FormDataEntryValue | null): string {
  if (!raw || typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return trimmed;
  } catch {
    return "";
  }
}


const VALID_LB_POLICIES: LoadBalancingPolicy[] = ["random", "round_robin", "least_conn", "ip_hash", "first", "header", "cookie", "uri_hash"];
const VALID_UPSTREAM_DNS_FAMILIES = ["ipv6", "ipv4", "both"] as const;

function parseLoadBalancerConfig(formData: FormData): LoadBalancerInput | undefined {
  if (!formData.has("lbPresent")) {
    return undefined;
  }

  const enabledIndicator = formData.has("lbEnabledPresent");
  const enabledValue = enabledIndicator
    ? formData.has("lbEnabled")
      ? parseCheckbox(formData.get("lbEnabled"))
      : false
    : undefined;

  const policyRaw = parseOptionalText(formData.get("lbPolicy"));
  const policy = policyRaw && VALID_LB_POLICIES.includes(policyRaw as LoadBalancingPolicy)
    ? (policyRaw as LoadBalancingPolicy)
    : undefined;

  const policyHeaderField = parseOptionalText(formData.get("lbPolicyHeaderField"));
  const policyCookieName = parseOptionalText(formData.get("lbPolicyCookieName"));
  const policyCookieSecret = parseOptionalText(formData.get("lbPolicyCookieSecret"));
  const tryDuration = parseOptionalText(formData.get("lbTryDuration"));
  const tryInterval = parseOptionalText(formData.get("lbTryInterval"));
  const retries = parseOptionalNumber(formData.get("lbRetries"));

  // Active health check
  const activeHealthEnabled = formData.has("lbActiveHealthEnabledPresent")
    ? formData.has("lbActiveHealthEnabled")
      ? parseCheckbox(formData.get("lbActiveHealthEnabled"))
      : false
    : undefined;

  let activeHealthCheck: LoadBalancerInput["activeHealthCheck"] = undefined;
  if (activeHealthEnabled !== undefined || formData.has("lbActiveHealthUri")) {
    activeHealthCheck = {
      enabled: activeHealthEnabled,
      uri: parseOptionalText(formData.get("lbActiveHealthUri")),
      port: parseOptionalNumber(formData.get("lbActiveHealthPort")),
      interval: parseOptionalText(formData.get("lbActiveHealthInterval")),
      timeout: parseOptionalText(formData.get("lbActiveHealthTimeout")),
      status: parseOptionalNumber(formData.get("lbActiveHealthStatus")),
      body: parseOptionalText(formData.get("lbActiveHealthBody"))
    };
  }

  // Passive health check
  const passiveHealthEnabled = formData.has("lbPassiveHealthEnabledPresent")
    ? formData.has("lbPassiveHealthEnabled")
      ? parseCheckbox(formData.get("lbPassiveHealthEnabled"))
      : false
    : undefined;

  let passiveHealthCheck: LoadBalancerInput["passiveHealthCheck"] = undefined;
  if (passiveHealthEnabled !== undefined || formData.has("lbPassiveHealthFailDuration")) {
    // Parse unhealthy status codes from comma-separated input
    const unhealthyStatusRaw = parseOptionalText(formData.get("lbPassiveHealthUnhealthyStatus"));
    let unhealthyStatus: number[] | null = null;
    if (unhealthyStatusRaw) {
      unhealthyStatus = unhealthyStatusRaw
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n >= 100);
      if (unhealthyStatus.length === 0) {
        unhealthyStatus = null;
      }
    }

    passiveHealthCheck = {
      enabled: passiveHealthEnabled,
      failDuration: parseOptionalText(formData.get("lbPassiveHealthFailDuration")),
      maxFails: parseOptionalNumber(formData.get("lbPassiveHealthMaxFails")),
      unhealthyStatus,
      unhealthyLatency: parseOptionalText(formData.get("lbPassiveHealthUnhealthyLatency"))
    };
  }

  const result: LoadBalancerInput = {};
  if (enabledValue !== undefined) {
    result.enabled = enabledValue;
  }
  if (policy !== undefined) {
    result.policy = policy;
  }
  if (policyHeaderField !== null) {
    result.policyHeaderField = policyHeaderField;
  }
  if (policyCookieName !== null) {
    result.policyCookieName = policyCookieName;
  }
  if (policyCookieSecret !== null) {
    result.policyCookieSecret = policyCookieSecret;
  }
  if (tryDuration !== null) {
    result.tryDuration = tryDuration;
  }
  if (tryInterval !== null) {
    result.tryInterval = tryInterval;
  }
  if (retries !== null) {
    result.retries = retries;
  }
  if (activeHealthCheck !== undefined) {
    result.activeHealthCheck = activeHealthCheck;
  }
  if (passiveHealthCheck !== undefined) {
    result.passiveHealthCheck = passiveHealthCheck;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseGeoBlockConfig(formData: FormData): {
  geoblock: GeoBlockSettings | null;
  geoblockMode: GeoBlockMode;
} {
  if (!formData.has("geoblockPresent")) {
    return { geoblock: null, geoblockMode: "merge" };
  }

  const enabled = parseCheckbox(formData.get("geoblockEnabled"));
  const rawMode = formData.get("geoblockMode");
  const mode: GeoBlockMode = rawMode === "override" ? "override" : "merge";

  // Helper to parse a comma-separated string field into a string array
  const parseStringList = (key: string): string[] => {
    const val = formData.get(key);
    if (!val || typeof val !== "string") return [];
    return val.split(",").map(s => s.trim()).filter(Boolean);
  };

  // Helper to parse a comma-separated string field into a number array
  const parseNumberList = (key: string): number[] => {
    return parseStringList(key)
      .map(s => parseInt(s, 10))
      .filter(n => !isNaN(n));
  };

  const config: GeoBlockSettings = {
    enabled,
    block_countries: parseStringList("geoblockBlockCountries"),
    block_continents: parseStringList("geoblockBlockContinents"),
    block_asns: parseNumberList("geoblockBlockAsns"),
    block_cidrs: parseStringList("geoblockBlockCidrs"),
    block_ips: parseStringList("geoblockBlockIps"),
    allow_countries: parseStringList("geoblockAllowCountries"),
    allow_continents: parseStringList("geoblockAllowContinents"),
    allow_asns: parseNumberList("geoblockAllowAsns"),
    allow_cidrs: parseStringList("geoblockAllowCidrs"),
    allow_ips: parseStringList("geoblockAllowIps"),
    trusted_proxies: parseStringList("geoblockTrustedProxies"),
    fail_closed: formData.get("geoblockFailClosed") === "on",
    response_status: (() => {
      const s = parseOptionalNumber(formData.get("geoblockResponseStatus")) ?? 403;
      return s >= 100 && s <= 599 ? s : 403;
    })(),
    response_body: parseOptionalText(formData.get("geoblockResponseBody")) ?? "Forbidden",
    response_headers: parseResponseHeaders(formData),
    redirect_url: parseRedirectUrl(formData.get("geoblockRedirectUrl")),
  };

  return { geoblock: config, geoblockMode: mode };
}

// Helper: parse response headers from geoblock_response_headers_keys[] and geoblock_response_headers_values[]
function parseResponseHeaders(formData: FormData): Record<string, string> {
  const keys = formData.getAll("geoblockResponseHeadersKeys[]") as string[];
  const values = formData.getAll("geoblockResponseHeadersValues[]") as string[];
  const headers: Record<string, string> = {};
  keys.forEach((key, i) => {
    const trimmed = key.trim();
    if (trimmed && /^[a-zA-Z0-9\-_]+$/.test(trimmed)) {
      headers[trimmed] = (values[i] ?? "").trim();
    }
  });
  return headers;
}

function parseWafConfig(formData: FormData): { waf?: WafHostConfig | null } {
  if (!formData.has("wafPresent")) return {};
  const enabled = parseCheckbox(formData.get("wafEnabled"));
  const rawMode = formData.get("wafMode");
  const wafMode: WafHostConfig["waf_mode"] = rawMode === "override" ? "override" : "merge";
  const rawEngineMode = formData.get("wafEngineMode");
  const engineMode: WafHostConfig["mode"] =
    rawEngineMode === "On" ? "On" : rawEngineMode === "Off" ? "Off" : undefined;
  const loadCrs = parseCheckbox(formData.get("wafLoadOwaspCrs"));
  const customDirectives = typeof formData.get("wafCustomDirectives") === "string"
    ? (formData.get("wafCustomDirectives") as string).trim()
    : "";
  const rawExcl = formData.get("wafExcludedRuleIds");
  const excluded_rule_ids: number[] = rawExcl
    ? (JSON.parse(rawExcl as string) as unknown[]).filter((x): x is number => Number.isInteger(x) && (x as number) > 0)
    : [];

  if (!enabled) {
    return { waf: { enabled: false, waf_mode: wafMode } };
  }

  // Blank means "inherit" — the global body limits (or Coraza's own defaults)
  // apply. createProxyHost/updateProxyHost re-validate the resulting config.
  const requestBodyLimit = parseBodyLimitMib(formData.get("wafRequestBodyLimitMb"), "WAF request body limit");
  const requestBodyInMemoryLimit = parseBodyLimitMib(formData.get("wafRequestBodyInMemoryLimitMb"), "WAF in-memory body limit");
  const rawLimitAction = formData.get("wafRequestBodyLimitAction");
  const requestBodyLimitAction =
    rawLimitAction === "Reject" || rawLimitAction === "ProcessPartial" ? rawLimitAction : undefined;

  return {
    waf: {
      enabled: true,
      mode: engineMode,
      load_owasp_crs: loadCrs,
      custom_directives: customDirectives,
      excluded_rule_ids,
      waf_mode: wafMode,
      ...(requestBodyLimit !== undefined ? { request_body_limit: requestBodyLimit } : {}),
      ...(requestBodyInMemoryLimit !== undefined ? { request_body_in_memory_limit: requestBodyInMemoryLimit } : {}),
      ...(requestBodyLimitAction ? { request_body_limit_action: requestBodyLimitAction } : {}),
    }
  };
}

function parseDnsResolverConfig(formData: FormData): DnsResolverInput | undefined {
  if (!formData.has("dnsPresent")) {
    return undefined;
  }

  const enabledIndicator = formData.has("dnsEnabledPresent");
  const enabledValue = enabledIndicator
    ? formData.has("dnsEnabled")
      ? parseCheckbox(formData.get("dnsEnabled"))
      : false
    : undefined;

  // Parse resolvers from newline-separated input
  const resolversRaw = parseOptionalText(formData.get("dnsResolvers"));
  let resolvers: string[] | undefined = undefined;
  if (resolversRaw || formData.has("dnsResolvers")) {
    resolvers = resolversRaw
      ? resolversRaw
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];
  }

  // Parse fallbacks from newline-separated input
  const fallbacksRaw = parseOptionalText(formData.get("dnsFallbacks"));
  let fallbacks: string[] | null = null;
  if (fallbacksRaw) {
    fallbacks = fallbacksRaw
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (fallbacks.length === 0) {
      fallbacks = null;
    }
  }

  const timeout = parseOptionalText(formData.get("dnsTimeout"));

  const result: DnsResolverInput = {};
  if (enabledValue !== undefined) {
    result.enabled = enabledValue;
  }
  if (resolvers !== undefined) {
    result.resolvers = resolvers;
  }
  if (fallbacks !== null) {
    result.fallbacks = fallbacks;
  }
  if (timeout !== null) {
    result.timeout = timeout;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseMtlsConfig(formData: FormData): MtlsConfig | null {
  if (!formData.has("mtlsPresent")) return null;
  const enabled = formData.get("mtlsEnabled") === "true";
  if (!enabled) return null;
  const certIds = formData.getAll("mtlsCertId").map(Number).filter(n => Number.isFinite(n) && n > 0);
  const roleIds = formData.getAll("mtlsRoleId").map(Number).filter(n => Number.isFinite(n) && n > 0);
  const protectedPaths = parseCsv(formData.get("mtlsProtectedPaths"));
  const excludedPaths = parseCsv(formData.get("mtlsExcludedPaths"));
  return {
    enabled,
    trusted_client_cert_ids: certIds,
    trusted_role_ids: roleIds,
    protected_paths: protectedPaths.length > 0 ? protectedPaths : null,
    excluded_paths: excludedPaths.length > 0 ? excludedPaths : null,
  };
}

function parseRedirectsConfig(formData: FormData): RedirectRule[] | null {
  const raw = formData.get("redirectsJson");
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (r) =>
        r &&
        typeof r.from === "string" &&
        typeof r.to === "string" &&
        [301, 302, 307, 308].includes(r.status)
    ) as RedirectRule[];
  } catch {
    return null;
  }
}

function parseLocationRulesConfig(formData: FormData): import("@/src/lib/models/proxy-hosts").LocationRuleInput[] | null {
  const raw = formData.get("locationRulesJson");
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseRewriteConfig(formData: FormData): RewriteConfig | null {
  const prefix = formData.get("rewritePathPrefix");
  if (!prefix || typeof prefix !== "string" || !prefix.trim()) return null;
  return { path_prefix: prefix.trim() };
}

function parsePathAllowsConfig(formData: FormData): PathAllowRule[] | null {
  const raw = formData.get("pathAllowsJson");
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (r) => r && typeof r.path === "string" && r.path.trim()
    ) as PathAllowRule[];
  } catch {
    return null;
  }
}

function parsePathBlocksConfig(formData: FormData): PathBlockRule[] | null {
  const raw = formData.get("pathBlocksJson");
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const valid = (PATH_BLOCK_STATUS_CODES as readonly number[]);
    return parsed.filter(
      (r) =>
        r &&
        typeof r.path === "string" &&
        typeof r.status === "number" &&
        valid.includes(r.status)
    ) as PathBlockRule[];
  } catch {
    return null;
  }
}

function parsePathRewritesConfig(formData: FormData): PathRewriteRule[] | null {
  const raw = formData.get("pathRewritesJson");
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (r) => r && typeof r.from === "string" && typeof r.to === "string"
    ) as PathRewriteRule[];
  } catch {
    return null;
  }
}

function parseErrorPagesConfig(formData: FormData): ErrorPageRule[] | null {
  const raw = formData.get("errorPagesJson");
  if (!raw || typeof raw !== "string") return null;
  try {
    return sanitizeErrorPageRules(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseUpstreamDnsResolutionConfig(formData: FormData): UpstreamDnsResolutionInput | undefined {
  if (!formData.has("upstreamDnsResolutionPresent")) {
    return undefined;
  }

  const modeRaw = parseOptionalText(formData.get("upstreamDnsResolutionMode")) ?? "inherit";
  const familyRaw = parseOptionalText(formData.get("upstreamDnsResolutionFamily")) ?? "inherit";

  const result: UpstreamDnsResolutionInput = {};

  if (modeRaw === "enabled") {
    result.enabled = true;
  } else if (modeRaw === "disabled") {
    result.enabled = false;
  } else if (modeRaw === "inherit") {
    result.enabled = null;
  }

  if (familyRaw === "inherit") {
    result.family = null;
  } else if (VALID_UPSTREAM_DNS_FAMILIES.includes(familyRaw as typeof VALID_UPSTREAM_DNS_FAMILIES[number])) {
    result.family = familyRaw as "ipv6" | "ipv4" | "both";
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export async function createProxyHostAction(
  _prevState: ActionState = INITIAL_ACTION_STATE,
  formData: FormData
): Promise<ActionState> {
  void _prevState;
  try {
    const session = await requireAdmin();
    const userId = Number(session.user.id);

    // Parse certificateId safely
    const parsedCertificateId = parseCertificateId(formData.get("certificateId"));

    // Validate certificate exists and get sanitized value
    const cloudflareSettings = await getCloudflareSettings();
    const cloudflareConfigured = !!(cloudflareSettings?.apiToken);

    const { certificateId, warning } = await validateAndSanitizeCertificateId(parsedCertificateId, cloudflareConfigured);

    // Log warning if certificate was auto-fallback
    if (warning) {
      console.warn(`[createProxyHostAction] ${warning}`);
    }

    const host = await createProxyHost(
      {
        name: String(formData.get("name") ?? "Untitled"),
        domains: parseCsv(formData.get("domains")),
        upstreams: parseUpstreams(formData.get("upstreams")),
        certificateId: certificateId,
        accessListId: parseAccessListId(formData.get("accessListId")),
        sslForced: formData.has("sslForcedPresent") ? parseCheckbox(formData.get("sslForced")) : undefined,
        hstsSubdomains: parseCheckbox(formData.get("hstsSubdomains")),
        skipHttpsHostnameValidation: parseCheckbox(formData.get("skipHttpsHostnameValidation")),
        enabled: parseCheckbox(formData.get("enabled")),
        customPreHandlersJson: parseOptionalText(formData.get("customPreHandlersJson")),
        customReverseProxyJson: parseOptionalText(formData.get("customReverseProxyJson")),
        authentik: parseAuthentikConfig(formData),
        cpmForwardAuth: parseCpmForwardAuthConfig(formData),
        forwardAuth: parseForwardAuthConfig(formData),
        loadBalancer: parseLoadBalancerConfig(formData),
        dnsResolver: parseDnsResolverConfig(formData),
        upstreamDnsResolution: parseUpstreamDnsResolutionConfig(formData),
        ...parseGeoBlockConfig(formData),
        ...parseWafConfig(formData),
        mtls: parseMtlsConfig(formData),
        redirects: parseRedirectsConfig(formData),
        rewrite: parseRewriteConfig(formData),
        locationRules: parseLocationRulesConfig(formData),
        pathAllows: parsePathAllowsConfig(formData),
        pathBlocks: parsePathBlocksConfig(formData),
        pathRewrites: parsePathRewritesConfig(formData),
        errorPages: parseErrorPagesConfig(formData),
      },
      userId
    );

    // Save forward auth access if CPM forward auth is enabled
    const faUserIds = formData.getAll("cpmFaUserId").map((v) => Number(v)).filter((n) => n > 0);
    const faGroupIds = formData.getAll("cpmFaGroupId").map((v) => Number(v)).filter((n) => n > 0);
    if (host.cpmForwardAuth?.enabled && (faUserIds.length > 0 || faGroupIds.length > 0)) {
      await setForwardAuthAccess(host.id, { userIds: faUserIds, groupIds: faGroupIds }, userId);
    }

    revalidatePath("/proxy-hosts");

    // Return success with warning if applicable
    if (warning) {
      return actionSuccess(`Proxy host created using Caddy Auto certificate management. ${warning}`);
    }
    return actionSuccess("Proxy host created and queued for Caddy reload.");
  } catch (error) {
    console.error("Failed to create proxy host:", error);
    return actionError(error, "Failed to create proxy host. Please check the logs for details.");
  }
}

export async function updateProxyHostAction(
  id: number,
  _prevState: ActionState = INITIAL_ACTION_STATE,
  formData: FormData
): Promise<ActionState> {
  void _prevState;
  try {
    const session = await requireAdmin();
    const userId = Number(session.user.id);
    const boolField = (key: string) => (formData.has(`${key}Present`) ? parseCheckbox(formData.get(key)) : undefined);

    // Parse and validate certificate_id if present
    let certificateId: number | null | undefined = undefined;
    let warning: string | undefined;

    if (formData.has("certificateId")) {
      const parsedCertificateId = parseCertificateId(formData.get("certificateId"));

      // Validate certificate exists and get sanitized value
      const cloudflareSettings = await getCloudflareSettings();
      const cloudflareConfigured = !!(cloudflareSettings?.apiToken);

      const validation = await validateAndSanitizeCertificateId(parsedCertificateId, cloudflareConfigured);
      certificateId = validation.certificateId;
      warning = validation.warning;

      // Log warning if certificate was auto-fallback
      if (warning) {
        console.warn(`[updateProxyHostAction] ${warning}`);
      }
    }

    await updateProxyHost(
      id,
      {
        name: formData.get("name") ? String(formData.get("name")) : undefined,
        domains: formData.get("domains") ? parseCsv(formData.get("domains")) : undefined,
        upstreams: formData.get("upstreams") ? parseUpstreams(formData.get("upstreams")) : undefined,
        certificateId: certificateId,
        accessListId: formData.has("accessListId")
          ? parseAccessListId(formData.get("accessListId"))
          : undefined,
        sslForced: boolField("sslForced"),
        hstsSubdomains: boolField("hstsSubdomains"),
        skipHttpsHostnameValidation: boolField("skipHttpsHostnameValidation"),
        enabled: boolField("enabled"),
        customPreHandlersJson: formData.has("customPreHandlersJson")
          ? parseOptionalText(formData.get("customPreHandlersJson"))
          : undefined,
        customReverseProxyJson: formData.has("customReverseProxyJson")
          ? parseOptionalText(formData.get("customReverseProxyJson"))
          : undefined,
        authentik: parseAuthentikConfig(formData),
        cpmForwardAuth: parseCpmForwardAuthConfig(formData),
        forwardAuth: parseForwardAuthConfig(formData),
        loadBalancer: parseLoadBalancerConfig(formData),
        dnsResolver: parseDnsResolverConfig(formData),
        upstreamDnsResolution: parseUpstreamDnsResolutionConfig(formData),
        ...parseGeoBlockConfig(formData),
        ...parseWafConfig(formData),
        mtls: formData.has("mtlsPresent") ? parseMtlsConfig(formData) : undefined,
        redirects: formData.has("redirectsJson") ? parseRedirectsConfig(formData) : undefined,
        rewrite: formData.has("rewritePathPrefix") ? parseRewriteConfig(formData) : undefined,
        locationRules: formData.has("locationRulesJson") ? parseLocationRulesConfig(formData) : undefined,
        pathAllows: formData.has("pathAllowsJson") ? parsePathAllowsConfig(formData) : undefined,
        pathBlocks: formData.has("pathBlocksJson") ? parsePathBlocksConfig(formData) : undefined,
        pathRewrites: formData.has("pathRewritesJson") ? parsePathRewritesConfig(formData) : undefined,
        errorPages: formData.has("errorPagesJson") ? parseErrorPagesConfig(formData) : undefined,
      },
      userId
    );

    // Save forward auth access if the section is present in the form
    if (formData.has("cpmForwardAuthPresent")) {
      const faUserIds = formData.getAll("cpmFaUserId").map((v) => Number(v)).filter((n) => n > 0);
      const faGroupIds = formData.getAll("cpmFaGroupId").map((v) => Number(v)).filter((n) => n > 0);
      await setForwardAuthAccess(id, { userIds: faUserIds, groupIds: faGroupIds }, userId);
    }

    revalidatePath("/proxy-hosts");

    // Return success with warning if applicable
    if (warning) {
      return actionSuccess(`Proxy host updated using Caddy Auto certificate management. ${warning}`);
    }
    return actionSuccess("Proxy host updated.");
  } catch (error) {
    console.error(`Failed to update proxy host ${id}:`, error);
    return actionError(error, "Failed to update proxy host. Please check the logs for details.");
  }
}

export async function deleteProxyHostAction(
  id: number,
  _prevState: ActionState = INITIAL_ACTION_STATE
): Promise<ActionState> {
  void _prevState;
  try {
    const session = await requireAdmin();
    const userId = Number(session.user.id);
    await deleteProxyHost(id, userId);
    revalidatePath("/proxy-hosts");
    return actionSuccess("Proxy host deleted.");
  } catch (error) {
    console.error(`Failed to delete proxy host ${id}:`, error);
    return actionError(error, "Failed to delete proxy host. Please check the logs for details.");
  }
}

export async function toggleProxyHostAction(
  id: number,
  enabled: boolean
): Promise<ActionState> {
  try {
    const session = await requireAdmin();
    const userId = Number(session.user.id);
    await updateProxyHost(id, { enabled }, userId);
    revalidatePath("/proxy-hosts");
    return actionSuccess(`Proxy host ${enabled ? "enabled" : "disabled"}.`);
  } catch (error) {
    console.error(`Failed to toggle proxy host ${id}:`, error);
    return actionError(error, "Failed to toggle proxy host. Please check the logs for details.");
  }
}
