import { randomUUID } from "node:crypto";

export type CaddyApplyErrorCode =
  | "CADDY_REJECTED"
  | "CADDY_UNREACHABLE"
  | "CADDY_REQUEST_FAILED"
  | "INSTANCE_SYNC_FAILED";

export class CaddyApplyError extends Error {
  readonly code: CaddyApplyErrorCode;
  /** The proxy host a create stored before the apply failed (createProxyHost), so callers can say it was saved. */
  proxyHostId?: number;
  /** The L4 host a create stored before the apply failed (createL4ProxyHost). */
  l4ProxyHostId?: number;

  constructor(message: string, code: CaddyApplyErrorCode) {
    super(message);
    this.name = "CaddyApplyError";
    this.code = code;
  }
}

export function safeSystemErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_-]{1,64}$/.test(code)
    ? code
    : null;
}

/**
 * Caddy's /load error body quotes the config it choked on, so it is never
 * surfaced or logged verbatim. Matching it against known failure modes gives
 * back an application-authored explanation instead: enough to fix the config,
 * with nothing echoed out of it.
 *
 * Coraza builds its WAF during config load, so these validation errors reject
 * the entire document — without a reason the operator only sees every host
 * stop updating, with no hint as to which knob did it.
 */
const KNOWN_CADDY_REJECTIONS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /request body limit should be at most 1GiB/i,
    reason: "a WAF request body limit exceeds Coraza's maximum of 1 GiB",
  },
  {
    pattern: /request body limit should be at least the memory limit/i,
    reason: "a WAF in-memory body limit is larger than its request body limit",
  },
  {
    pattern: /body limit should be bigger than 0/i,
    reason: "a WAF body limit is zero",
  },
  {
    pattern: /unknown module: http\.handlers\.rate_limit/i,
    reason: "the Caddy image has no rate limit plugin; update it to the image of this release",
  },
  // Shared certificate storage (ee/high-availability): the redis module
  // connects and signs in while the configuration loads.
  {
    pattern: /loading storage module: .*(module not registered|unknown module)/i,
    reason: "this Caddy build has no Redis storage module; update the Caddy image",
  },
  {
    pattern: /loading storage module: .*(WRONGPASS|NOAUTH|invalid username-password|invalid password|AUTH <password>)/i,
    reason: "the certificate storage server did not accept the user name or password",
  },
  {
    pattern: /loading storage module: .*encryption_key/i,
    reason: "the certificate storage encryption key is missing or shorter than 32 bytes on this node (check its CADDY_STORAGE_* variables)",
  },
  {
    pattern: /loading storage module: .*(x509|tls:|certificate)/i,
    reason: "the TLS connection to the certificate storage server failed",
  },
  {
    pattern: /loading storage module: .*(no such host|connection refused|i\/o timeout|deadline exceeded|no route to host|network is unreachable|EOF)/i,
    reason: "Caddy could not reach the certificate storage server",
  },
  {
    pattern: /loading storage module:/i,
    reason: "Caddy could not set up the certificate storage",
  },
];

/** Known, safe-to-report explanation for a Caddy config rejection, if any. */
export function describeCaddyRejection(responseBody: string): string | null {
  return KNOWN_CADDY_REJECTIONS.find(({ pattern }) => pattern.test(responseBody))?.reason ?? null;
}

/** Log diagnostic metadata without exception messages, response bodies, URLs, or stacks. */
export function logCaddyApplyFailure(
  context: string,
  error?: unknown,
  metadata: Record<string, number | boolean | null> = {}
): string {
  const errorId = randomUUID();
  const code = safeSystemErrorCode(error);
  const rawType = error instanceof Error ? error.name : typeof error;
  const errorType = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawType)
    ? rawType
    : error instanceof Error ? "Error" : "unknown";
  console.error("Caddy apply failure", {
    errorId,
    context,
    errorType,
    ...(code ? { code } : {}),
    ...metadata,
  });
  return errorId;
}
