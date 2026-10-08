"use client";

/**
 * The L4 host editor: tabs for Routing, Load balancing, Security and
 * Advanced (each linkable as #routing …) and a bar at the bottom that counts
 * unsaved changes and saves them, laid out like the proxy host editor.
 *
 * On an L4 host's page (`workspace`) the same tab bar also holds the page's
 * Overview and History: switching tabs never leaves the page, unsaved changes
 * survive the switch, and the bar shows up only once something changed.
 * /l4-proxy-hosts/new uses it on its own.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { INITIAL_ACTION_STATE } from "@/lib/actions";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Switch } from "@/components/ui/switch";
import { policiesCovering } from "@/ee/approvals/match";
import type { HostApprovalContext } from "@/ee/approvals/types";
import type { L4ProxyHost } from "@/src/lib/models/l4-proxy-hosts";
import { createL4ProxyHostAction, updateL4ProxyHostAction } from "@/app/(dashboard)/l4-proxy-hosts/actions";
import { FieldsProvider } from "@/src/components/proxy-hosts/editor/fields";
import { TabAnchor } from "@/src/components/proxy-hosts/editor/TabAnchor";
import { useLeaveGuard } from "@/src/components/hosts/useLeaveGuard";
import {
  copyL4Form,
  isL4SectionId,
  l4FieldOfServerError,
  l4FormChanges,
  l4FormData,
  l4HostToForm,
  L4_SECTION_LABELS,
  L4_SECTIONS,
  nameSectionOf,
  newL4Form,
  validateL4Form,
  type L4FieldErrors,
  type L4Form,
  type L4SectionId,
} from "./model";
import { AdvancedSection, LoadBalancingSection, RoutingSection, SecuritySection, type L4SectionProps } from "./sections";

/** Cards that can be linked to directly (#upstreams), and the tab they are in. */
const CARD_SECTIONS: Record<string, L4SectionId> = {
  listener: "routing",
  upstreams: "routing",
  matching: "routing",
  "tls-and-proxy-protocol": "routing",
  "geo-blocking": "security",
  "dns-resolvers": "advanced",
  "upstream-dns-pinning": "advanced",
};

export type L4EditorData = {
  /** The host being changed; null for a new one. */
  host: L4ProxyHost | null;
  /** A host to start a new one from (Duplicate). */
  template: L4ProxyHost | null;
  /** The tags the user's role is limited to, if any. */
  scopeTags: string[];
  /** Change approval policies (ee/approvals), to say before saving that the host is protected. */
  approval: HostApprovalContext | null;
};

/** A tab of an L4 host's page: its overview, a tab of the editor, or its history. */
export type L4WorkspaceTab = "overview" | L4SectionId | "history";

/** What an L4 host's page puts around the editor. */
export type L4Workspace = {
  /** The page header, with the tab bar to put under it. */
  header: (tabs: ReactNode) => ReactNode;
  overview: ReactNode;
  /** The host's changes; null without audit_log:read (no History tab). */
  history: ReactNode | null;
  historyCount: number | null;
};

type Done = { kind: "saved" | "submitted"; title: string; text: string; href?: string; link?: string };

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const noSubscription = () => () => {};

function initialForm(data: L4EditorData): L4Form {
  if (data.host) return l4HostToForm(data.host);
  if (data.template) return copyL4Form(data.template, data.scopeTags);
  return newL4Form(data.scopeTags);
}

export function L4HostEditor({ data, workspace }: { data: L4EditorData; workspace?: L4Workspace }) {
  const router = useRouter();
  const hydrated = useSyncExternalStore(noSubscription, () => true, () => false);
  const creating = data.host === null;
  const nameSection = nameSectionOf(creating);
  const blank = useMemo(() => (creating ? newL4Form(data.scopeTags) : null), [creating, data.scopeTags]);
  const [saved, setSaved] = useState<L4Form>(() => initialForm(data));
  const [form, setForm] = useState<L4Form>(saved);
  const [view, setView] = useState<L4WorkspaceTab>(workspace ? "overview" : "routing");
  const section: L4SectionId = isL4SectionId(view) ? view : "routing";
  const [showAllErrors, setShowAllErrors] = useState(false);
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [serverErrors, setServerErrors] = useState<L4FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const pendingFocus = useRef<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const sectionHeading = useRef<HTMLHeadingElement>(null);

  // The host changed under the page (enabled from the header, a save, another tab): the
  // saved state follows it, and so does the form when nothing in it was changed.
  const hostVersion = data.host?.updatedAt ?? null;
  const lastVersion = useRef(hostVersion);
  useEffect(() => {
    if (!data.host || hostVersion === lastVersion.current) return;
    lastVersion.current = hostVersion;
    const next = l4HostToForm(data.host);
    setForm((current) => (JSON.stringify(current) === JSON.stringify(saved) ? next : current));
    setSaved(next);
    // saved is read only to compare with the form at this moment.
  }, [hostVersion, data.host]);

  const changes = useMemo(() => l4FormChanges(blank ?? saved, form, nameSection), [blank, saved, form, nameSection]);
  const count = changes.length;
  const dirty = creating || count > 0;
  const validation = useMemo(() => validateL4Form(form, nameSection), [form, nameSection]);
  const visibleErrors = useMemo(() => {
    const out: L4FieldErrors = { ...serverErrors };
    for (const [id, error] of Object.entries(validation)) if (showAllErrors || touched.has(id)) out[id] = error;
    return out;
  }, [serverErrors, validation, showAllErrors, touched]);
  const errorCount = Object.keys(validation).length + Object.keys(serverErrors).length;

  const covering = useMemo(() => {
    if (!data.approval || data.approval.policies.length === 0) return [];
    const tags = [...new Set([...saved.tags, ...form.tags])];
    return policiesCovering(data.approval.policies, "l4_proxy_host", tags, [creating ? "create" : "update"]);
  }, [data.approval, saved.tags, form.tags, creating]);

  const update = useCallback((recipe: (current: L4Form) => L4Form) => {
    setForm((current) => recipe(current));
    setDone(null);
    setSubmitError(null);
    setServerErrors({});
  }, []);

  const touch = useCallback((id: string) => {
    setTouched((current) => (current.has(id) ? current : new Set([...current, id])));
  }, []);

  // Tabs are linkable: #routing, #security … (or a card id inside one).
  const selectFromHash = useCallback(() => {
    const hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    if (!hash) {
      if (workspace) setView("overview");
      return;
    }
    if (workspace && (hash === "overview" || (hash === "history" && workspace.history))) {
      setView(hash);
      return;
    }
    if (isL4SectionId(hash)) {
      setView(hash);
      return;
    }
    const owner = hash === "name-and-tags" ? nameSection : CARD_SECTIONS[hash];
    if (owner) {
      setView(owner);
      pendingFocus.current = hash;
      setFocusTick((tick) => tick + 1);
    }
  }, [workspace, nameSection]);

  useEffect(() => {
    selectFromHash();
    window.addEventListener("hashchange", selectFromHash);
    return () => window.removeEventListener("hashchange", selectFromHash);
  }, [selectFromHash]);

  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    pendingFocus.current = null;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.focus({ preventScroll: true });
  }, [view, focusTick]);

  const goTo = useCallback((next: L4WorkspaceTab, focusId?: string) => {
    setView(next);
    const url = new URL(window.location.href);
    url.hash = next === "overview" ? "" : next;
    window.history.replaceState(window.history.state, "", url.toString());
    pendingFocus.current = focusId ?? null;
    if (focusId) setFocusTick((tick) => tick + 1);
    else requestAnimationFrame(() => sectionHeading.current?.focus());
  }, []);

  useLeaveGuard(dirty && !done && !(creating && count === 0));

  const firstError = useCallback((): { id: string; section: L4SectionId } | null => {
    const entries = Object.entries({ ...validation, ...serverErrors });
    if (entries.length === 0) return null;
    entries.sort(([, a], [, b]) => L4_SECTIONS.indexOf(a.section) - L4_SECTIONS.indexOf(b.section));
    return { id: entries[0][0], section: entries[0][1].section };
  }, [validation, serverErrors]);

  const save = useCallback(async () => {
    if (Object.keys(validation).length > 0) {
      setShowAllErrors(true);
      setAnnouncement(`Fix ${plural(Object.keys(validation).length, "problem")} before saving.`);
      const first = firstError();
      if (first) goTo(first.section, first.id);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    // An existing host's on/off switch is the page header's: it is not sent with the form.
    const formData = l4FormData(form, { enabled: creating });
    const result = await (creating ? createL4ProxyHostAction(INITIAL_ACTION_STATE, formData) : updateL4ProxyHostAction(data.host!.id, INITIAL_ACTION_STATE, formData)).catch(
      () => ({ status: "error" as const, message: "The server did not answer. Nothing was saved.", changeRequest: undefined, id: undefined })
    );
    setSubmitting(false);
    if (result.status === "error") {
      const message = result.message ?? "The host could not be saved.";
      const field = l4FieldOfServerError(message, nameSection);
      if (field) {
        setServerErrors({ [field.id]: { message, section: field.section } });
        setAnnouncement(`Not saved: ${message}`);
        goTo(field.section, field.id);
      } else {
        setSubmitError(message);
      }
      return;
    }
    if (result.changeRequest) {
      const applied = result.changeRequest.status === "applied";
      if (applied && !creating) setSaved(form);
      setDone(
        applied
          ? { kind: "saved", title: "Applied as an emergency change", text: "The audit log records it.", href: "/audit-log", link: "Open the audit log" }
          : { kind: "submitted", title: "Change request submitted for approval", text: result.message ?? "Submitted for approval.", href: "/approvals", link: "Open in Approvals" }
      );
      setAnnouncement(result.message ?? "Submitted for approval.");
      router.refresh();
      return;
    }
    if (creating) {
      setSaved(form);
      setAnnouncement(result.message ?? "L4 host created.");
      // Stored while Caddy did not take it: the host's page opens, and this says why it is not live.
      if (result.message?.startsWith("Saved, but not live yet")) toast.warning(result.message, { duration: 15000 });
      router.push(result.id ? `/l4-proxy-hosts/${result.id}` : "/l4-proxy-hosts");
      return;
    }
    setSaved(form);
    setDone({ kind: "saved", title: "Saved", text: result.message ?? "L4 host saved." });
    setAnnouncement(result.message ?? "L4 host saved.");
    router.refresh();
  }, [validation, firstError, goTo, form, creating, data.host, nameSection, router]);

  // Ctrl/Cmd+S saves.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (dirty && !submitting) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, submitting, save]);

  const perSection = new Map<L4SectionId, number>();
  for (const change of changes) perSection.set(change.section, (perSection.get(change.section) ?? 0) + 1);
  const errorsPerSection = new Map<L4SectionId, number>();
  for (const error of Object.values(visibleErrors)) errorsPerSection.set(error.section, (errorsPerSection.get(error.section) ?? 0) + 1);

  const sectionProps: L4SectionProps = { form, saved: blank ?? saved, update, nameSection, scopeTags: data.scopeTags };
  const sections: Record<L4SectionId, ReactNode> = {
    routing: <RoutingSection {...sectionProps} />,
    "load-balancing": <LoadBalancingSection {...sectionProps} />,
    security: <SecuritySection {...sectionProps} />,
    advanced: <AdvancedSection {...sectionProps} />,
  };

  const tabBar = (
    <nav aria-label={workspace ? "Host sections" : "Host settings"} data-host-tabs="" data-hydrated={hydrated ? "true" : undefined}>
      <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line">
        {workspace && (
          <TabAnchor id="overview" current={view === "overview"} onSelect={() => goTo("overview")}>
            Overview
          </TabAnchor>
        )}
        {L4_SECTIONS.map((id) => {
          const changed = perSection.get(id) ?? 0;
          const problems = errorsPerSection.get(id) ?? 0;
          return (
            <TabAnchor key={id} id={id} current={view === id} onSelect={() => goTo(id)}>
              {L4_SECTION_LABELS[id]}
              {problems > 0 ? (
                <span className="num rounded-full bg-bad-tint px-1.5 text-[11px] font-semibold leading-[18px] text-bad">
                  {problems}
                  <span className="sr-only"> {problems === 1 ? "problem" : "problems"}</span>
                </span>
              ) : changed > 0 ? (
                <span className="num rounded-full bg-brand-tint px-1.5 text-[11px] font-semibold leading-[18px] text-brand">
                  {changed}
                  <span className="sr-only"> unsaved {changed === 1 ? "change" : "changes"}</span>
                </span>
              ) : null}
            </TabAnchor>
          );
        })}
        {workspace?.history && (
          <TabAnchor id="history" current={view === "history"} onSelect={() => goTo("history")}>
            History
            {workspace.historyCount !== null && workspace.historyCount > 0 && (
              <span className="num rounded-full bg-raise px-1.5 text-[11px] leading-[18px] text-muted-foreground">{workspace.historyCount}</span>
            )}
          </TabAnchor>
        )}
      </div>
    </nav>
  );

  const barTitle = creating ? (count > 0 ? `New L4 host · ${plural(count, "setting")} set` : "New L4 host") : count === 0 ? "No unsaved changes" : plural(count, "unsaved change");
  const barText =
    submitError ??
    (covering.length > 0 && (creating || count > 0) ? (creating ? "Creating it sends a change request for approval." : "Saving sends them for approval.") : null);
  const showBar = !workspace || count > 0 || submitting || done !== null;
  const saveLabel = covering.length > 0 ? "Submit for approval" : creating ? "Create host" : "Save";

  return (
    <FieldsProvider value={{ errors: visibleErrors, touch, wasOf: () => null }}>
      <div className={cn("flex flex-col gap-5", showBar && "pb-36 md:pb-28")}>
        {workspace ? (
          workspace.header(tabBar)
        ) : (
          <PageHeader
            className="mb-0"
            breadcrumb={["Traffic", { label: "L4 hosts", href: "/l4-proxy-hosts" }, "New L4 host"]}
            title={data.template ? `Copy of ${data.template.name}` : "New L4 host"}
            actions={
              <>
                <span className="flex h-[38px] items-center gap-2.5 rounded-[10px] border border-line bg-panel px-3 text-[13px]">
                  <span className="font-semibold">{form.enabled ? "Enabled" : "Disabled"}</span>
                  <Switch aria-label="Host enabled" checked={form.enabled} onCheckedChange={(enabled) => update((f) => ({ ...f, enabled }))} />
                </span>
                <Button asChild variant="outline" className="h-[38px]">
                  <Link href="/l4-proxy-hosts">Cancel</Link>
                </Button>
              </>
            }
          >
            {covering.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border border-line2 px-2.5 text-xs text-muted-foreground">
                  <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5 text-warn" />
                  {covering[0].name}
                  {covering.length > 1 ? ` and ${covering.length - 1} more` : ""} {covering.length > 1 ? "policies" : "policy"} · changes need approval
                </span>
              </div>
            )}
            {tabBar}
          </PageHeader>
        )}

        {data.template && (
          <Banner tone="info" title={`A copy of ${data.template.name}.`}>
            Hosts on the same port need different matchers: change the listen address or the matcher before creating it.
          </Banner>
        )}

        {workspace && covering.length > 0 && isL4SectionId(view) && (
          <Banner tone="info" icon={null} title={`Changes to this host need approval (${covering.map((policy) => policy.name).join(", ")}).`}>
            Saving sends them as a change request.
          </Banner>
        )}

        {view === "overview" && workspace ? (
          workspace.overview
        ) : view === "history" && workspace?.history ? (
          workspace.history
        ) : (
          <div className="flex min-w-0 flex-col gap-5" role="tabpanel">
            <h2 ref={sectionHeading} tabIndex={-1} className="sr-only">
              {L4_SECTION_LABELS[section]}
            </h2>
            {sections[section]}
          </div>
        )}
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {showBar && (
        <div className="fixed inset-x-3 bottom-[calc(68px_+_env(safe-area-inset-bottom))] z-30 flex flex-col gap-2 md:bottom-4 md:left-[calc(15.5rem_+_max(2rem,_(100vw_-_15.5rem_-_1600px)_/_2_+_2rem))] md:right-[max(2rem,_calc((100vw_-_15.5rem_-_1600px)_/_2_+_2rem))]">
          <div
            data-testid="host-editor-bar"
            data-hydrated={hydrated ? "true" : undefined}
            className={cn("flex flex-wrap items-center gap-x-3.5 gap-y-2.5 rounded-2xl border bg-panel px-4 py-3 shadow-overlay", count > 0 || creating ? "border-line2" : "border-line")}
          >
            {done ? (
              <>
                <span className="flex min-w-0 flex-[1_1_320px] items-start gap-2.5">
                  <CheckCircle2 aria-hidden="true" className={cn("mt-px h-[18px] w-[18px] shrink-0", done.kind === "saved" ? "text-ok" : "text-warn")} />
                  <span className="flex flex-col gap-0.5">
                    <span className="font-semibold">{done.title}</span>
                    <span className="text-[13px] text-muted-foreground">{done.text}</span>
                  </span>
                </span>
                <span className="flex flex-wrap gap-2">
                  <Button type="button" variant="ghost" onClick={() => setDone(null)}>
                    Keep editing
                  </Button>
                  {done.href && done.link ? (
                    <Button asChild variant="secondary">
                      <Link href={done.href}>{done.link}</Link>
                    </Button>
                  ) : workspace ? (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        setDone(null);
                        goTo("overview");
                      }}
                    >
                      Show overview
                    </Button>
                  ) : null}
                </span>
              </>
            ) : (
              <>
                <span className="flex min-w-0 flex-[1_1_260px] items-center gap-2.5">
                  <span
                    aria-hidden="true"
                    className={cn("h-2 w-2 shrink-0 rounded-full", submitError || (errorCount > 0 && showAllErrors) ? "bg-bad" : count > 0 || creating ? "bg-brand" : "bg-ok")}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="font-semibold">{barTitle}</span>
                    {(barText || (showAllErrors && errorCount > 0)) && (
                      <span className={cn("text-[13px]", submitError ? "text-bad" : "text-soft")}>
                        {showAllErrors && errorCount > 0 && !submitError ? (
                          <button
                            type="button"
                            className="text-bad underline-offset-4 hover:underline"
                            onClick={() => {
                              const first = firstError();
                              if (first) goTo(first.section, first.id);
                            }}
                          >
                            {plural(errorCount, "problem")} to fix before saving. Show the first
                          </button>
                        ) : (
                          barText
                        )}
                      </span>
                    )}
                  </span>
                </span>
                <span className="flex flex-wrap gap-2">
                  {!creating && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={count === 0 || submitting}
                      onClick={() => {
                        setForm(saved);
                        setServerErrors({});
                        setShowAllErrors(false);
                        setSubmitError(null);
                        setAnnouncement("Changes discarded.");
                      }}
                    >
                      Discard
                    </Button>
                  )}
                  <Button type="button" disabled={!dirty || submitting} onClick={() => void save()}>
                    {submitting ? "Saving…" : saveLabel}
                  </Button>
                </span>
              </>
            )}
          </div>
        </div>
      )}
    </FieldsProvider>
  );
}
