// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Send, Trash2 } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pagination } from "@/components/ui/Pagination";
import { SearchField } from "@/components/ui/SearchField";
import { SectionCard } from "@/components/ui/SectionCard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusDot } from "@/components/ui/StatusDot";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import { paginate } from "@/src/lib/pagination";
import {
  CHANNEL_TYPE_LABELS,
  CHANNEL_TYPES,
  type AlertChannelView,
  type AlertRuleView,
  type ChannelType,
  type EmailChannelView,
  type NtfyChannelView,
  type PagerDutyChannelView,
} from "@/ee/alerting/types";
import DigestSection from "@/ee/ai/ui/DigestSection";
import type { DigestSettingsView } from "@/ee/ai/types";
import { deleteAlertChannelAction, saveAlertChannelAction, setAlertChannelEnabledAction, testAlertChannelAction, testAlertChannelDraftAction } from "./actions";
import { channelDestination } from "./format";

type Form = {
  name: string;
  type: ChannelType;
  enabled: boolean;
  host: string;
  port: string;
  secure: boolean;
  user: string;
  password: string;
  clearPassword: boolean;
  from: string;
  to: string;
  webhookUrl: string;
  url: string;
  hmacSecret: string;
  clearHmacSecret: boolean;
  routingKey: string;
  region: "us" | "eu";
  serverUrl: string;
  topic: string;
  token: string;
  clearToken: boolean;
};

const EMPTY_FORM: Form = {
  name: "",
  type: "email",
  enabled: true,
  host: "",
  port: "587",
  secure: false,
  user: "",
  password: "",
  clearPassword: false,
  from: "",
  to: "",
  webhookUrl: "",
  url: "",
  hmacSecret: "",
  clearHmacSecret: false,
  routingKey: "",
  region: "us",
  serverUrl: "https://ntfy.sh",
  topic: "",
  token: "",
  clearToken: false,
};

function formFromChannel(channel: AlertChannelView): Form {
  const form: Form = { ...EMPTY_FORM, name: channel.name, type: channel.type, enabled: channel.enabled };
  if (channel.type === "email") {
    const config = channel.config as EmailChannelView;
    return { ...form, host: config.host, port: String(config.port), secure: config.secure, user: config.user ?? "", from: config.from, to: config.to.join(", ") };
  }
  if (channel.type === "ntfy") {
    const config = channel.config as NtfyChannelView;
    return { ...form, serverUrl: config.serverUrl, topic: config.topic };
  }
  if (channel.type === "pagerduty") {
    return { ...form, region: (channel.config as PagerDutyChannelView).region };
  }
  return form;
}

/** Only what the admin typed: empty secrets keep the stored ones. */
function configFromForm(form: Form): Record<string, unknown> {
  const secret = (value: string, clear = false) => (clear ? null : value.trim() || undefined);
  switch (form.type) {
    case "email":
      return {
        host: form.host.trim(),
        port: Number(form.port),
        secure: form.secure,
        user: form.user.trim() || null,
        password: secret(form.password, form.clearPassword),
        from: form.from.trim(),
        to: form.to.split(/[,\s]+/).filter(Boolean),
      };
    case "slack":
    case "teams":
      return { webhookUrl: secret(form.webhookUrl) };
    case "webhook":
      return { url: secret(form.url), hmacSecret: secret(form.hmacSecret, form.clearHmacSecret) };
    case "pagerduty":
      return { routingKey: secret(form.routingKey), region: form.region };
    case "ntfy":
      return { serverUrl: form.serverUrl.trim(), topic: form.topic.trim(), token: secret(form.token, form.clearToken) };
  }
}

function Field({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SecretField(props: {
  id: string;
  label: string;
  value: string;
  stored: boolean;
  onChange: (value: string) => void;
  hint?: string;
  clear?: { checked: boolean; onChange: (checked: boolean) => void; label: string };
}) {
  return (
    <Field label={props.label} htmlFor={props.id} hint={props.hint}>
      <Input
        id={props.id}
        type="password"
        autoComplete="new-password"
        value={props.value}
        placeholder={props.stored ? "Stored; leave empty to keep" : ""}
        onChange={(event) => props.onChange(event.target.value)}
        disabled={props.clear?.checked}
      />
      {props.stored && props.clear && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={props.clear.checked} onCheckedChange={(checked) => props.clear!.onChange(checked === true)} />
          {props.clear.label}
        </label>
      )}
    </Field>
  );
}

type Props = {
  channels: AlertChannelView[];
  rules: AlertRuleView[];
  /** The user holds alerts:write; without it the tab is read-only. */
  canWrite?: boolean;
  /** The daily security digest (ee/ai), for readers of the AI settings; left out without them. */
  digest?: DigestSettingsView | null;
  /** An AI provider is set up (the digest's AI summary). */
  aiConfigured?: boolean;
};

type TestOutcome = { ok: boolean; text: string; at: number };

export default function ChannelsTab({ channels, rules, canWrite = true, digest = null, aiConfigured = false }: Props) {
  const router = useRouter();
  const format = useFormat();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<AlertChannelView | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AlertChannelView | null>(null);
  const [tests, setTests] = useState<Record<number, TestOutcome>>({});
  const [testing, setTesting] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((previous) => ({ ...previous, [key]: value }));
  const stored = (key: string) => Boolean(editing && (editing.config as Record<string, unknown>)[key]);
  const usedBy = (channel: AlertChannelView) => rules.filter((rule) => rule.channelIds.includes(channel.id)).length;
  const failing = channels.filter((channel) => channel.enabled && channel.lastDeliveryError);
  const needle = search.trim().toLowerCase();
  // Name, type and destination.
  const matching = needle
    ? channels.filter((channel) => {
        const destination = channelDestination(channel);
        return [channel.name, CHANNEL_TYPE_LABELS[channel.type], destination.target, destination.detail].some((text) => text.toLowerCase().includes(needle));
      })
    : channels;
  const shown = paginate(matching, page);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setError(null);
    setDraftTest(null);
    setOpen(true);
  }

  function openEdit(channel: AlertChannelView) {
    setEditing(channel);
    setForm(formFromChannel(channel));
    setError(null);
    setDraftTest(null);
    setOpen(true);
  }

  function save() {
    setError(null);
    const input = {
      name: form.name,
      enabled: form.enabled,
      ...(editing ? {} : { type: form.type }),
      config: configFromForm(form),
    };
    startTransition(async () => {
      const result = await saveAlertChannelAction(editing?.id ?? null, input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(editing ? "Channel updated" : "Channel created");
      setOpen(false);
      router.refresh();
    });
  }

  const [draftTest, setDraftTest] = useState<{ ok: boolean; text: string } | null>(null);

  /** Sends a test to the channel as the dialog has it, without saving. */
  function sendDraftTest() {
    setError(null);
    setDraftTest(null);
    const input = { name: form.name || undefined, ...(editing ? {} : { type: form.type }), config: configFromForm(form) };
    startTransition(async () => {
      const result = await testAlertChannelDraftAction(editing?.id ?? null, input);
      setDraftTest(result.ok ? { ok: true, text: "Test notification sent. Check that it arrived." } : { ok: false, text: result.error });
    });
  }

  function sendTest(channel: AlertChannelView) {
    setTesting(channel.id);
    startTransition(async () => {
      const result = await testAlertChannelAction(channel.id);
      const at = Date.now();
      setTests((current) => ({
        ...current,
        [channel.id]: result.ok ? { ok: true, text: "delivered", at } : { ok: false, text: result.error, at },
      }));
      setTesting(null);
      if (result.ok) toast.success(`Test notification sent to "${channel.name}"`);
      else toast.error(result.error);
      router.refresh();
    });
  }

  function setEnabled(channel: AlertChannelView, enabled: boolean) {
    startTransition(async () => {
      const result = await setAlertChannelEnabledAction(channel.id, enabled);
      if (!result.ok) toast.error(result.error);
      router.refresh();
    });
  }

  function remove() {
    if (!confirmDelete) return;
    const channel = confirmDelete;
    startTransition(async () => {
      const result = await deleteAlertChannelAction(channel.id);
      if (result.ok) toast.success("Channel deleted");
      else toast.error(result.error);
      setConfirmDelete(null);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {failing.map((channel) => (
        <Banner
          key={channel.id}
          tone="bad"
          title={`${channel.name} could not deliver${channel.lastDeliveryAt ? ` on ${format.dateTime(channel.lastDeliveryAt)}` : ""}: ${channel.lastDeliveryError}`}
          actions={
            canWrite ? (
              <Button variant="outline" size="sm" onClick={() => openEdit(channel)}>
                Edit {channel.name}
              </Button>
            ) : undefined
          }
        >
          Check its settings, then send a test.
        </Banner>
      ))}

      <SectionCard
        title="Channels"
        actions={
          channels.length > 0 && (
            <>
              {channels.length > 0 && (
                <SearchField
                  type="search"
                  aria-label="Search channels"
                  placeholder="Search channels"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(1);
                  }}
                  className="w-full sm:w-56"
                />
              )}
              {canWrite && channels.length > 0 && (
                <Button variant="secondary" size="sm" onClick={openCreate}>
                  <Plus /> Add channel
                </Button>
              )}
            </>
          )
        }
        footer={
          shown.pageCount > 1 ? (
            <Pagination page={shown.page} perPage={shown.perPage} total={shown.total} noun="channels" label="Pages of channels" onPageChange={setPage} />
          ) : undefined
        }
      >
        {channels.length === 0 ? (
          <EmptyState
            compact
            title="No channels yet"
            description="A channel is where alerts are sent: e-mail, Slack, Microsoft Teams, a webhook, PagerDuty or ntfy. Until a rule notifies one, its alerts are only listed in Ingressi."
            action={
              canWrite ? (
                <Button size="sm" onClick={openCreate}>
                  <Plus /> Add channel
                </Button>
              ) : undefined
            }
          />
        ) : shown.items.length === 0 ? (
          <EmptyState compact icon={null} title="No channel matches" />
        ) : (
          <Table className="min-w-[1040px]">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Channel</TableHead>
                <TableHead scope="col">Destination</TableHead>
                <TableHead scope="col">Used by</TableHead>
                <TableHead scope="col">Last delivery</TableHead>
                <TableHead scope="col">Enabled</TableHead>
                {canWrite && (
                  <TableHead scope="col">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.items.map((channel) => {
                const destination = channelDestination(channel);
                const used = usedBy(channel);
                const test = tests[channel.id];
                return (
                  <TableRow key={channel.id} className="align-top">
                    <TableCell className="py-3">
                      <span className="flex flex-col gap-0.5">
                        <span className="font-semibold">{channel.name}</span>
                        <span className="text-xs text-soft">{CHANNEL_TYPE_LABELS[channel.type]}</span>
                      </span>
                    </TableCell>
                    <TableCell className="py-3">
                      <span className="flex max-w-[360px] flex-col gap-0.5">
                        <span className="num [overflow-wrap:anywhere]">{destination.target}</span>
                        <span className="text-xs text-soft [overflow-wrap:anywhere]">{destination.detail}</span>
                      </span>
                    </TableCell>
                    <TableCell className="py-3 whitespace-nowrap">
                      {used === 0 ? <span className="text-muted-foreground">No rule</span> : `${used} rule${used === 1 ? "" : "s"}`}
                    </TableCell>
                    <TableCell className="py-3">
                      <span className="flex flex-col gap-0.5">
                        {channel.lastDeliveryAt ? (
                          channel.lastDeliveryError ? (
                            <>
                              <StatusDot tone="bad" label={<span className="font-semibold">Failed <span className="num font-normal">{format.dateTime(channel.lastDeliveryAt)}</span></span>} />
                              <span className="text-xs text-bad [overflow-wrap:anywhere]">{channel.lastDeliveryError}</span>
                            </>
                          ) : (
                            <StatusDot tone="ok" label={<>Delivered <span className="num">{format.dateTime(channel.lastDeliveryAt)}</span></>} />
                          )
                        ) : (
                          <span className="text-soft">Never</span>
                        )}
                        {test && (
                          <span role="status" className={test.ok ? "text-xs text-ok" : "text-xs text-bad"}>
                            Test sent {format.time(test.at)}: {test.text}
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="py-3">
                      {canWrite ? (
                        <Switch
                          checked={channel.enabled}
                          disabled={pending}
                          onCheckedChange={(checked) => setEnabled(channel, checked)}
                          aria-label={`Enabled: ${channel.name}`}
                        />
                      ) : (
                        <span className="text-muted-foreground">{channel.enabled ? "On" : "Off"}</span>
                      )}
                    </TableCell>
                    {canWrite && (
                      <TableCell className="py-2.5 text-right whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5">
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={pending}
                            onClick={() => sendTest(channel)}
                          >
                            <Send /> {testing === channel.id ? "Sending…" : "Send test"}
                          </Button>
                          <Button
                            variant="link"
                            size="sm"
                            className="px-2"
                            onClick={() => openEdit(channel)}
                            aria-label={`Edit channel ${channel.name}`}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Delete"
                            aria-label={`Delete channel ${channel.name}`}
                            disabled={pending}
                            onClick={() => setConfirmDelete(channel)}
                          >
                            <Trash2 />
                          </Button>
                        </span>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      {digest && <DigestSection settings={digest} channels={channels} aiConfigured={aiConfigured} />}

      <AppDialog
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? `Edit channel "${editing.name}"` : "Add channel"}
        submitLabel={editing ? "Save" : "Create"}
        onSubmit={save}
        isSubmitting={pending}
        maxWidth="md"
        extraAction={
          <Button type="button" variant="outline" onClick={sendDraftTest} disabled={pending}>
            Send test
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Name" htmlFor="channel-name">
            <Input id="channel-name" value={form.name} onChange={(event) => set("name", event.target.value)} maxLength={100} />
          </Field>
          <Field label="Type">
            <Select value={form.type} onValueChange={(value) => set("type", value as ChannelType)} disabled={editing !== null}>
              <SelectTrigger aria-label="Channel type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHANNEL_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {CHANNEL_TYPE_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {form.type === "email" && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <Field label="SMTP server" htmlFor="smtp-host">
                    <Input id="smtp-host" value={form.host} onChange={(event) => set("host", event.target.value)} placeholder="smtp.example.com" />
                  </Field>
                </div>
                <Field label="Port" htmlFor="smtp-port">
                  <Input id="smtp-port" inputMode="numeric" value={form.port} onChange={(event) => set("port", event.target.value)} />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={form.secure} onCheckedChange={(checked) => set("secure", checked)} />
                Implicit TLS (usually port 465)
              </label>
              <div className="grid grid-cols-2 gap-3">
                <Field label="User name" htmlFor="smtp-user">
                  <Input id="smtp-user" autoComplete="off" value={form.user} onChange={(event) => set("user", event.target.value)} />
                </Field>
                <SecretField
                  id="smtp-password"
                  label="Password"
                  value={form.password}
                  stored={stored("hasPassword")}
                  onChange={(value) => set("password", value)}
                  clear={{ checked: form.clearPassword, onChange: (checked) => set("clearPassword", checked), label: "Remove the stored password" }}
                />
              </div>
              <Field label="From" htmlFor="smtp-from">
                <Input id="smtp-from" value={form.from} onChange={(event) => set("from", event.target.value)} placeholder="alerts@example.com" />
              </Field>
              <Field label="To" htmlFor="smtp-to" hint="Up to 20 addresses, separated by commas">
                <Input id="smtp-to" value={form.to} onChange={(event) => set("to", event.target.value)} placeholder="ops@example.com" />
              </Field>
            </>
          )}

          {(form.type === "slack" || form.type === "teams") && (
            <SecretField
              id="webhook-url"
              label={form.type === "slack" ? "Incoming webhook URL" : "Workflows or incoming webhook URL"}
              value={form.webhookUrl}
              stored={stored("hasWebhookUrl")}
              onChange={(value) => set("webhookUrl", value)}
              hint={
                form.type === "slack"
                  ? "In Slack: Apps → Incoming Webhooks."
                  : "A Teams Workflows \"Post to a channel when a webhook request is received\" URL."
              }
            />
          )}

          {form.type === "webhook" && (
            <>
              <SecretField id="webhook-target" label="URL" value={form.url} stored={stored("hasUrl")} onChange={(value) => set("url", value)} hint="Receives a JSON POST for every notification." />
              <SecretField
                id="webhook-hmac"
                label="Signing secret (optional)"
                value={form.hmacSecret}
                stored={stored("hasHmacSecret")}
                onChange={(value) => set("hmacSecret", value)}
                hint={'Adds X-Ingressi-Signature: sha256=HMAC(secret, timestamp + "." + body) and X-Ingressi-Timestamp.'}
                clear={{ checked: form.clearHmacSecret, onChange: (checked) => set("clearHmacSecret", checked), label: "Remove the signing secret" }}
              />
            </>
          )}

          {form.type === "pagerduty" && (
            <>
              <SecretField
                id="pd-key"
                label="Integration (routing) key"
                value={form.routingKey}
                stored={stored("hasRoutingKey")}
                onChange={(value) => set("routingKey", value)}
                hint="The Events API v2 integration key of a PagerDuty service."
              />
              <Field label="Region">
                <Select value={form.region} onValueChange={(value) => set("region", value as "us" | "eu")}>
                  <SelectTrigger aria-label="PagerDuty region">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="us">US (events.pagerduty.com)</SelectItem>
                    <SelectItem value="eu">EU (events.eu.pagerduty.com)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </>
          )}

          {form.type === "ntfy" && (
            <>
              <Field label="Server" htmlFor="ntfy-server">
                <Input id="ntfy-server" value={form.serverUrl} onChange={(event) => set("serverUrl", event.target.value)} />
              </Field>
              <Field label="Topic" htmlFor="ntfy-topic" hint="On public servers anyone who knows the topic can read it; use an access token or a hard-to-guess topic.">
                <Input id="ntfy-topic" value={form.topic} onChange={(event) => set("topic", event.target.value)} />
              </Field>
              <SecretField
                id="ntfy-token"
                label="Access token (optional)"
                value={form.token}
                stored={stored("hasToken")}
                onChange={(value) => set("token", value)}
                clear={{ checked: form.clearToken, onChange: (checked) => set("clearToken", checked), label: "Remove the stored token" }}
              />
            </>
          )}

          <label className="flex items-center gap-2 text-sm">
            <Switch checked={form.enabled} onCheckedChange={(checked) => set("enabled", checked)} />
            Enabled
          </label>
          {draftTest && (
            <Banner tone={draftTest.ok ? "ok" : "bad"} live>
              {draftTest.text}
            </Banner>
          )}
          {error && (
            <Banner tone="bad" live>
              {error}
            </Banner>
          )}
        </div>
      </AppDialog>

      <AppDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title={`Delete channel "${confirmDelete?.name ?? ""}"?`}
        submitLabel="Delete"
        onSubmit={remove}
        isSubmitting={pending}
      >
        <p className="text-sm text-muted-foreground">Rules must stop notifying the channel before it can be deleted.</p>
      </AppDialog>
    </div>
  );
}
