# Needs attention

The overview lists what needs attention: one line per item, with a severity (critical, warning, info), a detail and the pages that deal with it. `GET /api/v1/overview/attention` returns the same list to any signed-in user; each source answers only for readers who hold one of its permissions, and only with what they may see.

| Source | Permission | Items |
| --- | --- | --- |
| Certificates | `certificates:read` (within the role's tag scope) | Imported certificates that expire within 30 days or have expired; certificates Caddy manages that are missing, do not cover their name, expired, whose renewal is overdue, or that are due for renewal |
| Caddy | `settings:read` | The last apply of the configuration failed |
| Setup | `settings:read` | The [setup checklist](setup-checklist.md) is not complete and not hidden |
| Traffic | `analytics:read` | From the last 24 hours of [analytics](analytics.md#needs-attention): 5xx bursts (critical while still going on, a warning once over), mitigation spikes (a warning at ten times the usual, information below) and blocked-traffic concentrations (information) |
| Sign-in | `ldap:read`, `users:read` | LDAP directories that fail their connection check (`ldap:read`; critical after three failed checks in a row), and accounts the MFA policy has locked out until they set up MFA (`users:read`) |
| Alerts | `alerts:read` | Every alert firing now, except dismissed ones and those of muted rules (they stay on the Alerts page, marked) |
| Approvals | `approvals:read` (the requests the role may see) | Change requests waiting for the reader's approval, for someone else's, or approved and waiting for their change window |
| Your access reviews | none | Items of open access reviews the reader has to decide |
| Access reviews | `access_reviews:read` | Reviews that are overdue or due within 7 days, schedules that could not start |
| Fleet | `fleet:read` or `instances:read` | On a master: instances whose sync failed, that drifted, pull replicas that stopped checking in, and instances on another release |
| Backups | `backups:read` | Backup destinations whose last backup failed |

Each source has four seconds; one that fails or is slow is reported in `sources` and never hides the others. Items are sorted most severe first, then newest first; at most 50 are returned.

Traffic items link to the proxy host's page when the reader may open it, otherwise to the analytics with the host and the matching filters (`/analytics?range=24h&filters=[…]`, the filters of the analytics API as JSON), and items about blocked requests also to the matching security events for readers of the WAF (`/security?range=24h&kind=geo&filters=[…]#events`). Their times are in UTC. The traffic signals are read from ClickHouse at most every 30 seconds, so the overview and this list share one reading. Traffic items are not alerts: they are worked out from the analytics each time the list is read, nothing is sent anywhere, and they do not appear on the Alerts page. To be notified, and to have them listed under **Firing**, add an alert rule (for example *Error rate* or *WAF block spike*, [alerting](../ee/docs/alerting.md)).

## Dismissing items

Traffic items can be dismissed with the button at the end of their line: the item is hidden from your own list for 24 hours, or until it becomes more severe (a mitigation spike that turns into a warning, a 5xx burst that is going on again). Other users still see it. Right after dismissing you can undo it; the footer of the list counts the items you dismissed and lists them all again with **Show dismissed**. Items of the other sources stay until what they report is dealt with (alerts are dismissed on the [Alerts](../ee/docs/alerting.md) page).

`POST /api/v1/overview/attention/dismissals` with `{"source": "traffic", "id": "<item id>"}` dismisses an item listed for the caller (`dismissible` is true on it); `GET` lists the caller's dismissals, and `DELETE` with `?source=&id=`, or without them for all, lists them again. `GET /api/v1/overview/attention` leaves dismissed items out and returns how many in `dismissed`.

## Adding a source

A source is an `AttentionProvider` (`src/lib/attention/types.ts`): an id, a label, the permissions a reader needs (any of them; none means every signed-in user, and the source then only returns items about the reader), a `collect` function that returns the items for a reader, and `dismissible: true` when readers may hide its items. Register it with `registerAttentionProvider` (`src/lib/attention/index.ts` registers the built-in ones).
