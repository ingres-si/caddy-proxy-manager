import { notFound } from "next/navigation";
import { requirePermission } from "@/src/lib/auth";
import { can, scopeTagsFor } from "@/src/lib/permissions";
import { findL4ProxyHostInScope } from "@/src/lib/access-scope";
import { loadHostChanges } from "@/src/lib/proxy-host-detail";
import { parseRowId } from "@/src/lib/row-ids";
import { getHostApprovalContext } from "@/ee/approvals/requests";
import L4HostPageClient from "./L4HostPageClient";

export const metadata = { title: "L4 host" };

export default async function L4HostPage({ params }: { params: Promise<{ id: string }> }) {
  const { access } = await requirePermission("l4_proxy_hosts:read");
  const { id } = await params;
  // 404 for a host outside the role's tag scope, as for a missing one.
  const hostId = parseRowId(id);
  const host = hostId === null ? null : await findL4ProxyHostInScope(access, hostId);
  if (!host) notFound();

  const canWrite = can(access, "l4_proxy_hosts:write");
  const scope = scopeTagsFor(access, "l4_proxy_hosts");
  const [changes, approval] = await Promise.all([
    loadHostChanges(access, "l4_proxy_host", host.id).catch(() => ({ total: 0, entries: [] })),
    canWrite ? getHostApprovalContext(access) : Promise.resolve(null),
  ]);

  return (
    <L4HostPageClient
      host={host}
      canWrite={canWrite}
      changes={changes}
      // Roles that may change L4 hosts get the editor's tabs on this page.
      editor={canWrite ? { host, template: null, scopeTags: scope ? [...scope] : [], approval } : null}
    />
  );
}
