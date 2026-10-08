"use client";

/**
 * The signed-in account's interface preferences in the browser: theme, time
 * zone, number format and default ordering of sortable lists
 * (src/lib/preferences.ts). The dashboard layout passes what the server read,
 * so server and browser render the same text and list defaults.
 *
 *  - usePreferences(): the preferences and update(), which saves a change
 *    through PUT /api/v1/preferences.
 *  - useFormat(): date, time and number formatters bound to them
 *    (src/lib/date-format.ts). Outside the provider they use the defaults
 *    (UTC, en-US), so a component can adopt them anywhere.
 *
 * The theme follows the account: a saved theme is applied when the dashboard
 * loads, and a change made with the theme switch is saved to the account.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTheme } from "next-themes";
import {
  formatDate,
  formatDateTime,
  formatNumber,
  formatPercent,
  formatRelative,
  formatTime,
} from "@/src/lib/date-format";
import { DEFAULT_PREFERENCES, isTheme, type UserPreferences } from "@/src/lib/preferences-shared";

type PreferencesContextValue = {
  preferences: UserPreferences;
  /** Saves a change; resolves with an error message, or null when it was saved. */
  update: (change: Partial<UserPreferences>) => Promise<string | null>;
};

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

async function savePreferences(change: Partial<UserPreferences>): Promise<{ ok: true; data: UserPreferences } | { ok: false; error: string }> {
  try {
    const response = await fetch("/api/v1/preferences", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(change),
    });
    const body = (await response.json().catch(() => null)) as (UserPreferences & { error?: string }) | null;
    if (!response.ok || !body) return { ok: false, error: body?.error ?? "Could not save your preferences. Try again." };
    return { ok: true, data: body };
  } catch {
    return { ok: false, error: "Could not reach the server. Try again." };
  }
}

export function PreferencesProvider({
  initial,
  saved,
  children,
}: {
  initial: UserPreferences;
  /** The account has saved preferences: its theme then wins over this browser's. */
  saved: boolean;
  children: ReactNode;
}) {
  const [preferences, setPreferences] = useState<UserPreferences>(initial);
  const { theme, setTheme } = useTheme();
  // The theme the account and this browser agree on; null until next-themes knows the browser's.
  const syncedTheme = useRef<string | null>(null);

  useEffect(() => {
    if (!isTheme(theme)) return;
    if (syncedTheme.current === null) {
      // First load: the account's saved theme wins over this browser's.
      syncedTheme.current = saved ? initial.theme : theme;
      if (saved && theme !== initial.theme) setTheme(initial.theme);
      return;
    }
    if (theme === syncedTheme.current) return;
    // Changed elsewhere (the theme switch): save it to the account.
    syncedTheme.current = theme;
    setPreferences((current) => ({ ...current, theme }));
    void savePreferences({ theme });
  }, [theme, saved, initial.theme, setTheme]);

  const update = useCallback(async (change: Partial<UserPreferences>) => {
    const result = await savePreferences(change);
    if (!result.ok) return result.error;
    setPreferences(result.data);
    if (change.theme) {
      syncedTheme.current = result.data.theme;
      setTheme(result.data.theme);
    }
    return null;
  }, [setTheme]);

  const value = useMemo(() => ({ preferences, update }), [preferences, update]);
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

const FALLBACK: PreferencesContextValue = {
  preferences: { ...DEFAULT_PREFERENCES },
  update: async () => "Preferences are not available here.",
};

export function usePreferences(): PreferencesContextValue {
  return useContext(PreferencesContext) ?? FALLBACK;
}

export type Formatters = {
  /** "3 Oct 2026, 11:36 CEST" */
  dateTime: (value: Date | number | string) => string;
  /** "3 Oct 2026" */
  date: (value: Date | number | string) => string;
  /** "11:36" */
  time: (value: Date | number | string) => string;
  /** 61,817 / 61.817 / 61 817 */
  number: (value: number, options?: Intl.NumberFormatOptions) => string;
  /** 0.018 -> 1.8% */
  percent: (value: number, fractionDigits?: number) => string;
  /** "5 minutes ago" */
  relative: (value: Date | number | string, now?: Date | number | string) => string;
  timeZone: string;
};

/** Formatters bound to the account's time zone and number format. */
export function useFormat(): Formatters {
  const { preferences } = usePreferences();
  return useMemo(() => ({
    dateTime: (value) => formatDateTime(value, preferences),
    date: (value) => formatDate(value, preferences),
    time: (value) => formatTime(value, preferences),
    number: (value, options) => formatNumber(value, preferences, options),
    percent: (value, fractionDigits) => formatPercent(value, preferences, fractionDigits),
    relative: (value, now) => formatRelative(value, now),
    timeZone: preferences.timeZone,
  }), [preferences]);
}
