import type { ReactNode } from "react";
import { getSessionAccess, requireUser } from "@/src/lib/auth";
import { listHeldPermissions } from "@/src/lib/permissions";
import { getMfaGate } from "@/src/lib/mfa";
import DashboardLayoutClient from "./DashboardLayoutClient";
import MfaPromptBanner from "./MfaPromptBanner";
import AccessReviewBanner from "@/ee/access-reviews/ui/AccessReviewBanner";
import { pendingReviewSummary } from "@/ee/access-reviews/decisions";
import { getNavSummary } from "@/src/lib/nav-summary";
import { getUserPreferences, hasSavedPreferences } from "@/src/lib/preferences";
import { PreferencesProvider } from "@/src/components/preferences/PreferencesProvider";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // requireUser already sent accounts whose MFA grace period is over to the setup page.
  const session = await requireUser();
  const mfa = await getMfaGate(Number(session.user.id));
  const access = await getSessionAccess(session);
  // Access reviews (ee/access-reviews) the user was named a reviewer of.
  let reviews: Awaited<ReturnType<typeof pendingReviewSummary>> = { pending: 0, dueAt: null, overdue: false };
  try {
    reviews = await pendingReviewSummary(Number(session.user.id));
  } catch {
    // A reminder only; never break the dashboard over it.
  }
  // Sidebar counters and environment, each guarded by its read permission.
  const summary = await getNavSummary(access, reviews);
  // Interface preferences, including formatting and default list ordering (src/lib/preferences.ts).
  const userId = Number(session.user.id);
  const preferences = await getUserPreferences(userId);
  return (
    <PreferencesProvider initial={preferences} saved={await hasSavedPreferences(userId)}>
      <DashboardLayoutClient
        user={{ ...session.user, permissions: listHeldPermissions(access), isAdmin: access.isAdmin }}
        summary={summary}
      >
        {mfa.gate === "prompt" && <MfaPromptBanner deadline={mfa.deadline} />}
        {reviews.pending > 0 && <AccessReviewBanner {...reviews} />}
        {children}
      </DashboardLayoutClient>
    </PreferencesProvider>
  );
}
