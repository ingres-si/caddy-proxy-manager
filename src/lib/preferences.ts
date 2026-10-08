/**
 * Interface preferences of an account: theme (system, dark or light), time
 * zone, number format and default ordering of sortable lists. They follow the
 * account to every browser; the dashboard formats dates and numbers with them (src/lib/format.ts,
 * src/components/preferences/PreferencesProvider.tsx). Exports, the audit log
 * export and the REST API keep UTC and plain numbers.
 *
 * Per dashboard, like users: not synced to slaves.
 */
import { eq } from "drizzle-orm";
import { appDb, nowIso } from "./db";
import { userPreferences } from "./db/schema";
import { ApiValidationError } from "./api-errors";
import { logAuditEvent } from "./audit";
import {
  DEFAULT_PREFERENCES,
  NUMBER_FORMATS,
  THEMES,
  isNumberFormat,
  isTheme,
  isValidTimeZone,
  type UserPreferences,
} from "./preferences-shared";
import { first } from "@/src/lib/db/ops";
import {
  CLIENT_CERTIFICATE_SORT_PREFERENCES,
  L4_PROXY_HOST_SORT_PREFERENCES,
  PROXY_HOST_SORT_PREFERENCES,
  isClientCertificatesSortPreference,
  isL4ProxyHostsSortPreference,
  isProxyHostsSortPreference,
} from "./list-sort-preferences";

export type { UserPreferences } from "./preferences-shared";

/** The account's preferences; the defaults (system theme, UTC, en-US) when it has none. */
export async function getUserPreferences(userId: number): Promise<UserPreferences> {
  const row = await first(appDb.select().from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1));
  if (!row) return { ...DEFAULT_PREFERENCES };
  // Values that are no longer valid (a time zone the runtime does not know) fall back to the default.
  return {
    theme: isTheme(row.theme) ? row.theme : DEFAULT_PREFERENCES.theme,
    timeZone: isValidTimeZone(row.timeZone) ? row.timeZone : DEFAULT_PREFERENCES.timeZone,
    numberFormat: isNumberFormat(row.numberFormat) ? row.numberFormat : DEFAULT_PREFERENCES.numberFormat,
    proxyHostsSort: isProxyHostsSortPreference(row.proxyHostsSort) ? row.proxyHostsSort : DEFAULT_PREFERENCES.proxyHostsSort,
    l4ProxyHostsSort: isL4ProxyHostsSortPreference(row.l4ProxyHostsSort) ? row.l4ProxyHostsSort : DEFAULT_PREFERENCES.l4ProxyHostsSort,
    clientCertificatesSort: isClientCertificatesSortPreference(row.clientCertificatesSort)
      ? row.clientCertificatesSort
      : DEFAULT_PREFERENCES.clientCertificatesSort,
  };
}

/** Reads a change to the account's interface preferences; unknown fields are refused. */
export function parsePreferencesInput(body: unknown): Partial<UserPreferences> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiValidationError("Request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set(["theme", "timeZone", "numberFormat", "proxyHostsSort", "l4ProxyHostsSort", "clientCertificatesSort"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new ApiValidationError(`Unknown field "${key.slice(0, 40)}"`);
  }
  const input: Partial<UserPreferences> = {};
  if (record.theme !== undefined) {
    if (!isTheme(record.theme)) throw new ApiValidationError(`theme must be one of ${THEMES.join(", ")}`);
    input.theme = record.theme;
  }
  if (record.timeZone !== undefined) {
    if (!isValidTimeZone(record.timeZone)) throw new ApiValidationError("timeZone must be an IANA time zone, such as UTC or Europe/Rome");
    input.timeZone = record.timeZone;
  }
  if (record.numberFormat !== undefined) {
    if (!isNumberFormat(record.numberFormat)) {
      throw new ApiValidationError(`numberFormat must be one of ${NUMBER_FORMATS.join(", ")}`);
    }
    input.numberFormat = record.numberFormat;
  }
  if (record.proxyHostsSort !== undefined) {
    if (!isProxyHostsSortPreference(record.proxyHostsSort)) {
      throw new ApiValidationError(`proxyHostsSort must be one of ${PROXY_HOST_SORT_PREFERENCES.join(", ")}`);
    }
    input.proxyHostsSort = record.proxyHostsSort;
  }
  if (record.l4ProxyHostsSort !== undefined) {
    if (!isL4ProxyHostsSortPreference(record.l4ProxyHostsSort)) {
      throw new ApiValidationError(`l4ProxyHostsSort must be one of ${L4_PROXY_HOST_SORT_PREFERENCES.join(", ")}`);
    }
    input.l4ProxyHostsSort = record.l4ProxyHostsSort;
  }
  if (record.clientCertificatesSort !== undefined) {
    if (!isClientCertificatesSortPreference(record.clientCertificatesSort)) {
      throw new ApiValidationError(`clientCertificatesSort must be one of ${CLIENT_CERTIFICATE_SORT_PREFERENCES.join(", ")}`);
    }
    input.clientCertificatesSort = record.clientCertificatesSort;
  }
  return input;
}

/** Saves a change of the account's own preferences, recorded in the audit log. */
export async function updateUserPreferences(userId: number, input: Partial<UserPreferences>): Promise<UserPreferences> {
  // Read, merge and write in one transaction: two changes made together both stay.
  return await appDb.transaction(async (tx) => {
    const previous = await getUserPreferences(userId);
    const next = { ...previous, ...input };
    const changed = (Object.keys(input) as Array<keyof UserPreferences>).filter((key) => previous[key] !== next[key]);
    const now = nowIso();
    await tx.insert(userPreferences)
      .values({ userId, ...next, updatedAt: now })
      .onConflictDoUpdate({ target: userPreferences.userId, set: { ...next, updatedAt: now } });
    if (changed.length > 0) {
      await logAuditEvent({
        userId,
        action: "preferences_updated",
        entityType: "user",
        entityId: userId,
        summary: `Changed their interface preferences: ${changed.join(", ")}`,
        data: Object.fromEntries(changed.map((key) => [key, next[key]])),
      });
    }
    return next;
  }, { behavior: "immediate" });
}

/** Whether the account has saved preferences (the theme then follows the account to every browser). */
export async function hasSavedPreferences(userId: number): Promise<boolean> {
  return !!await first(appDb.select({ userId: userPreferences.userId }).from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1));
}
