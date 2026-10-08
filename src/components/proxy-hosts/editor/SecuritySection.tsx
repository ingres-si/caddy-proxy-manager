"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RATE_LIMIT_KEYS, RATE_LIMIT_KEY_LABELS, RATE_LIMIT_LIMITS, RATE_LIMIT_METHODS, type RateLimitKey } from "@/lib/rate-limit-rules";
import { appendQuickTemplate, HOST_TEMPLATE_ID_OFFSET, WAF_QUICK_TEMPLATES } from "@/lib/waf-quick-templates";
import type { WafHostMode } from "@/lib/waf-host-mode";
import { AddButton, EditorCard, Field, FieldError, RemoveButton, TextField, ToggleRow, WasHint, useEditor, useFieldProps } from "./fields";
import { NativeSelect, SegmentedField, SelectField } from "./controls";
import { rateLimitRow, type RateLimitRuleRow, type WafForm } from "./model";
import { GeoBlockCard } from "./GeoBlockCard";

const GLOBAL_MODE = { On: "blocking", DetectionOnly: "detection only", Off: "off" } as const;

function WafModePicker() {
  const { form, update, data } = useEditor();
  const global = data.wafGlobal;
  const globalLabel = global ? GLOBAL_MODE[global.mode] : "blocking";
  const modes: { value: WafHostMode; label: string; description?: string; dot: string }[] = [
    {
      value: "inherit",
      label: "Global mode",
      // The global settings may cover only hosts that pick a mode: then inheriting means no WAF.
      description: global?.appliesToAll === false && !data.host?.waf ? "Off: the WAF settings cover only hosts that pick a mode." : `Currently ${globalLabel}.`,
      dot: "bg-soft",
    },
    { value: "off", label: "Off", dot: "bg-soft" },
    { value: "detection_only", label: "Detect only", description: "Logs matches, blocks nothing.", dot: "bg-warn" },
    { value: "block", label: "Block", description: "Requests over the anomaly threshold get 403.", dot: "bg-waf" },
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <span id="f-waf-mode-label" className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
        Mode
        <WasHint group="waf" />
      </span>
      <div
        id="f-waf-mode"
        tabIndex={-1}
        role="group"
        aria-labelledby="f-waf-mode-label"
        className="grid grid-cols-[repeat(auto-fit,minmax(min(180px,100%),1fr))] gap-1 rounded-xl border border-line bg-background p-1"
      >
        {modes.map((mode) => {
          const pressed = form.waf.mode === mode.value;
          return (
            <button
              key={mode.value}
              type="button"
              aria-pressed={pressed}
              onClick={() => update((f) => ({ ...f, waf: { ...f.waf, mode: mode.value } }))}
              className={cn(
                "flex flex-col gap-1 rounded-[9px] border px-3 py-2.5 text-left transition-colors",
                pressed ? "border-line2 bg-raise" : "border-transparent hover:bg-panel2"
              )}
            >
              <span className={cn("flex items-center gap-2 font-semibold", pressed ? "text-foreground" : "text-muted-foreground")}>
                <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", mode.dot)} />
                {mode.label}
              </span>
              {mode.description && <span className="text-xs leading-[17px] text-muted-foreground">{mode.description}</span>}
            </button>
          );
        })}
      </div>
      <FieldError id="f-waf-mode" />
    </div>
  );
}

function WafCard() {
  const { form, update, data } = useEditor();
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const setWaf = (patch: Partial<WafForm>) => update((f) => ({ ...f, waf: { ...f.waf, ...patch } }));
  const directivesProps = useFieldProps("f-waf-directives", true);
  // An overriding host takes nothing from the global settings: unset values are Coraza's own.
  const defaultLabel = form.waf.rules === "override" ? "Coraza default" : "Global default";
  const eventsHref = data.canReadWaf && data.host ? `/waf/events?search=${encodeURIComponent(data.host.domains[0] ?? data.host.name)}` : null;
  return (
    <EditorCard
      id="waf"
      title="Web application firewall"
      actions={
        <span className="flex flex-wrap gap-3 text-[13px]">
          {eventsHref && (
            <Link href={eventsHref} className="text-brand underline-offset-4 hover:underline">
              Security events for this host
            </Link>
          )}
          {data.canReadWaf && (
            <Link href="/waf" className="text-brand underline-offset-4 hover:underline">
              WAF settings
            </Link>
          )}
        </span>
      }
    >
      <WafModePicker />
      {form.waf.mode !== "off" && (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-x-5 gap-y-3.5">
            <SegmentedField
              id="f-waf-rules"
              label="Rules for this host"
              value={form.waf.rules}
              onChange={(rules) => setWaf({ rules })}
              options={[
                { value: "merge", label: "Merge with global" },
                { value: "override", label: "Override global" },
              ]}
              hint={form.waf.rules === "override" ? "Global exclusions and directives do not apply." : undefined}
            />
            <ToggleRow
              id="f-waf-crs"
              className="py-0"
              label="OWASP Core Rule Set"
              description="The common attack rules most hosts need."
              checked={form.waf.loadCrs}
              onChange={(loadCrs) => setWaf({ loadCrs })}
            />
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(190px,100%),1fr))] gap-x-4 gap-y-3">
            <TextField id="f-waf-body" label="Max request body, MiB" value={form.waf.bodyLimit} onChange={(bodyLimit) => setWaf({ bodyLimit })} placeholder={defaultLabel} inputMode="numeric" mono />
            <TextField id="f-waf-memory" label="Buffered in memory, MiB" value={form.waf.bodyMemory} onChange={(bodyMemory) => setWaf({ bodyMemory })} placeholder={defaultLabel} inputMode="numeric" mono />
            <SelectField id="f-waf-action" label="Larger bodies" value={form.waf.bodyAction} onChange={(value) => setWaf({ bodyAction: value as WafForm["bodyAction"] })}>
              <option value="inherit">{defaultLabel}</option>
              <option value="Reject">Reject with 413</option>
              <option value="ProcessPartial">Inspect the first part, pass the rest</option>
            </SelectField>
          </div>
          <p className="-mt-2 m-0 text-xs text-soft">With the Core Rule Set the WAF reads at most 12.5 MiB of a body unless you raise it, up to 1024 MiB.</p>
          <Field
            id="f-waf-directives"
            label="Custom SecLang directives"
            was="wafDirectives"
            hint={`Added after the Core Rule Set. Use rule ids from ${9000 + HOST_TEMPLATE_ID_OFFSET} up for your own rules.`}
          >
            <Textarea
              {...directivesProps}
              value={form.wafDirectives}
              onChange={(event) => update((f) => ({ ...f, wafDirectives: event.target.value }))}
              rows={3}
              spellCheck={false}
              placeholder={'SecRule REQUEST_URI "@beginsWith /internal" "id:9101,deny,status:403,log"'}
              className="num min-h-[72px] text-xs leading-[18px]"
            />
          </Field>
          <div>
            <button
              type="button"
              aria-expanded={templatesOpen}
              aria-controls="waf-templates"
              onClick={() => setTemplatesOpen((open) => !open)}
              className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
            >
              Quick templates
              <ChevronDown aria-hidden="true" className={cn("h-4 w-4 transition-transform", templatesOpen && "rotate-180")} />
            </button>
            <div id="waf-templates" hidden={!templatesOpen} className="mt-2">
              <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
                {WAF_QUICK_TEMPLATES.map((template) => (
                  <li key={template.label}>
                    <button
                      type="button"
                      onClick={() => update((f) => ({ ...f, wafDirectives: appendQuickTemplate(f.wafDirectives, template, HOST_TEMPLATE_ID_OFFSET) }))}
                      className="rounded-lg border border-line2 bg-panel2 px-2.5 py-1 text-xs transition-colors hover:bg-raise"
                    >
                      Add: {template.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </>
      )}
    </EditorCard>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function ExclusionsCard() {
  const { form, saved, update, data, touch } = useEditor();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recordOf = (ruleId: number) => data.wafExclusions.find((exclusion) => exclusion.wholeHost && exclusion.ruleId === ruleId);
  const scoped = data.wafExclusions.filter((exclusion) => !exclusion.wholeHost);
  const add = () => {
    const id = Number(draft.trim());
    if (!Number.isInteger(id) || id < 1 || id > 2_147_483_647) {
      setError("Enter a rule id, such as 920540.");
      return;
    }
    setError(null);
    setDraft("");
    if (!form.wafExcluded.includes(id)) update((f) => ({ ...f, wafExcluded: [...f.wafExcluded, id].sort((a, b) => a - b) }));
  };
  return (
    <EditorCard
      id="f-waf-exclusions"
      title="Rule exclusions"
      was="wafExcluded"
      flush
    >
      {form.wafExcluded.length === 0 && scoped.length === 0 ? (
        <p className="m-0 px-5 py-3.5 text-[13px] text-muted-foreground">No excluded rules.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-xs text-soft">
                <th scope="col" className="px-5 py-2 font-medium">Rule</th>
                <th scope="col" className="px-2.5 py-2 font-medium">What it matches</th>
                <th scope="col" className="px-2.5 py-2 font-medium">Excluded</th>
                <th scope="col" className="py-2 pl-2.5 pr-5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {form.wafExcluded.map((ruleId) => {
                const record = recordOf(ruleId);
                const fresh = !saved.wafExcluded.includes(ruleId);
                return (
                  <tr key={ruleId} className={cn("border-b border-line last:border-b-0", fresh && "bg-brand-tint")}>
                    <td className="px-5 py-2.5">
                      <span className="num rounded bg-raise px-1.5 text-xs leading-[18px] text-muted-foreground">{ruleId}</span>
                    </td>
                    <td className="px-2.5 py-2.5">{data.wafRuleMessages[ruleId] ?? "Core Rule Set rule"}</td>
                    <td className={cn("px-2.5 py-2.5 text-xs", fresh ? "text-brand" : "text-soft")}>
                      {fresh ? "Not saved yet" : record ? [record.createdBy, formatDate(record.createdAt)].filter(Boolean).join(" · ") : "Whole host"}
                    </td>
                    <td className="py-1.5 pl-2.5 pr-4 text-right">
                      <RemoveButton label={`Remove exclusion of rule ${ruleId}`} onClick={() => update((f) => ({ ...f, wafExcluded: f.wafExcluded.filter((id) => id !== ruleId) }))} />
                    </td>
                  </tr>
                );
              })}
              {scoped.map((exclusion) => (
                <tr key={`scoped-${exclusion.id}`} className="border-b border-line last:border-b-0">
                  <td className="px-5 py-2.5">
                    <span className="num rounded bg-raise px-1.5 text-xs leading-[18px] text-muted-foreground">{exclusion.ruleId}</span>
                  </td>
                  <td className="px-2.5 py-2.5">
                    {data.wafRuleMessages[exclusion.ruleId] ?? "Core Rule Set rule"}
                    <span className="block text-xs text-soft">
                      Only {[exclusion.path && `${exclusion.pathMatch === "prefix" ? "paths under" : "path"} ${exclusion.path}`, exclusion.variable && `variable ${exclusion.variable}`].filter(Boolean).join(", ")}
                    </span>
                  </td>
                  <td className="px-2.5 py-2.5 text-xs text-soft">{[exclusion.createdBy, formatDate(exclusion.createdAt)].filter(Boolean).join(" · ")}</td>
                  <td className="py-2.5 pl-2.5 pr-5 text-right text-xs">
                    {data.canReadWaf ? (
                      <Link href="/waf#exclusions" className="text-brand underline-offset-4 hover:underline">
                        Edit in WAF settings
                      </Link>
                    ) : (
                      <span className="text-soft">WAF settings</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-col gap-1 border-t border-line px-5 pb-4 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="f-waf-exclude" className="sr-only">
            Rule id to exclude
          </label>
          <Input
            id="f-waf-exclude"
            value={draft}
            inputMode="numeric"
            placeholder="Rule id, e.g. 920540"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "f-waf-exclude-error" : "f-waf-exclude-hint"}
            className="num h-8 w-[200px]"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => touch("f-waf-exclude")}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
          />
          <button type="button" onClick={add} className="h-8 rounded-lg border border-line2 bg-panel2 px-3 text-[13px] transition-colors hover:bg-raise">
            Exclude rule
          </button>
          <span id="f-waf-exclude-hint" className="text-xs text-soft">
            Exclusions for one path or variable are made in the WAF settings.
          </span>
        </div>
        {error && (
          <p id="f-waf-exclude-error" className="m-0 text-xs text-bad">
            {error}
          </p>
        )}
      </div>
    </EditorCard>
  );
}

const UNIT_LABELS = { s: "seconds", m: "minutes", h: "hours" } as const;

function RateLimitRuleEditor({ rule, index, onChange, onRemove }: { rule: RateLimitRuleRow; index: number; onChange: (rule: RateLimitRuleRow) => void; onRemove: () => void }) {
  const eventsProps = useFieldProps(`f-rl-${index}-events`);
  const windowProps = useFieldProps(`f-rl-${index}-window`);
  const title = `Rule ${index + 1}`;
  return (
    <li className="flex flex-col gap-3 border-t border-line px-5 py-3.5" aria-label={title} data-testid="rate-limit-rule">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] items-start gap-x-4 gap-y-3">
        <TextField id={`f-rl-${index}-path`} label="Path" value={rule.path} onChange={(path) => onChange({ ...rule, path })} placeholder="Every path, or /login, /api/*" mono />
        <SelectField id={`f-rl-${index}-key`} label="Counted by" value={rule.by} onChange={(value) => onChange({ ...rule, by: value as RateLimitKey })}>
          {RATE_LIMIT_KEYS.map((key) => (
            <option key={key} value={key}>
              {RATE_LIMIT_KEY_LABELS[key]}
            </option>
          ))}
        </SelectField>
        {rule.by === "header" && (
          <TextField id={`f-rl-${index}-header`} label="Header" value={rule.header} onChange={(header) => onChange({ ...rule, header })} placeholder="X-Api-Key" mono />
        )}
      </div>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`f-rl-${index}-events`} className="text-[13px] font-medium">
            Requests
          </label>
          <Input {...eventsProps} value={rule.events} inputMode="numeric" className="num w-24" onChange={(event) => onChange({ ...rule, events: event.target.value })} />
        </div>
        <span className="pb-2 text-[13px] text-muted-foreground">per</span>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`f-rl-${index}-window`} className="text-[13px] font-medium">
            Window
          </label>
          <span className="flex gap-2">
            <Input {...windowProps} value={rule.windowValue} inputMode="numeric" className="num w-20" onChange={(event) => onChange({ ...rule, windowValue: event.target.value })} />
            <NativeSelect aria-label={`${title} window unit`} value={rule.windowUnit} className="w-[110px]" onChange={(event) => onChange({ ...rule, windowUnit: event.target.value as RateLimitRuleRow["windowUnit"] })}>
              {(Object.keys(UNIT_LABELS) as RateLimitRuleRow["windowUnit"][]).map((unit) => (
                <option key={unit} value={unit}>
                  {UNIT_LABELS[unit]}
                </option>
              ))}
            </NativeSelect>
          </span>
        </div>
        <span className="ml-auto">
          <RemoveButton label={`Remove rate limit rule ${index + 1}`} onClick={onRemove} />
        </span>
      </div>
      <FieldError id={`f-rl-${index}-events`} />
      <FieldError id={`f-rl-${index}-window`} />
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label={`${title} methods`}>
        {RATE_LIMIT_METHODS.map((method) => {
          const active = rule.methods.includes(method);
          return (
            <button
              key={method}
              type="button"
              aria-pressed={active}
              onClick={() => onChange({ ...rule, methods: active ? rule.methods.filter((m) => m !== method) : [...rule.methods, method] })}
              className={cn(
                "num rounded-md border px-2 py-0.5 text-[11px] transition-colors",
                active ? "border-brand bg-brand-tint text-foreground" : "border-line2 text-muted-foreground hover:text-foreground"
              )}
            >
              {method}
            </button>
          );
        })}
        <span className="ml-1 text-xs text-soft">{rule.methods.length === 0 ? "Every method" : ""}</span>
      </div>
    </li>
  );
}

function RateLimitCard() {
  const { form, update, data } = useEditor();
  const rate = form.rateLimit;
  const mode = rate.enabled ? rate.mode : "off";
  const defaults = data.rateLimitDefaults;
  const globalRules = defaults?.enabled ? defaults.rules : 0;
  // What is easy to get wrong: "Off" still applies the global defaults, and an override without rules limits nothing.
  const note =
    mode === "off"
      ? globalRules > 0
        ? `Off: the ${globalRules === 1 ? "global default rule applies" : `${globalRules} global default rules apply`}.`
        : undefined
      : mode === "override"
        ? "Only these rules apply; with none, nothing is limited."
        : undefined;
  const userKeyWithoutSignIn = form.signIn !== "ingressi" && rate.rules.some((rule) => rule.by === "forward_auth_user");
  const setRules = (recipe: (rules: RateLimitRuleRow[]) => RateLimitRuleRow[]) => update((f) => ({ ...f, rateLimit: { ...f.rateLimit, rules: recipe(f.rateLimit.rules) } }));
  return (
    <EditorCard id="rate-limiting" title="Rate limiting" was="rateLimit" description={note} flush={mode !== "off"}>
      <div className={cn(mode !== "off" && "px-5 pb-4 pt-3")}>
        <SegmentedField
          id="f-rl-mode"
          label="Mode"
          value={mode}
          onChange={(value) =>
            update((f) => ({
              ...f,
              rateLimit: value === "off" ? { ...f.rateLimit, enabled: false } : { ...f.rateLimit, enabled: true, mode: value },
            }))
          }
          options={[
            { value: "off", label: "Off" },
            { value: "merge", label: "Merge with global" },
            { value: "override", label: "Override global" },
          ]}
        />
      </div>
      {mode !== "off" && (
        <>
          {rate.rules.length > 0 && (
            <ol className="m-0 list-none p-0">
              {rate.rules.map((rule, index) => (
                <RateLimitRuleEditor
                  key={rule.key}
                  rule={rule}
                  index={index}
                  onChange={(next) => setRules((rules) => rules.map((current) => (current.key === rule.key ? next : current)))}
                  onRemove={() => setRules((rules) => rules.filter((current) => current.key !== rule.key))}
                />
              ))}
            </ol>
          )}
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-line px-5 pb-4 pt-3">
            <AddButton onClick={() => setRules((rules) => [...rules, rateLimitRow()])} disabled={rate.rules.length >= RATE_LIMIT_LIMITS.maxRules}>
              Add rule
            </AddButton>
            {userKeyWithoutSignIn && (
              <span className="text-xs text-warn">Counting by signed-in user needs the built-in sign-in on this host; until then it counts by client IP.</span>
            )}
          </div>
        </>
      )}
    </EditorCard>
  );
}

export function SecuritySection() {
  return (
    <>
      <WafCard />
      <ExclusionsCard />
      <RateLimitCard />
      <GeoBlockCard />
    </>
  );
}
