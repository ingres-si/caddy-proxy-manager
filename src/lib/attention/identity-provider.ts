/**
 * Attention provider: how people sign in (src/lib/identity-health.ts).
 *
 * - LDAP directories that fail their periodic connection check, for readers
 *   of the directories (ldap:read): critical after three failed checks in a
 *   row, a warning before.
 * - Accounts the MFA policy has locked out of the dashboard until they set
 *   up MFA, for readers of the users (users:read).
 *
 * Both cover every account and directory of this dashboard. Reads stored
 * state only.
 */
import { can } from "@/src/lib/permissions";
import { getIdentityHealth } from "@/src/lib/identity-health";
import type { AttentionItem, AttentionProvider } from "./types";

type Item = Omit<AttentionItem, "source" | "dismissible">;

function utc(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

export const identityAttentionProvider: AttentionProvider = {
  id: "identity",
  label: "Sign-in",
  permissions: ["ldap:read", "users:read"],
  async collect({ access }) {
    const items: Item[] = [];
    for (const issue of (await getIdentityHealth()).issues) {
      if (issue.kind === "directory_failing") {
        if (!can(access, "ldap:read")) continue;
        const checks = issue.consecutiveFailures === 1 ? "the last check" : `the last ${issue.consecutiveFailures} checks in a row`;
        const since = issue.failingSince ? `, failing since ${utc(issue.failingSince)}` : "";
        items.push({
          id: `directory:${issue.directoryId}`,
          severity: issue.severity,
          title: `People cannot sign in through the directory "${issue.name}"`,
          detail: `${issue.lastError ?? "Its connection check fails"} (${checks}${since}). Accounts from other sign-in methods are not affected.`,
          actions: [{ label: "Open directories", route: "/ldap" }],
          at: issue.failingSince,
        });
      } else if (issue.kind === "mfa_overdue") {
        if (!can(access, "users:read")) continue;
        items.push({
          id: "mfa_overdue",
          severity: "warning",
          title: issue.accounts === 1
            ? "1 account is locked out until it sets up multi-factor authentication"
            : `${issue.accounts} accounts are locked out until they set up multi-factor authentication`,
          detail:
            "The MFA policy's deadline has passed, so their dashboard sessions can only set up an authenticator app or a passkey. " +
            "Remind them, or reset their MFA if they lost their device.",
          actions: [{ label: "Review accounts", route: "/users" }],
          at: null,
        });
      }
    }
    return items;
  },
};
