// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { PageHeader } from "@/components/ui/PageHeader";
import { getAiSettingsView } from "@/ee/ai/settings";
import { getQuestionSettings } from "@/ee/ai/questions/settings";
import AiSettings from "./AiSettings";

export const metadata = { title: "AI settings" };

/** AI settings: the AI provider and analytics questions (they were the AI tab of the Alerts page). */
export default async function AiSettingsPage() {
  const { access } = await requirePermission("ai:read");
  const [settings, questions] = await Promise.all([getAiSettingsView(), getQuestionSettings()]);
  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageHeader className="mb-0" breadcrumb={["Settings", "AI"]} title="AI settings" />
      <AiSettings settings={settings} questions={questions} canWrite={can(access, "ai:write")} />
    </div>
  );
}
