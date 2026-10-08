# Needs attention

The overview lists what needs attention: one line per item, with a severity (critical, warning, info), a detail and the pages that deal with it. `GET /api/v1/overview/attention` returns the same list to any signed-in user; each source answers only for readers who hold one of its permissions, and only with what they may see.

| Source | Permission | Items |
| --- | --- | --- |
| Alerts | `alerts:read` | Every alert open now, except dismissed ones and those of muted rules (they stay on the Alerts page, marked). Every install has [built-in rules](../ee/docs/alerting.md#built-in-rules) for expiring certificates, a failed Caddy apply, server errors, failing upstreams, failed backups and the fleet, so these are most of the list |
| Certificates | `certificates:read` (within the role's tag scope) | Imported certificates that expire within 30 days or have expired; certificates Caddy manages that are missing, do not cover their name, expired, whose renewal is overdue, or that are due for renewal |
| Caddy | `settings:read` | The last apply of the configuration failed |
| Backups | `backups:read` | Backup destinations whose last backup failed |
| Setup | `settings:read` | The [setup checklist](setup-checklist.md) is not complete and not hidden |
| Sign-in | `ldap:read`, `users:read` | LDAP directories that fail their connection check (`ldap:read`; critical after three failed checks in a row), and accounts the MFA policy has locked out until they set up MFA (`users:read`) |
| Approvals | `approvals:read` (the requests the role may see) | Change requests waiting for the reader's approval, for someone else's, or approved and waiting for their change window |
| Your access reviews | none | Items of open access reviews the reader has to decide |
| Access reviews | `access_reviews:read` | Reviews that are overdue or due within 7 days, schedules that could not start |
| Fleet | `fleet:read` or `instances:read` | On a master: instances whose sync failed, that drifted, pull replicas that stopped checking in, and instances on another release |

Each source has four seconds; one that fails or is slow is reported in `sources` and never hides the others. Items are sorted most severe first, then newest first; at most 50 are returned.

The Certificates, Caddy and Backups sources report what the built-in rules report too. For a reader who may read alerts, a source is left out while an enabled rule of its kind (`cert_expiring`, `caddy_apply_failed`, `backup_failed`) watches every host, so each problem is listed once, as an alert. Readers without `alerts:read`, and installs where the rule is disabled or limited to chosen hosts, get the source's items as before.

## Alerts

An alert links to the pages that deal with it that the reader may open: the certificates, the proxy host and its 5xx requests, the hosts that use a failing upstream, the backups, the fleet. A reader with `alerts:write` can dismiss it with the button at the end of its line, for everyone, until it resolves (`POST /api/v1/alert-silences` with its `issue.ruleId` and `issue.subjectKey`); **Undo** right after ends the dismissal. It stays on the Alerts page, marked as dismissed. To dismiss it for a time or mute its rule, use the Alerts page.

When no enabled rule notifies an enabled channel, `notifying` is false and the footer says that alerts are not sent anywhere, with **Add a channel** for readers who may change alerts.

Server errors used to be worked out here from the last 24 hours of traffic, with mitigation spikes and blocked-traffic concentrations. They are no source any more: server errors are alerts of the built-in Error rate rule, which resolve when the error rate is back to normal; blocked traffic is on the [security events](analytics.md) page.

## Adding a source

A source is an `AttentionProvider` (`src/lib/attention/types.ts`): an id, a label, the permissions a reader needs (any of them; none means every signed-in user, and the source then only returns items about the reader), and a `collect` function that returns the items for a reader. Register it with `registerAttentionProvider` (`src/lib/attention/index.ts` registers the built-in ones).
