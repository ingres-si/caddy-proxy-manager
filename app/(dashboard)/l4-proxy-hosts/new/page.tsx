import { requirePermission } from "@/src/lib/auth";
import { scopeTagsFor } from "@/src/lib/permissions";
import { findL4ProxyHostInScope } from "@/src/lib/access-scope";
import { parseRowId } from "@/src/lib/row-ids";
import { getHostApprovalContext } from "@/ee/approvals/requests";
import { L4HostEditor } from "@/src/components/l4-proxy-hosts/editor/L4HostEditor";

export const metadata = { title: "New L4 host" };

type PageProps = { searchParams: Promise<{ from?: string }> };

/** The L4 host editor for a new host; ?from=<id> starts from a copy of that host. */
export default async function NewL4HostPage({ searchParams }: PageProps) {
  const { access } = await requirePermission("l4_proxy_hosts:write");
  const { from } = await searchParams;
  const templateId = parseRowId(from);
  // A host outside the role's scope is not copied (as if it did not exist).
  const template = templateId ? await findL4ProxyHostInScope(access, templateId) : null;
  const scope = scopeTagsFor(access, "l4_proxy_hosts");
  return <L4HostEditor data={{ host: null, template, scopeTags: scope ? [...scope] : [], approval: await getHostApprovalContext(access) }} />;
}
