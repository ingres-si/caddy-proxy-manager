import { notFound } from "next/navigation";
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { findProxyHostInScope } from "@/src/lib/access-scope";
import { getAccessList } from "@/src/lib/models/access-lists";
import { loadHostDetail } from "@/src/lib/proxy-host-detail";
import HostDetailClient from "./HostDetailClient";
import { loadHostEditorData } from "../editor-data";
import { parseRowId } from "@/src/lib/row-ids";

export const metadata = { title: "Proxy host" };

export default async function ProxyHostPage({ params }: { params: Promise<{ id: string }> }) {
  const { access } = await requirePermission("proxy_hosts:read");
  const { id } = await params;
  // 404 for a host outside the role's tag scope, as for a missing one.
  const hostId = parseRowId(id);
  const host = hostId === null ? null : await findProxyHostInScope(access, hostId);
  if (!host) notFound();

  // The host's own access list is named, as in the host form's picker.
  const accessList = host.accessListId !== null ? await getAccessList(host.accessListId).catch(() => null) : null;
  const canWrite = can(access, "proxy_hosts:write");
  const [detail, editor] = await Promise.all([
    loadHostDetail(access, host, {
      accessListNames: accessList ? new Map([[accessList.id, accessList.name]]) : undefined,
    }),
    // Roles that may change hosts get the editor's sections as tabs of this page.
    canWrite ? loadHostEditorData(access, { host, template: null, initialDomain: null }) : Promise.resolve(null),
  ]);

  return (
    <HostDetailClient
      host={{ id: host.id, name: host.name, domains: host.domains, enabled: host.enabled, tags: host.tags }}
      detail={detail}
      can={{
        write: canWrite,
        analytics: can(access, "analytics:read"),
        alerts: can(access, "alerts:read"),
        certificates: can(access, "certificates:read"),
        auditLog: can(access, "audit_log:read"),
        approvals: can(access, "approvals:read"),
        security: can(access, "waf:read"),
      }}
      editor={editor}
    />
  );
}
