import L4ProxyHostsClient from "./L4ProxyHostsClient";
import { listL4ProxyHosts } from "@/src/lib/models/l4-proxy-hosts";
import { requirePermission } from "@/src/lib/auth";
import { can, scopeTagsFor } from "@/src/lib/permissions";
import { getHostApprovalContext } from "@/ee/approvals/requests";
import { buildL4ListView, parseL4ListQuery } from "./list";
import { getUserPreferences } from "@/src/lib/preferences";
import { parseStoredSortPreference } from "@/src/lib/list-sort-preferences";

export const metadata = { title: "L4 hosts" };

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function L4ProxyHostsPage({ searchParams }: PageProps) {
  const { access, user } = await requirePermission("l4_proxy_hosts:read");
  // A tag scope limits the list (and the counts) to hosts with one of the role's tags.
  const scope = scopeTagsFor(access, "l4_proxy_hosts");
  const [params, preferences] = await Promise.all([searchParams, getUserPreferences(Number(user.id))]);
  const query = parseL4ListQuery(params, parseStoredSortPreference(preferences.l4ProxyHostsSort));

  // Filtered, counted, sorted and paged in memory: the counts of each filter
  // follow the search and the other filter.
  const all = await listL4ProxyHosts(scope);
  const view = buildL4ListView(all, query);

  return (
    <L4ProxyHostsClient
      hosts={view.page.items}
      totalHosts={all.length}
      pagination={{ total: view.page.total, page: view.page.page, perPage: view.page.perPage }}
      query={{ ...query, page: view.page.page }}
      protocolCounts={view.protocolCounts}
      statusCounts={view.statusCounts}
      showTags={all.some((host) => host.tags.length > 0)}
      canWrite={can(access, "l4_proxy_hosts:write")}
      scopeTags={scope ? [...scope] : []}
      approval={await getHostApprovalContext(access)}
    />
  );
}
