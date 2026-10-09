"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { ChipInput, EditorCard, FieldError, TextField, ToggleRow, AddButton, useEditor, useFieldProps } from "./fields";
import { LbFields, UpstreamRows } from "./controls";
import { emptyLb, LB_POLICIES, rowKey, serializeUpstreams, type LocationRuleRow } from "./model";
import { normalizeDomainInput } from "./validate";
import { Input } from "@/components/ui/input";

/** Name and tags: in Routing for a new host (it needs a name first), in Advanced for an existing one. */
export function NameAndTagsCard() {
  const { form, saved, update, data } = useEditor();
  const scope = data.scopeTags;
  return (
    <EditorCard id="name-and-tags" title="Name and tags">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-x-5 gap-y-3">
        <TextField id="f-name" label="Name" value={form.name} onChange={(name) => update((f) => ({ ...f, name }))} placeholder="My service" was="name" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[13px] font-medium leading-5" id="f-tags-title">
            Tags
          </span>
          <ChipInput
            id="f-tags"
            label="Add tags"
            listLabel="Tags"
            values={form.tags}
            onChange={(tags) => update((f) => ({ ...f, tags }))}
            placeholder="Add a tag"
            addLabel="Add tag"
            normalize={(value) => value.trim().toLowerCase()}
            isNew={(tag) => !saved.tags.includes(tag)}
            testId="host-tags"
            hint={
              scope.length > 0
                ? `Your role manages hosts tagged ${scope.join(", ")}: keep at least one of these tags.`
                : "Letters, digits and . _ : / -"
            }
          />
        </div>
      </div>
    </EditorCard>
  );
}

function RouteEditor({ rule, index, onChange, onRemove }: { rule: LocationRuleRow; index: number; onChange: (rule: LocationRuleRow) => void; onRemove: () => void }) {
  const pathProps = useFieldProps(`f-route-${index}-path`);
  return (
    <div className="flex flex-col gap-3 px-5 pb-4 pt-1">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`f-route-${index}-path`} className="text-[13px] font-medium">
          Path
        </label>
        <Input {...pathProps} value={rule.path} placeholder="/api/*" className="num max-w-sm" autoComplete="off" onChange={(event) => onChange({ ...rule, path: event.target.value })} />
        <FieldError id={`f-route-${index}-path`} />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Upstreams</span>
        <UpstreamRows rows={rule.upstreams} onChange={(upstreams) => onChange({ ...rule, upstreams })} idOf={(upstream) => `f-route-${index}-up-${upstream}`} />
      </div>
      <div className="rounded-xl border border-line px-4">
        <ToggleRow
          id={`f-route-${index}-lb-enabled`}
          label="Own load balancing"
          checked={rule.lb.enabled}
          onChange={(enabled) => onChange({ ...rule, lb: { ...rule.lb, enabled } })}
        />
        {rule.lb.enabled && (
          <div className="pb-4">
            <LbFields lb={rule.lb} onChange={(lb) => onChange({ ...rule, lb })} idPrefix={`f-route-${index}-lb`} />
          </div>
        )}
      </div>
      <div>
        <button type="button" onClick={onRemove} className="text-[13px] text-bad underline-offset-4 hover:underline">
          Remove route {rule.path.trim() || index + 1}
        </button>
      </div>
    </div>
  );
}

function routeSummary(rule: LocationRuleRow): string {
  const count = rule.upstreams.filter((row) => row.address.trim()).length;
  const upstreams = `${count} ${count === 1 ? "upstream" : "upstreams"}`;
  if (!rule.lb.enabled) return `${upstreams} · random, no health checks`;
  const policy = LB_POLICIES.find((entry) => entry.value === rule.lb.policy)?.label.toLowerCase() ?? rule.lb.policy;
  return `${upstreams} · own policy: ${policy}${rule.lb.active.enabled ? `, active checks${rule.lb.active.uri ? ` on ${rule.lb.active.uri}` : ""}` : ""}`;
}

function PathRoutesCard() {
  const { form, update, errors } = useEditor();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  // A route with a problem shows its fields, so the problem can be seen and fixed.
  const hasProblem = (index: number) => Object.keys(errors).some((id) => id.startsWith(`f-route-${index}-`));
  const setRules = (recipe: (rules: LocationRuleRow[]) => LocationRuleRow[]) => update((f) => ({ ...f, locationRules: recipe(f.locationRules) }));
  return (
    <EditorCard
      id="f-routes"
      title="Path-based routes"
      was="locationRules"
      actions={
        <AddButton
          onClick={() => {
            const rule: LocationRuleRow = { key: rowKey("loc"), path: "", upstreams: [{ key: rowKey("up"), scheme: "http://", address: "" }], lb: emptyLb() };
            setRules((rules) => [...rules, rule]);
            setOpen((current) => new Set([...current, rule.key]));
          }}
        >
          Add route
        </AddButton>
      }
      flush
    >
      {form.locationRules.length === 0 ? (
        <p className="m-0 px-5 py-4 text-[13px] text-muted-foreground">No path-based routes.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {form.locationRules.map((rule, index) => {
            const expanded = open.has(rule.key) || hasProblem(index);
            const panelId = `route-panel-${rule.key}`;
            return (
              <li key={rule.key} className={cn("border-line", index > 0 && "border-t")}>
                <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 px-5 py-3">
                  <span className="num min-w-0 flex-[0_1_200px] truncate text-[13px]">{rule.path.trim() || "New route"}</span>
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 shrink-0 fill-none stroke-soft" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                  <span className="flex min-w-0 flex-[1_1_240px] flex-col">
                    <span className="num truncate text-[13px]">{serializeUpstreams(rule.upstreams).join(", ") || "No upstream yet"}</span>
                    <span className="text-xs text-soft">{routeSummary(rule)}</span>
                  </span>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={panelId}
                    aria-label={`${expanded ? "Close" : "Edit"} route ${rule.path.trim() || index + 1}`}
                    onClick={() =>
                      setOpen((current) => {
                        const next = new Set(current);
                        if (expanded) next.delete(rule.key);
                        else next.add(rule.key);
                        return next;
                      })
                    }
                    className="h-[30px] rounded-lg px-2.5 text-[13px] text-brand transition-colors hover:bg-raise"
                  >
                    {expanded ? "Close" : "Edit"}
                  </button>
                </div>
                <div id={panelId} hidden={!expanded}>
                  {expanded && (
                    <RouteEditor
                      rule={rule}
                      index={index}
                      onChange={(next) => setRules((rules) => rules.map((current) => (current.key === rule.key ? next : current)))}
                      onRemove={() => setRules((rules) => rules.filter((current) => current.key !== rule.key))}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </EditorCard>
  );
}

export function RoutingSection() {
  const { form, saved, update, data } = useEditor();
  return (
    <>
      {data.mode === "create" && <NameAndTagsCard />}
      <EditorCard
        id="domains"
        title="Domains"
        was="domains"
        description={
          <>
            Wildcards like <span className="num">*.example.com</span> work.
          </>
        }
      >
        <ChipInput
          id="f-domains"
          label="Add domains"
          listLabel="Domains"
          values={form.domains}
          onChange={(domains) => update((f) => ({ ...f, domains }))}
          placeholder="Add a domain, e.g. app.example.com"
          normalize={normalizeDomainInput}
          isNew={(domain) => data.mode === "edit" && !saved.domains.includes(domain)}
        />
      </EditorCard>

      <EditorCard id="upstreams" title="Upstreams" was="upstreams" description="A host and port, such as 10.0.0.5:8080.">
        <UpstreamRows rows={form.upstreams} onChange={(upstreams) => update((f) => ({ ...f, upstreams }))} idOf={(index) => `f-up-${index}`} />
      </EditorCard>

      <EditorCard
        id="load-balancing"
        title="Load balancing"
        was="lb"
        description={form.lb.enabled ? undefined : "Off: a random upstream, without health checks or retries."}
        actions={
          <span className="flex items-center gap-2 text-[13px]">
            <span id="f-lb-enabled-label">Custom load balancing</span>
            <Switch
              id="f-lb-enabled"
              aria-labelledby="f-lb-enabled-label"
              checked={form.lb.enabled}
              onCheckedChange={(enabled) => update((f) => ({ ...f, lb: { ...f.lb, enabled } }))}
            />
          </span>
        }
      >
        {form.lb.enabled && serializeUpstreams(form.upstreams).length === 1 && form.lb.passive.enabled && (
          <p role="note" className="m-0 rounded-[10px] border border-warn/40 bg-warn-tint px-3 py-2.5 text-[13px]">
            <span className="font-semibold">One upstream with passive health checks:</span>{" "}
            {Number(form.lb.passive.maxFails) > 1 ? `${form.lb.passive.maxFails} failed requests take` : "a single failed request takes"} it out of rotation, and
            with no other upstream Caddy refuses every request to this host (503) for {form.lb.passive.failDuration || "the fail duration"}. Turn
            passive health checks off, or add another upstream.
          </p>
        )}
        {form.lb.enabled && <LbFields lb={form.lb} onChange={(lb) => update((f) => ({ ...f, lb }))} idPrefix="f-lb" />}
      </EditorCard>

      <EditorCard id="protocols" title="Protocols">
        <div className="-mt-2 divide-y divide-line">
          <ToggleRow
            id="f-ws"
            label="WebSockets"
            was="allowWebsocket"
            description="The WAF lets WebSocket upgrades through uninspected. WebSockets are proxied either way."
            checked={form.allowWebsocket}
            onChange={(allowWebsocket) => update((f) => ({ ...f, allowWebsocket }))}
          />
          <ToggleRow
            id="f-preserve-host"
            label="Preserve Host header"
            was="preserveHostHeader"
            checked={form.preserveHostHeader}
            onChange={(preserveHostHeader) => update((f) => ({ ...f, preserveHostHeader }))}
          />
          <ToggleRow
            id="f-skip-verify"
            label="Skip upstream certificate check"
            was="skipHttpsHostnameValidation"
            description="Only for an https:// upstream with a self-signed certificate."
            checked={form.skipHttpsHostnameValidation}
            onChange={(skipHttpsHostnameValidation) => update((f) => ({ ...f, skipHttpsHostnameValidation }))}
          />
        </div>
      </EditorCard>

      <PathRoutesCard />
    </>
  );
}
