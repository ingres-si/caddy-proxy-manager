// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/SectionCard";
import { Switch } from "@/components/ui/switch";
import type { QuestionSettingsView } from "@/ee/ai/questions/types";
import { saveQuestionSettingsAction } from "@/ee/alerting/ui/actions";

type Props = {
  settings: QuestionSettingsView;
  aiConfigured: boolean;
  /** ai:write; without it the form is read-only. */
  canWrite?: boolean;
};

/** Settings of plain-language analytics questions (ee/ai/questions), on AI settings. */
export default function QuestionSettingsSection({ settings, aiConfigured, canWrite = true }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState<QuestionSettingsView>(settings);
  const [error, setError] = useState<string | null>(null);
  const changed = (Object.keys(form) as (keyof QuestionSettingsView)[]).some((key) => form[key] !== settings[key]);

  function save() {
    setError(null);
    const input = Object.fromEntries((Object.keys(form) as (keyof QuestionSettingsView)[]).filter((key) => form[key] !== settings[key]).map((key) => [key, form[key]]));
    startTransition(async () => {
      const result = await saveQuestionSettingsAction(input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success("Question settings saved");
      router.refresh();
    });
  }

  // The hint says what the switch does as it is set now.
  const toggle = (key: keyof QuestionSettingsView, label: string, hint?: (on: boolean) => string) => (
    <label className="flex items-start gap-3 text-sm">
      <Switch
        className="mt-0.5"
        checked={form[key]}
        onCheckedChange={(checked) => setForm({ ...form, [key]: checked })}
        disabled={pending || !canWrite}
        aria-label={label}
      />
      <span className="flex flex-col gap-0.5">
        <span>{label}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint(form[key])}</span>}
      </span>
    </label>
  );

  return (
    <SectionCard
      title="Analytics questions"
      padded
      contentClassName="flex flex-col gap-4"
    >
      {!aiConfigured && <p className="m-0 text-[13px] text-muted-foreground">Set up the AI provider first.</p>}
      {toggle("enabled", "Let users ask questions", () => "Questions are recorded in the audit log.")}
      {toggle("aiSummaries", "AI-written summaries", (on) =>
        on ? "The model reads the result and writes a short summary of it." : "The result is never sent to the model."
      )}
      {toggle("shareRequestDetails", "Send client addresses, user agents and paths when a question needs them", (on) =>
        on
          ? "The model sees them when a question needs them. The question is always sent as typed."
          : "The model sees placeholders instead. The question is always sent as typed."
      )}
      {error && (
        <Banner tone="bad" live>
          {error}
        </Banner>
      )}
      <div>
        <Button onClick={save} disabled={pending || !changed || !canWrite}>
          Save
        </Button>
      </div>
    </SectionCard>
  );
}
