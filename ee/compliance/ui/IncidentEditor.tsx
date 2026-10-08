// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, FileText, Printer, RefreshCw, Save, Sparkles, Trash2 } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AppDialog } from "@/components/ui/AppDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDateTimeUtc } from "@/src/lib/date-format";
import { INCIDENT_STAGES } from "../incident-stages";
import {
  CHOICE_VALUES,
  INCIDENT_LANGUAGE_LABELS,
  INCIDENT_LANGUAGES,
  type IncidentLanguage,
  type IncidentStageKey,
  type IncidentStatus,
  type IncidentView,
} from "../types";
import IncidentFactsView from "./IncidentFactsView";
import { callApi, DeadlineBadge, Field, fromLocalInput, relativeDeadline, toLocalInput } from "./shared";

type StageForm = { fields: Record<string, string>; submittedAt: string; reference: string };
type Form = {
  title: string;
  status: IncidentStatus;
  language: IncidentLanguage;
  detectedAt: string;
  from: string;
  to: string;
  proxyHostIds: number[];
  stages: Record<IncidentStageKey, StageForm>;
};

function formOf(incident: IncidentView): Form {
  const stages = {} as Record<IncidentStageKey, StageForm>;
  for (const stage of incident.stages) {
    stages[stage.key] = { fields: { ...stage.fields }, submittedAt: toLocalInput(stage.submittedAt), reference: stage.reference ?? "" };
  }
  return {
    title: incident.title,
    status: incident.status,
    language: incident.language,
    detectedAt: toLocalInput(incident.detectedAt),
    from: toLocalInput(incident.period.from),
    to: toLocalInput(incident.period.to),
    proxyHostIds: incident.proxyHosts.map((host) => host.id),
    stages,
  };
}

const CHOICE_LABELS: Record<(typeof CHOICE_VALUES)[number], string> = { unknown: "Unknown", yes: "Yes", no: "No" };

export default function IncidentEditor({
  initial,
  proxyHosts,
  canWrite,
  aiConfigured,
}: {
  initial: IncidentView;
  proxyHosts: { id: number; name: string }[];
  canWrite: boolean;
  aiConfigured: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [incident, setIncident] = useState(initial);
  const [form, setForm] = useState<Form>(() => formOf(initial));
  const [saved, setSaved] = useState<Form>(() => formOf(initial));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [now] = useState(() => Date.now());
  const editable = canWrite;
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(saved), [form, saved]);

  function load(next: IncidentView) {
    setIncident(next);
    const nextForm = formOf(next);
    setForm(nextForm);
    setSaved(nextForm);
  }

  function setStage(key: IncidentStageKey, change: Partial<StageForm>) {
    setForm((current) => ({ ...current, stages: { ...current.stages, [key]: { ...current.stages[key], ...change } } }));
  }

  function setField(key: IncidentStageKey, field: string, value: string) {
    setForm((current) => ({
      ...current,
      stages: { ...current.stages, [key]: { ...current.stages[key], fields: { ...current.stages[key].fields, [field]: value } } },
    }));
  }

  /** Only what changed: datetime inputs have minute precision, so unchanged times are not sent back. */
  function changes(): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (form.title !== saved.title) body.title = form.title;
    if (form.status !== saved.status) body.status = form.status;
    if (form.language !== saved.language) body.language = form.language;
    if (form.detectedAt !== saved.detectedAt) body.detectedAt = fromLocalInput(form.detectedAt);
    if (form.from !== saved.from) body.from = fromLocalInput(form.from);
    if (form.to !== saved.to) body.to = fromLocalInput(form.to);
    if (JSON.stringify(form.proxyHostIds) !== JSON.stringify(saved.proxyHostIds)) body.proxyHostIds = form.proxyHostIds;
    const stages: Record<string, Record<string, unknown>> = {};
    for (const definition of INCIDENT_STAGES) {
      const next = form.stages[definition.key];
      const before = saved.stages[definition.key];
      const stage: Record<string, unknown> = {};
      const fields = Object.fromEntries(Object.entries(next.fields).filter(([key, value]) => value !== before.fields[key]));
      if (Object.keys(fields).length > 0) stage.fields = fields;
      if (next.submittedAt !== before.submittedAt) stage.submittedAt = fromLocalInput(next.submittedAt);
      if (next.reference !== before.reference) stage.reference = next.reference.trim() || null;
      if (Object.keys(stage).length > 0) stages[definition.key] = stage;
    }
    if (Object.keys(stages).length > 0) body.stages = stages;
    return body;
  }

  function save() {
    const body = changes();
    startTransition(async () => {
      try {
        load(await callApi<IncidentView>(`/incidents/${incident.id}`, "PUT", body));
        toast.success("Draft saved");
      } catch (err) {
        toast.error((err as Error).message);
      }
    });
  }

  function draft(stage: IncidentStageKey, source: "template" | "ai") {
    if (dirty && !window.confirm("You have unsaved changes. Filling this stage reloads the draft and discards them. Continue?")) return;
    startTransition(async () => {
      try {
        load(await callApi<IncidentView>(`/incidents/${incident.id}/draft`, "POST", { stage, source }));
        toast.success(source === "ai" ? "AI first draft written: review and edit it before submitting" : "Stage filled from the template");
      } catch (err) {
        toast.error((err as Error).message);
      }
    });
  }

  function refreshFacts() {
    startTransition(async () => {
      try {
        const next = await callApi<IncidentView>(`/incidents/${incident.id}/facts`, "POST");
        setIncident((current) => ({ ...current, facts: next.facts, factsCollectedAt: next.factsCollectedAt }));
        toast.success("Facts collected again");
      } catch (err) {
        toast.error((err as Error).message);
      }
    });
  }

  function remove() {
    startTransition(async () => {
      try {
        await callApi(`/incidents/${incident.id}`, "DELETE");
        toast.success("Draft deleted");
        router.push("/compliance#incidents");
      } catch (err) {
        toast.error((err as Error).message);
        setConfirmDelete(false);
      }
    });
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageHeader
        className="mb-0"
        breadcrumb={["Govern", { label: "Compliance", href: "/compliance" }, { label: "Incident register", href: `/compliance?incident=${incident.id}#incidents` }, `#${incident.id}`]}
        title={incident.title}
        description="Notification drafts of NIS2 Article 23: early warning, incident notification and final report."
        actions={
          <>
            <Button asChild variant="outline">
              <a href={`/print/compliance/incidents/${incident.id}`} target="_blank" rel="noopener">
                <Printer className="h-4 w-4" /> Print / PDF
              </a>
            </Button>
            {canWrite && (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            )}
            {editable && (
              <Button onClick={save} disabled={!dirty || pending}>
                <Save className="h-4 w-4" /> {pending ? "Saving…" : dirty ? "Save" : "Saved"}
              </Button>
            )}
          </>
        }
      />

      <Banner tone="warn" title="Nothing is sent from here.">
        This is a draft for you to complete: submit each stage through your CSIRT&apos;s or authority&apos;s channel (in Italy, CSIRT Italia at ACN),
        then record when you submitted it and the reference you received.
      </Banner>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Incident</CardTitle>
          <CardDescription>
            Created {formatDateTimeUtc(incident.createdAt)} UTC by {incident.createdBy.name ?? `user ${incident.createdBy.userId ?? "?"}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Title" htmlFor="incident-title">
            <Input id="incident-title" value={form.title} maxLength={200} disabled={!editable} onChange={(event) => setForm({ ...form, title: event.target.value })} />
          </Field>
          <Field label="Became aware at (your time zone)" htmlFor="incident-detected" hint="The deadlines run from this time.">
            <Input id="incident-detected" type="datetime-local" value={form.detectedAt} disabled={!editable} onChange={(event) => setForm({ ...form, detectedAt: event.target.value })} />
          </Field>
          <Field label="Status" htmlFor="incident-status">
            <Select value={form.status} disabled={!editable} onValueChange={(value) => setForm({ ...form, status: value as IncidentStatus })}>
              <SelectTrigger id="incident-status" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Language of the template and AI drafts" htmlFor="incident-language">
            <Select value={form.language} disabled={!editable} onValueChange={(value) => setForm({ ...form, language: value as IncidentLanguage })}>
              <SelectTrigger id="incident-language" aria-label="Language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INCIDENT_LANGUAGES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {INCIDENT_LANGUAGE_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Figures from (your time zone)" htmlFor="incident-from">
            <Input id="incident-from" type="datetime-local" value={form.from} disabled={!editable} onChange={(event) => setForm({ ...form, from: event.target.value })} />
          </Field>
          <Field label="Figures to" htmlFor="incident-to" hint="Changing the period or the hosts collects the facts again when you save.">
            <Input id="incident-to" type="datetime-local" value={form.to} disabled={!editable} onChange={(event) => setForm({ ...form, to: event.target.value })} />
          </Field>
          <div className="md:col-span-2">
            <Field label="Affected proxy hosts" hint="None selected: figures cover every host.">
              <div className="max-h-40 overflow-y-auto rounded-md border p-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                {proxyHosts.length === 0 && <p className="text-xs text-muted-foreground">No proxy hosts.</p>}
                {proxyHosts.map((host) => (
                  <label key={host.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={form.proxyHostIds.includes(host.id)}
                      disabled={!editable}
                      onCheckedChange={(checked) =>
                        setForm({
                          ...form,
                          proxyHostIds: checked ? [...form.proxyHostIds, host.id].sort((a, b) => a - b) : form.proxyHostIds.filter((id) => id !== host.id),
                        })
                      }
                    />
                    {host.name}
                  </label>
                ))}
              </div>
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="text-base">Facts</CardTitle>
            <CardDescription>
              Aggregated figures (no log lines or client addresses){incident.factsCollectedAt ? `, collected ${formatDateTimeUtc(incident.factsCollectedAt)} UTC` : ""}.
            </CardDescription>
          </div>
          {editable && (
            <Button variant="outline" size="sm" onClick={refreshFacts} disabled={pending}>
              <RefreshCw className="h-4 w-4" /> Collect again
            </Button>
          )}
        </CardHeader>
        <CardContent>{incident.facts ? <IncidentFactsView facts={incident.facts} /> : <p className="text-sm text-muted-foreground">No facts collected.</p>}</CardContent>
      </Card>

      {INCIDENT_STAGES.map((definition) => {
        const view = incident.stages.find((stage) => stage.key === definition.key)!;
        const stage = form.stages[definition.key];
        return (
          <Card key={definition.key}>
            <CardHeader className="space-y-2">
              <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <div className="space-y-1">
                  <CardTitle className="text-base flex flex-wrap items-center gap-2">
                    {definition.label} <DeadlineBadge status={view.status} />
                    {view.ai && <Badge variant="info">AI-generated first draft{view.editedAt ? ", edited" : ""}</Badge>}
                  </CardTitle>
                  <CardDescription>
                    {definition.legalBasis}. Due {formatDateTimeUtc(view.deadline)} UTC
                    {view.status !== "submitted" ? ` (${relativeDeadline(view.deadline, now)})` : ""}: {definition.deadlineRule.toLowerCase()}.
                  </CardDescription>
                </div>
                {editable && (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => draft(definition.key, "template")} disabled={pending}>
                      <FileText className="h-4 w-4" /> Fill from template
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => draft(definition.key, "ai")}
                      disabled={pending || !aiConfigured}
                      title={aiConfigured ? "Your configured model writes a first draft from the aggregated facts" : "Configure an AI provider under AI settings first"}
                    >
                      <Sparkles className="h-4 w-4" /> Draft with AI
                    </Button>
                  </div>
                )}
              </div>
              {view.ai && (
                <p className="text-xs text-muted-foreground">
                  Written by {view.ai.provider} ({view.ai.model}) on {formatDateTimeUtc(view.ai.generatedAt)} UTC from aggregated facts. Check every
                  statement and fill the bracketed placeholders before you submit it.
                </p>
              )}
              <p className="text-xs text-muted-foreground">{definition.requirement}</p>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {definition.fields.map((field) => {
                const id = `${definition.key}-${field.key}`;
                return field.kind === "choice" ? (
                  <Field key={field.key} label={field.label} htmlFor={id} hint={field.guidance}>
                    <Select value={stage.fields[field.key] ?? "unknown"} disabled={!editable} onValueChange={(value) => setField(definition.key, field.key, value)}>
                      <SelectTrigger id={id} className="w-48" aria-label={field.label}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CHOICE_VALUES.map((value) => (
                          <SelectItem key={value} value={value}>
                            {CHOICE_LABELS[value]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                ) : (
                  <Field key={field.key} label={field.label} htmlFor={id} hint={field.guidance}>
                    <div className="relative">
                      <Textarea
                        id={id}
                        value={stage.fields[field.key] ?? ""}
                        maxLength={8000}
                        rows={5}
                        disabled={!editable}
                        onChange={(event) => setField(definition.key, field.key, event.target.value)}
                        className="pr-10"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-1 top-1 h-7 w-7"
                        title="Copy"
                        onClick={() => copy(stage.fields[field.key] ?? "")}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </Field>
                );
              })}
              <div className="grid gap-4 md:grid-cols-2 border-t pt-4">
                <Field label="Submitted at (your time zone)" htmlFor={`${definition.key}-submitted`} hint="When you submitted this stage. Leave empty while it is a draft.">
                  <Input
                    id={`${definition.key}-submitted`}
                    type="datetime-local"
                    value={stage.submittedAt}
                    disabled={!editable}
                    onChange={(event) => setStage(definition.key, { submittedAt: event.target.value })}
                  />
                </Field>
                <Field label="Reference" htmlFor={`${definition.key}-reference`} hint="The CSIRT's or authority's reference for the submission.">
                  <Input
                    id={`${definition.key}-reference`}
                    value={stage.reference}
                    maxLength={200}
                    disabled={!editable}
                    onChange={(event) => setStage(definition.key, { reference: event.target.value })}
                  />
                </Field>
              </div>
            </CardContent>
          </Card>
        );
      })}

      {editable && dirty && (
        <div className="sticky bottom-4 flex justify-end">
          <Button onClick={save} disabled={pending} className="shadow-lg">
            <Save className="h-4 w-4" /> {pending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      )}

      <AppDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete draft" submitLabel="Delete" onSubmit={remove} isSubmitting={pending}>
        <p className="text-sm">Delete this draft with its facts and text? This cannot be undone.</p>
      </AppDialog>
    </div>
  );
}
