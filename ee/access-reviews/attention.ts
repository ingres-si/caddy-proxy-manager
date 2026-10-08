// SPDX-License-Identifier: Elastic-2.0
/**
 * Attention providers for access reviews: the reader's own items to decide
 * (any signed-in reviewer), and for access_reviews:read the campaigns that
 * are overdue or due soon and schedules that failed.
 */
import { eq } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { accessReviewCampaigns, accessReviewItems, accessReviewSchedules } from "@/src/lib/db/schema";
import type { AttentionItem, AttentionProvider } from "@/src/lib/attention/types";
import { pendingReviewSummary } from "./decisions";

const DAY_MS = 24 * 60 * 60 * 1000;
const DUE_SOON_DAYS = 7;

export const myReviewsAttentionProvider: AttentionProvider = {
  id: "my_reviews",
  label: "Your access reviews",
  permissions: [],
  async collect({ access, now }) {
    const summary = await pendingReviewSummary(access.userId);
    if (summary.pending === 0) return [];
    const due = summary.dueAt ? ` Due ${summary.dueAt.slice(0, 10)}.` : "";
    return [
      {
        id: "pending",
        severity: summary.overdue ? "critical" : summary.dueAt && Date.parse(summary.dueAt) - now.getTime() <= DUE_SOON_DAYS * DAY_MS ? "warning" : "info",
        title: `${summary.pending} access review item${summary.pending === 1 ? "" : "s"} wait${summary.pending === 1 ? "s" : ""} for your decision`,
        detail: `${summary.overdue ? "The review is overdue." : "Keep or revoke each access, then confirm."}${due}`,
        actions: [{ label: "Review", route: "/my-reviews" }],
        at: summary.dueAt,
      },
    ];
  },
};

export const accessReviewsAttentionProvider: AttentionProvider = {
  id: "access_reviews",
  label: "Access reviews",
  permissions: ["access_reviews:read"],
  async collect({ now }) {
    const items: Omit<AttentionItem, "source">[] = [];
    const open = await appDb.select().from(accessReviewCampaigns).where(eq(accessReviewCampaigns.status, "open")).orderBy(accessReviewCampaigns.id);
    for (const campaign of open) {
      const rows = await appDb.select({ confirmedAt: accessReviewItems.confirmedAt, outcome: accessReviewItems.outcome }).from(accessReviewItems).where(eq(accessReviewItems.campaignId, campaign.id));
      const pending = rows.filter((row) => row.confirmedAt === null && row.outcome === null).length;
      if (pending === 0) continue;
      const dueMs = Date.parse(campaign.dueAt);
      const view = [{ label: "Open the review", route: `/access-reviews/${campaign.id}` }];
      if (dueMs < now.getTime()) {
        items.push({
          id: `campaign:${campaign.id}`,
          severity: "warning",
          title: `Access review "${campaign.name}" is overdue`,
          detail: `It was due on ${campaign.dueAt.slice(0, 10)}; ${pending} of ${rows.length} items are still undecided.`,
          actions: view,
          at: campaign.dueAt,
        });
      } else if (dueMs - now.getTime() <= DUE_SOON_DAYS * DAY_MS) {
        const days = Math.max(0, Math.ceil((dueMs - now.getTime()) / DAY_MS));
        items.push({
          id: `campaign:${campaign.id}`,
          severity: "info",
          title: `Access review "${campaign.name}" is due ${days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}`,
          detail: `${rows.length - pending} of ${rows.length} items decided.`,
          actions: view,
          at: campaign.dueAt,
        });
      }
    }
    for (const schedule of await appDb.select().from(accessReviewSchedules).where(eq(accessReviewSchedules.enabled, true))) {
      if (!schedule.lastError) continue;
      items.push({
        id: `schedule:${schedule.id}`,
        severity: "warning",
        title: `Scheduled access review "${schedule.name}" could not start`,
        detail: schedule.lastError.replace(/\p{Cc}+/gu, " ").slice(0, 300),
        actions: [{ label: "Access reviews", route: "/access-reviews" }],
        at: schedule.lastRunAt,
      });
    }
    return items;
  },
};
