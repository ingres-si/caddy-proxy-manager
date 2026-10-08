# L4 proxy hosts

An L4 host forwards TCP or UDP traffic that is not HTTP (SSH, mail, DNS over TLS, WireGuard, databases) from a port of its own to services on your network. It can route by TLS server name (SNI) or HTTP Host, terminate TLS, speak the PROXY protocol, balance load over several upstreams with health checks, and apply [geo blocking](geo-blocking.md).

## The list

**Traffic → L4 hosts** lists every L4 host you may see (a custom role limited to tags sees the hosts with one of its tags). Each row shows:

- **Name**, and for a host that routes by TLS SNI or HTTP Host, the first server name it matches and how many more.
- **Listen**: the protocol and the listen address.
- **Upstream**: the first upstream and how many more (hover to see them all).
- **Tags**, when any host has tags ([host tags](host-tags.md)).
- **Status**: *Active*, *Disabled*, or *Port not published* when the host is saved but Caddy cannot receive its traffic yet (see [Ports](#ports)).

Search matches names, listen addresses, upstreams, server names and tags, ignoring case. The protocol filter (TCP or UDP) and the status filter (enabled or disabled) narrow the list; each option shows how many hosts it would list with the search and the other filter. By default, the list is sorted newest first. **Profile → Interface → Default list order** can change the account's initial ordering; an explicit sort in the URL wins. The Name, Listen, Upstream and Status headings sort by that column (on a phone, use the Sort menu). It shows 25 hosts per page, and the page is part of the address, so back, reload and shared links keep it.

Select a host's name (or **Details** in its row menu) to see all its settings: matcher, load balancing, health checks, TLS, PROXY protocol, geo blocking and DNS. From there, or from the row, you can edit, duplicate, enable or disable it.

Select hosts with the checkboxes to enable, disable or delete several at once (deleting asks for a confirmation). Each host goes through the same checks as a change to it alone: your role's tags, the [change approval](../ee/docs/change-approvals.md) policies (a protected host gets a change request instead) and the audit log, which records one event per host. Caddy is applied once for the whole batch.

Links that open the list with something prepared: `/l4-proxy-hosts?search=<text>`, with `&protocol=tcp` or `udp`, and `&status=enabled` or `disabled`.

## Ports

Each L4 host listens on a port of the Caddy container, and Docker publishes a container's ports only when it creates the container. When a host needs a port that is not published yet, the page names it (or counts them, with **Show ports** listing each with its hosts, when there are more than three) and offers **Publish ports now**: the L4 port manager sidecar recreates the Caddy container with the new ports, which interrupts all traffic through Caddy for a few seconds. A port no host uses any more stays published until the container is recreated; the page offers that too. Ports 80, 443 and 2019 are Caddy's own and cannot be used.

## Settings worth knowing

- **Geo blocking** at L4 sees the client's direct address: there is no `X-Forwarded-For` to read, so behind another proxy it sees that proxy. Blocked connections are closed. **Merge** adds the host's rules to the default rules of [Geo blocking](geo-blocking.md); **Override** uses only the host's.
- **Upstream DNS pinning** ([upstream-dns-pinning.md](upstream-dns-pinning.md)) resolves upstream hostnames to addresses when the configuration is applied. *As in Host defaults* follows the default on **Proxy hosts → Host defaults**.

## Permissions and API

The page needs `l4_proxy_hosts:read`; creating, changing, deleting and publishing ports need `l4_proxy_hosts:write` ([custom roles](../ee/docs/custom-roles.md)).

The REST API has the same hosts at `/api/v1/l4-proxy-hosts` (see `/api/v1/openapi.json`).
