// SPDX-License-Identifier: Elastic-2.0
import { BlockList, isIP } from "node:net";
import { ApiValidationError } from "@/src/lib/api-errors";
import { config } from "@/src/lib/config";
import { parseRowId } from "@/src/lib/row-ids";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ApiValidationError(`${what} must be a JSON object`);
  return value;
}

export function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new ApiValidationError(`Unknown field "${key}" in ${what}`);
  }
}

export function readName(value: unknown, field = "name"): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiValidationError(`${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > 100) throw new ApiValidationError(`${field} must be at most 100 characters`);
  if (/\p{Cc}/u.test(trimmed)) throw new ApiValidationError(`${field} must not contain control characters`);
  return trimmed;
}

export function readBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ApiValidationError(`${field} must be true or false`);
  return value;
}

export function readInteger(value: unknown, field: string, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiValidationError(`${field} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

/** A printable, single-line string of bounded length. */
export function readText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ApiValidationError(`${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ApiValidationError(`${field} must be at most ${max} characters`);
  if (/\p{Cc}/u.test(trimmed)) throw new ApiValidationError(`${field} must not contain control characters`);
  return trimmed;
}

/** Optional secret input: undefined or "" keeps the stored value, null removes it, a string replaces it. */
export type SecretInput = { kind: "keep" } | { kind: "clear" } | { kind: "set"; value: string };

export function readSecretInput(value: unknown, field: string, max: number): SecretInput {
  if (value === undefined || value === "") return { kind: "keep" };
  if (value === null) return { kind: "clear" };
  if (typeof value !== "string") throw new ApiValidationError(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return { kind: "keep" };
  if (trimmed.length > max) throw new ApiValidationError(`${field} must be at most ${max} characters`);
  if (/\p{Cc}/u.test(trimmed)) throw new ApiValidationError(`${field} must not contain control characters`);
  return { kind: "set", value: trimmed };
}

const EMAIL_ADDRESS = /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\.]+(?:\.[^\s@<>()[\]",;:\\.]+)+$/;

export function readEmailAddress(value: unknown, field: string): string {
  const text = readText(value, field, 254);
  if (!EMAIL_ADDRESS.test(text)) throw new ApiValidationError(`${field} must be an e-mail address`);
  return text;
}

/** Addresses no notification or provider endpoint lives at: link-local, where cloud metadata services answer. */
const BLOCKED_ADDRESSES = new BlockList();
BLOCKED_ADDRESSES.addSubnet("169.254.0.0", 16, "ipv4");
BLOCKED_ADDRESSES.addSubnet("fe80::", 10, "ipv6");
BLOCKED_ADDRESSES.addAddress("fd00:ec2::254", "ipv6");
const METADATA_NAMES = new Set(["metadata.google.internal", "metadata", "instance-data"]);

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

/** Caddy's admin API, which answers this container without authentication. */
const CADDY_ADMIN = ((): { hostname: string; port: string } | null => {
  try {
    const url = new URL(config.caddyApiUrl);
    return { hostname: hostnameOf(url), port: effectivePort(url) };
  } catch {
    return null;
  }
})();

/**
 * Why requests from this server may not go to `target`: a link-local or cloud
 * metadata address, or Caddy's admin API. Null when they may. The check is by
 * the URL's host name, so it is cheap enough to repeat at delivery; it is a
 * guard against the obvious internal targets, not a network boundary.
 */
export function blockedDestination(target: string | URL): string | null {
  let url: URL;
  try {
    url = typeof target === "string" ? new URL(target) : target;
  } catch {
    return null;
  }
  const hostname = hostnameOf(url);
  const family = isIP(hostname);
  if (family !== 0 && BLOCKED_ADDRESSES.check(hostname, family === 6 ? "ipv6" : "ipv4")) {
    return "a link-local or cloud metadata address";
  }
  if (METADATA_NAMES.has(hostname)) return "a cloud metadata service";
  if (CADDY_ADMIN && hostname === CADDY_ADMIN.hostname && effectivePort(url) === CADDY_ADMIN.port) return "Caddy's admin API";
  return null;
}

/**
 * An http(s) URL without credentials or fragment, not at a blocked
 * destination. `https` restricts the scheme. Messages never echo the URL: it
 * may embed a token.
 */
export function readHttpUrl(value: unknown, field: string, options: { https?: boolean; allowQuery?: boolean } = {}): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ApiValidationError(`${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length > 2048) throw new ApiValidationError(`${field} must be at most 2048 characters`);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ApiValidationError(`${field} must be a valid URL`);
  }
  if (options.https ? url.protocol !== "https:" : url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ApiValidationError(`${field} must start with ${options.https ? "https://" : "http:// or https://"}`);
  }
  if (url.username || url.password) throw new ApiValidationError(`${field} must not contain a user name or password`);
  if (url.hash) throw new ApiValidationError(`${field} must not contain a fragment`);
  if (!options.allowQuery && url.search) throw new ApiValidationError(`${field} must not contain a query string`);
  const blocked = blockedDestination(url);
  if (blocked) throw new ApiValidationError(`${field} must not point at ${blocked}`);
  return trimmed;
}

/** Scheme and host of a URL that may embed a token, safe to show. */
export function urlHint(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

export function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** A rule's stored channelIds (a JSON array); anything unreadable is no channel. */
export function parseChannelIds(value: string): number[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isInteger(id) && id > 0) : [];
  } catch {
    return [];
  }
}

export function parseId(value: string | number): number {
  const id = parseRowId(value);
  if (id === null) throw new ApiValidationError("Invalid id");
  return id;
}
