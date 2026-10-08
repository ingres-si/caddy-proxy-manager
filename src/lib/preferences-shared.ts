/**
 * Interface preferences shared by the server (src/lib/preferences.ts) and the
 * browser (src/components/preferences/PreferencesProvider.tsx): the allowed
 * values and their checks. No database, no Node APIs.
 */

import type {
  ClientCertificatesSortPreference,
  L4ProxyHostsSortPreference,
  ProxyHostsSortPreference,
} from "./list-sort-preferences";

export type {
  ClientCertificatesSortPreference,
  L4ProxyHostsSortPreference,
  ProxyHostsSortPreference,
} from "./list-sort-preferences";

export const THEMES = ["system", "dark", "light"] as const;
export type ThemePreference = (typeof THEMES)[number];

/**
 * Number formats offered, by the locale whose digit grouping and decimal
 * mark they use: 1,234.5 / 1.234,5 / 1 234,5.
 */
export const NUMBER_FORMATS = ["en-US", "de-DE", "fr-FR"] as const;
export type NumberFormatPreference = (typeof NUMBER_FORMATS)[number];

export type UserPreferences = {
  theme: ThemePreference;
  /** An IANA time zone name, such as UTC or Europe/Rome. */
  timeZone: string;
  numberFormat: NumberFormatPreference;
  proxyHostsSort: ProxyHostsSortPreference;
  l4ProxyHostsSort: L4ProxyHostsSortPreference;
  clientCertificatesSort: ClientCertificatesSortPreference;
};

export const DEFAULT_PREFERENCES: Readonly<UserPreferences> = Object.freeze({
  theme: "system",
  timeZone: "UTC",
  numberFormat: "en-US",
  proxyHostsSort: "default",
  l4ProxyHostsSort: "default",
  clientCertificatesSort: "default",
});

export function isTheme(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

export function isNumberFormat(value: unknown): value is NumberFormatPreference {
  return typeof value === "string" && (NUMBER_FORMATS as readonly string[]).includes(value);
}

/** An IANA time zone this runtime knows (UTC included). */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The time zones to offer: what the runtime lists, with UTC first. */
export function listTimeZones(): string[] {
  let zones: string[];
  try {
    zones = (Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  return ["UTC", ...zones.filter((zone) => zone !== "UTC")];
}

/** An example of a number format, for the preference picker. */
export function numberFormatExample(format: NumberFormatPreference): string {
  return new Intl.NumberFormat(format, { maximumFractionDigits: 1 }).format(1234.5);
}
