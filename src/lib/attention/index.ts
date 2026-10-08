/**
 * The registered attention providers. Built-in ones are registered here
 * (among them the alerts firing now and sign-in health); another
 * module adds its own with registerAttentionProvider, and its items appear
 * for readers who hold one of the provider's permissions.
 */
import { registerAttentionProvider } from "./registry";
import { caddyApplyProvider, certificatesProvider, setupProvider } from "./core-providers";
import { identityAttentionProvider } from "./identity-provider";
import { alertsAttentionProvider } from "@/ee/alerting/attention";
import { approvalsAttentionProvider } from "@/ee/approvals/attention";
import { accessReviewsAttentionProvider, myReviewsAttentionProvider } from "@/ee/access-reviews/attention";
import { fleetAttentionProvider } from "@/ee/fleet/attention";
import { backupsAttentionProvider } from "@/ee/backups/attention";
import { monetizationAttentionProvider } from "@/ee/monetization/attention";

for (const provider of [
  certificatesProvider,
  caddyApplyProvider,
  setupProvider,
  identityAttentionProvider,
  alertsAttentionProvider,
  approvalsAttentionProvider,
  myReviewsAttentionProvider,
  accessReviewsAttentionProvider,
  fleetAttentionProvider,
  backupsAttentionProvider,
  monetizationAttentionProvider,
]) {
  registerAttentionProvider(provider);
}

export { collectAttention, registerAttentionProvider, unregisterAttentionProvider, listAttentionProviders } from "./registry";
export type { AttentionItem, AttentionProvider, AttentionSeverity, AttentionView } from "./types";
