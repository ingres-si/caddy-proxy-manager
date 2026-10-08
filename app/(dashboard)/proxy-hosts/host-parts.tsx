"use client";

/**
 * Pieces of a proxy host shared by the list and the host's page: its
 * status, protection pills, certificate and tags.
 */
import { StatusDot, type StatusTone } from "@/components/ui/StatusDot";
import { ProtectionPill } from "@/components/ui/ProtectionPill";
import { formatDayUtc } from "@/components/ui/chart-format";
import { cn } from "@/lib/utils";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import {
  RENEWAL_LABELS,
  attentionLabel,
  certificateTone,
  type HostCertificate,
  type HostListRow,
  type HostProtection,
} from "@/src/lib/proxy-host-view";

export type HostStatusView = { tone: StatusTone; label: string; detail: string | null };

/** The status of a host in words: the first thing that needs attention, or its state. */
export function useHostStatus(row: Pick<HostListRow, "state" | "attention" | "pendingChangeRequestId">): HostStatusView {
  const format = useFormat();
  const time = (ms: number) => format.time(ms);
  switch (row.state) {
    case "disabled":
      return { tone: "off", label: "Disabled", detail: null };
    case "attention": {
      const [first, ...rest] = row.attention;
      return {
        tone: first.tone,
        label: attentionLabel(first, time),
        detail: rest.length > 0 ? rest.map((item) => attentionLabel(item, time)).join("; ") : null,
      };
    }
    case "pending":
      return { tone: "info", label: "Waiting for approval", detail: null };
    default:
      return { tone: "ok", label: "No issues", detail: null };
  }
}

export function HostStatus({ row, className }: { row: HostListRow; className?: string }) {
  const status = useHostStatus(row);
  const dot = <StatusDot tone={status.tone} label={status.label} className={cn("whitespace-nowrap", className)} />;
  return (
    <span className="flex flex-col gap-0.5" title={status.detail ?? undefined}>
      {dot}
      {status.detail && <span className="text-xs text-soft">and {row.attention.length - 1} more</span>}
    </span>
  );
}

export function ProtectionPills({ protections, className }: { protections: readonly HostProtection[]; className?: string }) {
  if (protections.length === 0) return <span className="text-soft">None</span>;
  return (
    <span className={cn("flex flex-wrap gap-1", className)}>
      {protections.map((protection, index) => (
        <ProtectionPill key={`${protection.key}-${index}`} kind={protection.kind} label={protection.label} title={protection.title} />
      ))}
    </span>
  );
}

const TONE_TEXT: Record<ReturnType<typeof certificateTone>, string> = {
  ok: "text-foreground",
  warn: "font-semibold text-warn",
  bad: "font-semibold text-bad",
  off: "text-soft",
};

/** Days left and issuer, or how the host gets its certificate when the reader may not read certificates. */
export function CertificateSummary({ certificate }: { certificate: HostCertificate }) {
  if (!certificate.visible) {
    return (
      <span className="flex flex-col">
        <span>{certificate.automatic ? "Automatic" : "Chosen certificate"}</span>
        <span className="text-xs text-soft">{certificate.automatic ? "Obtained by Caddy" : "Set on the host"}</span>
      </span>
    );
  }
  const tone = certificateTone(certificate);
  let headline: string;
  if (certificate.renewal === "expired") headline = "Expired";
  else if (certificate.daysLeft !== null) headline = `${certificate.daysLeft} ${certificate.daysLeft === 1 ? "day" : "days"}`;
  else if (certificate.renewal === "inactive") headline = "Host disabled";
  else headline = "Not read yet";
  const issuer = certificate.issuer ?? (certificate.kind === "imported" ? "Imported" : "ACME");
  const parts = [issuer];
  if (certificate.validTo) parts.push(formatDayUtc(Date.parse(certificate.validTo)));
  const renewal = ["due", "overdue", "replace_soon"].includes(certificate.renewal) ? RENEWAL_LABELS[certificate.renewal] : null;
  return (
    <span className="flex flex-col">
      <span className={TONE_TEXT[tone]}>{headline}</span>
      <span className="whitespace-nowrap text-xs text-soft">
        {parts.join(" · ")}
        {renewal && <span className={cn(certificate.renewal === "overdue" ? "text-bad" : "text-warn")}> · {renewal}</span>}
      </span>
    </span>
  );
}

export function TagChips({ tags, onSelect }: { tags: readonly string[]; onSelect?: (tag: string) => void }) {
  if (tags.length === 0) return <span className="text-soft">–</span>;
  return (
    <span className="flex flex-wrap gap-1" data-testid="host-tag-badges">
      {tags.map((tag) =>
        onSelect ? (
          <button
            key={tag}
            type="button"
            onClick={() => onSelect(tag)}
            title={`Show hosts tagged ${tag}`}
            className="num rounded bg-raise px-1.5 text-[11px] leading-[18px] text-muted-foreground hover:text-foreground"
          >
            {tag}
          </button>
        ) : (
          <span key={tag} className="num rounded bg-raise px-1.5 text-[11px] leading-[18px] text-muted-foreground">
            {tag}
          </span>
        )
      )}
    </span>
  );
}
