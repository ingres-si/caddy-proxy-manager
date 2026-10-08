"use client";

import Link from "next/link";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import type { HostChangeEntry } from "@/src/lib/proxy-host-detail";
import { SectionCard } from "@/components/ui/SectionCard";
import { DiffView } from "@/components/ui/DiffView";
import { historyVersionHref } from "@/app/(dashboard)/proxy-hosts/links";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function ChangeEntry({ entry }: { entry: HostChangeEntry }) {
  const format = useFormat();
  return (
    <li className="flex flex-col gap-2 border-b border-line px-[18px] py-3 last:border-b-0">
      <span className="text-[13px]">
        <span className="font-semibold">{entry.actor ?? "System"}</span> <span className="text-muted-foreground">{entry.summary}</span>
      </span>
      {entry.fields && entry.fields.length > 0 && <DiffView fields={entry.fields} label={`What "${entry.summary}" changed`} />}
      {entry.moreFields > 0 && <span className="text-xs text-soft">and {plural(entry.moreFields, "more field")}</span>}
      <span className="flex flex-wrap gap-3 text-xs text-soft">
        <time dateTime={entry.createdAt} title={format.dateTime(entry.createdAt)} suppressHydrationWarning>
          {format.relative(entry.createdAt)}
        </time>
        {entry.rollbackVersionId !== null && (
          <Link href={historyVersionHref(entry.rollbackVersionId)} className="text-brand underline-offset-4 hover:underline">
            Roll back
          </Link>
        )}
      </span>
    </li>
  );
}

/** The History tab of a host's page: its recent changes with what they changed, and a link to all of them in the audit log. */
export function HostChanges({ changes, auditHref }: { changes: { total: number; entries: HostChangeEntry[] }; auditHref: string }) {
  return (
    <SectionCard title="Changes to this host" count={changes.total > 0 ? changes.total : null} link={{ label: "Open in the audit log", href: auditHref }}>
      {changes.entries.length === 0 ? (
        <p className="m-0 px-[18px] py-3.5 text-[13px] text-soft">No changes recorded yet.</p>
      ) : (
        <ol className="m-0 list-none p-0">
          {changes.entries.map((entry) => (
            <ChangeEntry key={entry.id} entry={entry} />
          ))}
        </ol>
      )}
    </SectionCard>
  );
}
