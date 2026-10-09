// SPDX-License-Identifier: Elastic-2.0
"use client";

import { HostMultiPicker } from "@/src/components/hosts/HostPicker";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AppDialog } from "@/components/ui/AppDialog";
import { Banner } from "@/components/ui/Banner";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  CHANNEL_TYPE_LABELS,
  DEFAULT_RULE_PARAMS,
  FOR_DURATION_RULE_TYPES,
  MAX_SCOPE_HOSTS,
  RULE_TYPE_DESCRIPTIONS,
  RULE_TYPE_LABELS,
  RULE_TYPES,
  SCOPED_RULE_TYPES,
  type AlertChannelView,
  type AlertRuleView,
  type RuleType,
} from "@/ee/alerting/types";
import { saveAlertRuleAction } from "./actions";

export type HostChoice = { id: number; name: string; domains?: string[] };

type ScopeKind = "all" | "hosts";

type Form = {
  name: string;
  type: RuleType;
  enabled: boolean;
  days: string;
  includeClientCertificates: boolean;
  includeManagedCertificates: boolean;
  minFails: string;
  threshold: string;
  windowMinutes: string;
  minFailures: string;
  thresholdPercent: string;
  minRequests: string;
  perHost: boolean;
  scope: ScopeKind;
  proxyHostIds: number[];
  forMinutes: string;
  channelIds: number[];
  cooldownMinutes: string;
  notifyOnResolve: boolean;
  explain: boolean;
};

function defaultForm(type: RuleType = "cert_expiring"): Form {
  return {
    name: "",
    type,
    enabled: true,
    days: String(DEFAULT_RULE_PARAMS.cert_expiring.days),
    includeClientCertificates: true,
    includeManagedCertificates: true,
    minFails: String(DEFAULT_RULE_PARAMS.upstream_down.minFails),
    threshold: String(DEFAULT_RULE_PARAMS.waf_spike.threshold),
    windowMinutes: String(type === "error_rate" ? DEFAULT_RULE_PARAMS.error_rate.windowMinutes : DEFAULT_RULE_PARAMS.waf_spike.windowMinutes),
    minFailures: String(DEFAULT_RULE_PARAMS.backup_failed.minFailures),
    thresholdPercent: String(DEFAULT_RULE_PARAMS.error_rate.thresholdPercent),
    minRequests: String(DEFAULT_RULE_PARAMS.error_rate.minRequests),
    perHost: true,
    scope: "all",
    proxyHostIds: [],
    forMinutes: "0",
    channelIds: [],
    cooldownMinutes: "60",
    notifyOnResolve: true,
    explain: false,
  };
}

function formFromRule(rule: AlertRuleView): Form {
  const params = rule.params as Record<string, unknown>;
  const base = defaultForm(rule.type);
  const text = (value: unknown, fallback: string) => (value !== undefined && value !== null ? String(value) : fallback);
  return {
    ...base,
    name: rule.name,
    enabled: rule.enabled,
    days: text(params.days, base.days),
    includeClientCertificates: params.includeClientCertificates !== false,
    includeManagedCertificates: params.includeManagedCertificates !== false,
    minFails: text(params.minFails, base.minFails),
    threshold: text(params.threshold, base.threshold),
    windowMinutes: text(params.windowMinutes, base.windowMinutes),
    minFailures: text(params.minFailures, base.minFailures),
    thresholdPercent: text(params.thresholdPercent, base.thresholdPercent),
    minRequests: text(params.minRequests, base.minRequests),
    perHost: params.perHost !== false,
    scope: rule.scope.type,
    proxyHostIds: rule.scope.type === "hosts" ? rule.scope.proxyHostIds : [],
    forMinutes: String(rule.forMinutes ?? 0),
    channelIds: rule.channelIds,
    cooldownMinutes: String(rule.cooldownMinutes),
    notifyOnResolve: rule.notifyOnResolve,
    explain: rule.explain,
  };
}

function paramsFromForm(form: Form): Record<string, unknown> {
  switch (form.type) {
    case "cert_expiring":
      return { days: Number(form.days), includeClientCertificates: form.includeClientCertificates, includeManagedCertificates: form.includeManagedCertificates };
    case "error_rate":
      return { thresholdPercent: Number(form.thresholdPercent), windowMinutes: Number(form.windowMinutes), minRequests: Number(form.minRequests), perHost: form.perHost };
    case "upstream_down":
      return { minFails: Number(form.minFails) };
    case "waf_spike":
      return { threshold: Number(form.threshold), windowMinutes: Number(form.windowMinutes) };
    case "backup_failed":
      return { minFailures: Number(form.minFailures) };
    default:
      return {};
  }
}

function NumberField({ id, label, value, onChange, hint, suffix }: { id: string; label: string; value: string; onChange: (value: string) => void; hint?: string; suffix?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input id={id} inputMode="decimal" className="num" value={value} onChange={(event) => onChange(event.target.value)} />
        {suffix && <span className="shrink-0 text-[13px] text-muted-foreground">{suffix}</span>}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SwitchRow({ id, checked, onChange, disabled, children }: { id: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-px" />
      <Label htmlFor={id} className="text-sm font-normal leading-5">
        {children}
      </Label>
    </div>
  );
}

const SCOPE_HINTS: Partial<Record<RuleType, string>> = {
  cert_expiring: "CA and client certificates belong to no host: only a rule for all hosts covers them.",
};

type Props = {
  open: boolean;
  /** The rule to edit; null creates one. */
  rule: AlertRuleView | null;
  onClose: () => void;
  channels: AlertChannelView[];
  proxyHosts: HostChoice[];
  aiConfigured: boolean;
};

/**
 * Creates or edits an alert rule: condition, parameters, scope, "for"
 * duration, channels and notices. Mount it with a new key for each opening:
 * the form starts from `rule`.
 */
export default function RuleEditor({ open, rule, onClose, channels, proxyHosts, aiConfigured }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState<Form>(() => (rule ? formFromRule(rule) : defaultForm()));
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((previous) => ({ ...previous, [key]: value }));
  const scoped = SCOPED_RULE_TYPES.includes(form.type);
  const forDuration = FOR_DURATION_RULE_TYPES.includes(form.type);
  const hostNames = useMemo(() => new Map(proxyHosts.map((host) => [host.id, host.name])), [proxyHosts]);

  function changeType(type: RuleType) {
    setForm((previous) => ({ ...defaultForm(type), name: previous.name, channelIds: previous.channelIds, enabled: previous.enabled }));
  }

  function toggleChannel(id: number, checked: boolean) {
    setForm((previous) => ({
      ...previous,
      channelIds: checked ? [...new Set([...previous.channelIds, id])] : previous.channelIds.filter((existing) => existing !== id),
    }));
  }


  function save() {
    setError(null);
    if (scoped && form.scope === "hosts" && form.proxyHostIds.length === 0) {
      setError("Choose at least one proxy host, or watch all hosts.");
      return;
    }
    const input = {
      name: form.name,
      ...(rule ? {} : { type: form.type }),
      enabled: form.enabled,
      params: paramsFromForm(form),
      channelIds: form.channelIds,
      cooldownMinutes: Number(form.cooldownMinutes),
      ...(scoped ? { scope: form.scope === "hosts" ? { type: "hosts", proxyHostIds: form.proxyHostIds } : { type: "all" } } : {}),
      ...(forDuration ? { forMinutes: Number(form.forMinutes) } : {}),
      notifyOnResolve: form.notifyOnResolve,
      explain: form.explain,
    };
    startTransition(async () => {
      const result = await saveAlertRuleAction(rule?.id ?? null, input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(rule ? "Rule updated" : "Rule created");
      onClose();
      router.refresh();
    });
  }

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={rule ? `Edit rule "${rule.name}"` : "New rule"}
      submitLabel={rule ? "Save" : "Create"}
      onSubmit={save}
      isSubmitting={pending}
      maxWidth="lg"
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rule-name">Name</Label>
          <Input id="rule-name" value={form.name} onChange={(event) => set("name", event.target.value)} maxLength={100} placeholder="What the rule is for" />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rule-type">Condition</Label>
          <Select value={form.type} onValueChange={(value) => changeType(value as RuleType)} disabled={rule !== null}>
            <SelectTrigger id="rule-type" aria-label="Rule type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RULE_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {RULE_TYPE_LABELS[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{RULE_TYPE_DESCRIPTIONS[form.type]}</p>
          {rule && <p className="text-xs text-soft">The condition cannot be changed; create a new rule instead.</p>}
        </div>

        {form.type === "cert_expiring" && (
          <NumberField id="rule-days" label="Days before expiry" value={form.days} onChange={(value) => set("days", value)} suffix="days" />
        )}
        {form.type === "cert_expiring" && (
          <div className="flex flex-col gap-2.5">
            <SwitchRow id="rule-client-certs" checked={form.includeClientCertificates} onChange={(checked) => set("includeClientCertificates", checked)}>
              Include issued client certificates
            </SwitchRow>
            <SwitchRow id="rule-managed-certs" checked={form.includeManagedCertificates} onChange={(checked) => set("includeManagedCertificates", checked)}>
              Include the certificates Caddy obtains
            </SwitchRow>
          </div>
        )}
        {form.type === "error_rate" && (
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField id="rule-threshold-percent" label="5xx above" value={form.thresholdPercent} onChange={(value) => set("thresholdPercent", value)} suffix="%" />
            <NumberField id="rule-error-window" label="Within" value={form.windowMinutes} onChange={(value) => set("windowMinutes", value)} suffix="min" />
            <NumberField id="rule-min-requests" label="At least" value={form.minRequests} onChange={(value) => set("minRequests", value)} suffix="requests" />
          </div>
        )}
        {form.type === "upstream_down" && (
          <NumberField
            id="rule-min-fails"
            label="Recent failures"
            value={form.minFails}
            onChange={(value) => set("minFails", value)}
            hint="Only counted on hosts with passive health checks."
          />
        )}
        {form.type === "backup_failed" && (
          <NumberField id="rule-min-failures" label="Failures in a row" value={form.minFailures} onChange={(value) => set("minFailures", value)} />
        )}
        {form.type === "waf_spike" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField id="rule-threshold" label="Blocked requests" value={form.threshold} onChange={(value) => set("threshold", value)} />
            <NumberField id="rule-window" label="Within" value={form.windowMinutes} onChange={(value) => set("windowMinutes", value)} suffix="min" />
          </div>
        )}

        {scoped && (
          // A group, not a fieldset: Safari draws a flex fieldset's top border broken around its legend.
          <div role="group" aria-labelledby="rule-scope-title" className="flex flex-col gap-2.5 rounded-xl border border-line p-3.5">
            <span id="rule-scope-title" className="text-sm font-medium">
              Scope
            </span>
            <SegmentedControl
              size="sm"
              label="Hosts the rule watches"
              value={form.scope}
              onChange={(value) => set("scope", value)}
              options={[
                { value: "all", label: "All hosts" },
                { value: "hosts", label: "Chosen hosts" },
              ]}
            />
            {form.scope === "hosts" && (
              <div className="flex flex-col gap-2">
                {proxyHosts.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">There are no proxy hosts yet.</p>
                ) : (
                  <HostMultiPicker
                    hosts={proxyHosts}
                    value={form.proxyHostIds}
                    max={MAX_SCOPE_HOSTS}
                    onChange={(proxyHostIds) => setForm((previous) => ({ ...previous, proxyHostIds }))}
                  />
                )}
                {form.proxyHostIds.some((id) => !hostNames.has(id)) && (
                  <p className="m-0 text-xs text-muted-foreground">Some chosen hosts are not listed: they were deleted or are outside your scope.</p>
                )}
              </div>
            )}
            {SCOPE_HINTS[form.type] && <p className="text-xs text-muted-foreground">{SCOPE_HINTS[form.type]}</p>}
            {form.type === "error_rate" && (
              <SwitchRow id="rule-per-host" checked={form.perHost} onChange={(checked) => set("perHost", checked)}>
                One alert per proxy host, instead of one for all of them
              </SwitchRow>
            )}
          </div>
        )}

        {forDuration && (
          <NumberField
            id="rule-for-minutes"
            label="Fire after the condition held for"
            value={form.forMinutes}
            onChange={(value) => set("forMinutes", value)}
            suffix="min"
            hint="0 fires at once."
          />
        )}

        <div className="flex flex-col gap-1.5">
          <Label>Notify</Label>
          {channels.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              No channels yet: its alerts are listed on the Open tab and under Needs attention only. Add a channel on the Channels tab.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {channels.map((channel) => (
                <label key={channel.id} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={form.channelIds.includes(channel.id)} onCheckedChange={(checked) => toggleChannel(channel.id, checked === true)} />
                  {channel.name} <span className="text-xs text-muted-foreground">{CHANNEL_TYPE_LABELS[channel.type]}</span>
                </label>
              ))}
              {form.channelIds.length === 0 && (
                <p className="text-xs text-muted-foreground">None chosen: its alerts are listed in Ingressi only.</p>
              )}
            </div>
          )}
        </div>

        <div className="grid items-end gap-3 sm:grid-cols-2">
          <NumberField id="rule-cooldown" label="Cooldown" value={form.cooldownMinutes} onChange={(value) => set("cooldownMinutes", value)} suffix="min" />
          <div className="pb-2">
            <SwitchRow id="rule-notify-resolve" checked={form.notifyOnResolve} onChange={(checked) => set("notifyOnResolve", checked)}>
              Send a notice when it clears
            </SwitchRow>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <SwitchRow id="rule-explain" checked={form.explain} onChange={(checked) => set("explain", checked)}>
            Add an AI-generated explanation
          </SwitchRow>
          {!aiConfigured && <p className="pl-[42px] text-xs text-muted-foreground">Set up a provider in AI settings first.</p>}
        </div>

        <SwitchRow id="rule-enabled" checked={form.enabled} onChange={(checked) => set("enabled", checked)}>
          Enabled
        </SwitchRow>

        {error && (
          <Banner tone="bad" live>
            {error}
          </Banner>
        )}
      </div>
    </AppDialog>
  );
}
