// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { SectionCard } from "@/components/ui/SectionCard";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import { CHANNEL_TYPE_LABELS, type AlertChannelView } from "@/ee/alerting/types";
import type { DigestPreview, DigestSettingsView, NarrativeStatus } from "@/ee/ai/types";
import { previewDigestAction, saveDigestSettingsAction, sendDigestAction } from "./digest-actions";

const NARRATIVE_NOTES: Record<NarrativeStatus, string | null> = {
  added: null,
  off: null,
  unavailable: "No AI summary: no AI provider is enabled and configured.",
  failed: "The AI summary could not be written, so the plain digest is used.",
};

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

type Props = {
  settings: DigestSettingsView;
  channels: AlertChannelView[];
  aiConfigured: boolean;
};

export default function DigestSection({ settings, channels, aiConfigured }: Props) {
  const router = useRouter();
  const format = useFormat();
  const [pending, startTransition] = useTransition();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [timeOfDay, setTimeOfDay] = useState(settings.timeOfDay);
  const [timeZone, setTimeZone] = useState(settings.timeZone);
  const [channelIds, setChannelIds] = useState<number[]>(settings.channelIds);
  const [ai, setAi] = useState(settings.ai);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DigestPreview | null>(null);
  // Filled on first focus: server and browser time zone lists differ.
  const [zones, setZones] = useState<string[]>([]);
  const usable = channels.filter((channel) => channel.type !== "pagerduty");

  function toggleChannel(id: number, checked: boolean) {
    setChannelIds((current) => (checked ? [...new Set([...current, id])] : current.filter((value) => value !== id)));
  }

  function save(input: Record<string, unknown>, message: string) {
    setError(null);
    startTransition(async () => {
      const result = await saveDigestSettingsAction(input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(message);
      router.refresh();
    });
  }

  function runPreview() {
    setError(null);
    setPreview(null);
    startTransition(async () => {
      const result = await previewDigestAction(ai);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPreview(result.value);
    });
  }

  function sendNow() {
    setError(null);
    startTransition(async () => {
      const result = await sendDigestAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const failed = result.value.deliveries.filter((delivery) => !delivery.ok);
      if (failed.length === 0) toast.success(`Digest sent to ${result.value.deliveries.length} channel(s)`);
      else toast.error(`Not delivered to ${failed.map((delivery) => `${delivery.channelName} (${delivery.error})`).join(", ")}`);
      router.refresh();
    });
  }

  const lastRun = settings.lastRun;
  return (
    <SectionCard
      title="Daily security digest"
      actions={settings.enabled ? <Badge variant="success">On</Badge> : <Badge variant="secondary">Off</Badge>}
      padded
      contentClassName="flex flex-col gap-4"
    >
        <fieldset disabled={pending} className="grid gap-4 md:grid-cols-2">
          <label className="flex items-center gap-2 text-sm md:col-span-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
            Send the digest every day
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="digest-time">Time</Label>
            <Input id="digest-time" type="time" value={timeOfDay} onChange={(event) => setTimeOfDay(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="digest-zone">Time zone</Label>
            <div className="flex gap-2">
              <Input
                id="digest-zone"
                list="digest-zones"
                value={timeZone}
                onFocus={() => setZones((current) => (current.length ? current : timeZones()))}
                onChange={(event) => setTimeZone(event.target.value)}
                placeholder="Europe/Rome"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")}
              >
                Mine
              </Button>
            </div>
            <datalist id="digest-zones">
              {zones.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label>Channels</Label>
            {usable.length === 0 ? (
              <p className="text-sm text-muted-foreground">Add a channel above first (PagerDuty channels do not receive digests).</p>
            ) : (
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {usable.map((channel) => (
                  <label key={channel.id} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={channelIds.includes(channel.id)} onCheckedChange={(checked) => toggleChannel(channel.id, checked === true)} />
                    {channel.name}
                    <span className="text-xs text-muted-foreground">
                      {CHANNEL_TYPE_LABELS[channel.type]}
                      {channel.enabled ? "" : ", disabled"}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm md:col-span-2">
            <Switch checked={ai} onCheckedChange={setAi} />
            Add an AI-generated summary
            {!aiConfigured && (
              <span className="text-xs text-muted-foreground">
                (needs an AI provider:{" "}
                <Link href="/settings/ai" className="text-brand hover:underline">
                  AI settings
                </Link>
                )
              </span>
            )}
          </label>
        </fieldset>
        {error && (
          <Banner tone="bad" live>
            {error}
          </Banner>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => save({ enabled, timeOfDay, timeZone: timeZone.trim(), channelIds, ai }, "Digest settings saved")}
            disabled={pending}
          >
            Save
          </Button>
          <Button variant="outline" onClick={runPreview} disabled={pending}>
            Preview
          </Button>
          <Button variant="outline" onClick={sendNow} disabled={pending || settings.channelIds.length === 0}>
            Send now
          </Button>
          {settings.channelIds.length === 0 && (
            <span className="self-center text-xs text-muted-foreground">Choose a channel and save to send one now.</span>
          )}
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          {settings.nextRunAt && (
            <p>
              Next digest: <span className="num">{format.dateTime(settings.nextRunAt)}</span>
            </p>
          )}
          {lastRun && (
            <p>
              Last sent <span className="num">{format.dateTime(lastRun.at)}</span> ({lastRun.trigger === "manual" ? "on demand" : "scheduled"}):{" "}
              {lastRun.deliveries.length === 0
                ? "no enabled channel"
                : lastRun.deliveries.map((delivery) => `${delivery.channelName} ${delivery.ok ? "delivered" : `failed (${delivery.error})`}`).join(", ")}
              {lastRun.narrative === "added" ? ", with AI summary" : lastRun.narrative === "failed" ? ", AI summary failed" : ""}
            </p>
          )}
        </div>
        {preview && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{preview.subject}</p>
            {NARRATIVE_NOTES[preview.narrative.status] && (
              <p className="text-xs text-muted-foreground">
                {NARRATIVE_NOTES[preview.narrative.status]}
                {preview.narrative.error ? ` (${preview.narrative.error})` : ""}
              </p>
            )}
            <pre className="num max-h-[480px] overflow-auto whitespace-pre-wrap rounded-[10px] border border-line bg-background p-3 text-xs">{preview.text}</pre>
          </div>
        )}
    </SectionCard>
  );
}
