# Alerting

What needs fixing, as alerts: certificates about to expire or failing renewal, failing upstreams, WAF block spikes, 5xx error rates, failed instance syncs, failed Caddy config applies, failing scheduled backups, drifted fleet instances and failed fleet rollouts. Every install watches most of these out of the box with [built-in rules](#built-in-rules); what they find is listed on the **Alerts** page and under **Needs attention** on the overview until it is fixed, and is sent to the channels you add. Configure it on **Alerts** in the dashboard or through `/api/v1/alert-*`.

Code: `ee/alerting/` (Elastic License 2.0).

## How it works

- **Channels** say where notifications go: e-mail (SMTP), Slack, Microsoft Teams, a generic webhook, PagerDuty or ntfy.
- **Rules** say what to watch, which channels to notify, the cooldown and whether to send a notice when the condition clears. Rules that watch hosts can be limited to chosen proxy hosts (`scope`), and most rules can wait until a condition has held for a while before firing (`forMinutes`).
- An evaluator runs every 60 seconds on the node where the rules are configured (started from `src/instrumentation.ts`, never in tests). For each rule it lists the *subjects* that currently match (one per expiring certificate, failing upstream, failing instance, ...):
  - A subject that starts matching **fires**: one notification, unless a firing notification for the same rule and subject went out less than `cooldownMinutes` ago. The transition is recorded in the history either way.
  - A firing subject that stops matching **resolves**. The resolve notice goes to every channel when `notifyOnResolve` is set, and always to PagerDuty channels so the incident closes, but only if the firing notification was sent.
  - While a subject keeps firing, nothing is sent again.
  - With `forMinutes` set, a subject that starts matching is first **pending** and fires only once it has matched on every evaluation for that many minutes. One that stops matching while pending is forgotten, with no event and no notification. The rule lists its pending subjects (`pending`).
  - When a rule cannot be evaluated (Caddy admin API unreachable, ClickHouse not configured or failing) nothing changes: firing alerts are not resolved by mistake. When it can tell about some subjects only (Caddy's HTTPS port unreachable while imported certificates can still be read), the others keep their state.
  - At most 20 new subjects per rule are handled per run; the rest follow on the next run, so a burst cannot flood a channel.
- History (`alert_events`) is kept for 90 days. Disabling or deleting a rule forgets what was firing without sending resolve notices (so a PagerDuty incident it opened stays open until resolved in PagerDuty); a deleted rule's history is kept.
- A firing alert can be dismissed and a rule muted for a while; see [Dismissing and muting](#dismissing-and-muting).
- Alerts are not synced to slave instances. A slave keeps no rules unless someone configures them on it directly.

## Built-in rules

Every install has these rules (`builtIn` set in the API). They start without channels: what they find is listed on the Alerts page and under Needs attention, and nothing is sent until you choose channels in them.

| Rule | Type | Starts |
| --- | --- | --- |
| Certificates expiring or not renewed | `cert_expiring`, 14 days, client and Caddy-managed certificates too | On |
| Configuration not applied to Caddy | `caddy_apply_failed` | On |
| Server errors | `error_rate`, above 5% of at least 20 requests in 5 minutes, one alert per proxy host | On |
| Upstream failing | `upstream_down`, after 2 minutes | On |
| Scheduled backup failed | `backup_failed` | On |
| Instance sync failed | `instance_sync_failed` (master mode only) | On |
| Fleet rollout failed | `fleet_rollout_failed` (master mode only) | On |
| Fleet instance drifted | `fleet_drift` (master mode only) | On |
| WAF block spike | `waf_spike`, 100 blocks in 15 minutes | Off: a host open to the internet sees scans all day; turn it on with a threshold that fits |

They are ordinary rules: change their thresholds, scope, channels and cooldown, or disable them. They cannot be deleted (`DELETE` answers 409). They are added once, when the evaluator first runs after an upgrade or the Alerts page is opened; an install that already had a rule of the same type keeps its own rule and gets no built-in one of that type, and a built-in rule someone disabled stays disabled. A later release that adds built-in rules adds only the new ones.

## The Alerts page

**Alerts** (Observe group, `/alerts`) has four tabs:

- **Open** (`/alerts`): every alert open now, with its severity, since when, which channels were told and what happens when it clears, and the subjects waiting out a "for" duration. **Dismiss** on an alert dismisses it or mutes its rule; dismissed alerts and alerts of muted rules are listed after the others, marked, with **Undo**. The same alerts, except dismissed ones and those of muted rules, are the overview's [Needs attention](../../documentation/needs-attention.md) items.
- **History** (`/alerts?tab=history`): the alerts of the last 7 days, one row per alert from when it opened to when it resolved; select one for what happened (with the AI explanation, labelled as such), who was told when it opened and when it resolved, and links to look closer (the host, certificate or security events it is about, and the audit log around that time). Under it, the event log of the 90 days kept, 25 events at a time (`&page=` for later pages).
- **Rules** (`/alerts?tab=rules`): the built-in rules first, marked **Built-in**, then yours: each rule's condition, scope, "for" duration, usual severity, channels ("Not sent" without any; a channel whose last delivery failed is marked), when it last fired and whether it is on, searchable by name, condition, scope and channel and paged 25 at a time. **Mute…** mutes a rule for a while (the rule then shows "Muted until …" and **Unmute**). **New rule** opens the editor: the condition and its parameters, the hosts it watches (all hosts or chosen ones, for the rule types that accept a scope), the "for" duration, the channels, the cooldown, the resolve notice and the AI explanation.
- **Channels** (`/alerts?tab=channels`): where each channel delivers (the host only, never a credential), how many rules use it, its last delivery and **Send test**, searchable by name, type and destination and paged 25 at a time. A channel whose last delivery failed is also shown in a banner above the table. The channel dialog has **Send test** too, for a channel that is not saved yet or for unsaved changes (`POST /api/v1/alert-channels/test`, or `POST /api/v1/alert-channels/{id}/test` with the changes as its body). Under the channels, the [daily security digest](ai-analyst.md#daily-security-digest) (permission `ai:read`).

When no enabled rule notifies an enabled channel, the Open and Rules tabs say that alerts are not sent anywhere. The AI provider is on **AI settings** (`/settings/ai`, under Settings; `/alerts?tab=ai` goes there).

Without `alerts:write` the page is read-only.

## Dismissing and muting

- **Dismiss** a firing alert (one rule and subject) **until it resolves**: it leaves the overview's "Needs attention" and the sidebar count, and stays on the Open tab marked "Dismissed" with who did it and the note. The overview's Needs attention list dismisses an alert this way too, with the button at the end of its line. When it resolves, the dismissal ends: if it fires again later, it notifies and shows as usual.
- Or dismiss it **for 1 hour, 8 hours, 1 day or 1 week** (the API takes any duration up to 30 days): the same, and if it resolves and fires again before then, no firing notification is sent and it stays out of "Needs attention". The dismissal ends by itself.
- **Mute** a rule for 1 hour, 8 hours, 1 day or 1 week (up to 30 days through the API), from the Rules tab or with "Mute the whole rule instead" in the dismiss dialog: no firing notifications and nothing in "Needs attention" for any of its alerts until then. To stop a rule for good, disable it.
- What fires while muted or dismissed is still recorded in the history, as not sent because of the mute or dismissal (`silenced`). Notifications already sent are not taken back: an alert dismissed after its firing notification went out still gets its resolve notice; one whose firing notification a mute or dismissal held back gets none.
- A note is optional (up to 500 characters). Dismissing an alert again, or muting a rule again, replaces the previous dismissal or mute. **Undo** (or **Unmute**) ends either at any time.
- The evaluator removes dismissals and mutes that ended on each run; deleting a rule deletes them, and disabling one ends its dismissals "until it resolves". They are not exported or synced to slaves.
- Dismissing, muting and undoing need `alerts:write`. They are audited (`alert_silence_created`, `alert_silence_deleted`).

## Rule types

| Type | Parameters | What is evaluated |
| --- | --- | --- |
| `cert_expiring` | `days` (1-365, default 14), `includeClientCertificates` (default true), `includeManagedCertificates` (default true) | Certificates whose PEM the dashboard stores: imported certificates, CA certificates, and issued client certificates that are not revoked; and the certificates Caddy obtains itself (ACME, or its internal CA) for enabled proxy hosts, see below. Already expired ones keep firing until replaced. |
| `upstream_down` | `minFails` (default 1) | Caddy's `GET /reverse_proxy/upstreams`. See the note below. |
| `waf_spike` | `threshold` (default 100), `windowMinutes` (1-1440, default 15) | Requests blocked by the WAF in ClickHouse over the window. Skipped when ClickHouse analytics is not configured. |
| `error_rate` | `thresholdPercent` (0.1-100, one decimal, default 5), `windowMinutes` (1-1440, default 5), `minRequests` (default 20), `perHost` (default true) | The share of 5xx responses in ClickHouse's traffic over the window: one alert per proxy host (`perHost`), or one for the hosts in scope together. Counts only when there were at least `minRequests` requests; fires when the share is above the threshold. Skipped when ClickHouse analytics is not configured or cannot be queried. |
| `instance_sync_failed` | none | Enabled instances whose last sync failed (`lastSyncError`), in master mode. |
| `caddy_apply_failed` | none | The last attempt to push the configuration to Caddy failed; resolves after the next successful apply. |
| `backup_failed` | `minFailures` (1-100, default 1) | Enabled scheduled-backup destinations whose backups failed that many times in a row (see [scheduled-backups.md](scheduled-backups.md)); resolves after the next successful backup. Failed backups are retried after 5 minutes, then with growing delays. |
| `approval_pending` | none | Each change request waiting for approval (see [change-approvals.md](change-approvals.md)), so approvers hear about it once; resolves when it is approved, rejected, cancelled or expires. |
| `access_review_started` | none | An access review campaign is open (started by hand or by a schedule, see [access-reviews.md](access-reviews.md)); severity info; resolves when it is completed or cancelled. |
| `access_review_overdue` | none | An open access review is past its due date with items nobody confirmed yet; resolves when it is completed, cancelled or every item is confirmed. |
| `fleet_drift` | none | Enabled instances whose last drift check found them drifted (see [fleet.md](fleet.md)), in master mode; resolves after a re-sync or a check that finds them in sync. |
| `fleet_rollout_failed` | none | Fleet environments whose latest rollout failed (see [fleet.md](fleet.md)), in master mode; resolves when a later rollout starts there. |

### Scope and "for" duration

`scope` is `{"type":"all"}` (the default) or `{"type":"hosts","proxyHostIds":[...]}` (1 to 200 existing proxy hosts). Only these rule types accept a host list:

- `cert_expiring`: the imported certificates those hosts use and the certificates Caddy manages for them. CA and client certificates belong to no host, so only a rule without a host list covers them.
- `upstream_down`: the upstreams of those hosts.
- `waf_spike`: requests blocked on their domains.
- `error_rate`: their traffic.

Every other type answers 400 for a host list. Each rule's view has a `scopeLabel` that says what it watches in words ("Each proxy host", "Upstreams of 3 proxy hosts", "This node"). It also has `lastFiredAt`: when the rule last fired, from its newest firing event in the 90-day history (null when it has not).

`forMinutes` (0 to 1440, default 0: fire at once) is accepted by `cert_expiring`, `upstream_down`, `waf_spike`, `error_rate`, `instance_sync_failed`, `caddy_apply_failed`, `backup_failed` and `fleet_drift`. Rules about one-off events (a change waiting for approval, a review that started or is overdue, a failed rollout) fire at once and answer 400 for any other value.

### Certificates Caddy manages

Caddy keeps the certificates it obtains in its own storage, which the dashboard cannot read; it reads the certificate Caddy presents for each domain with a TLS handshake instead (`src/lib/managed-certificates.ts`), the same reading the certificates page shows. How that works, the cache and the `CADDY_TLS_ADDRESS` setting are described in [Where the expiry comes from](../../documentation/certificates.md#where-the-expiry-comes-from).

- Checked names: the domains of enabled proxy hosts without an imported certificate, or with a "managed" certificate entry (DNS-01). A wildcard domain is checked as `tls-check.<domain>`; IP addresses are skipped.
- Caddy renews a certificate when a third of its lifetime is left. A certificate past that point plus one day is reported as **renewal overdue**: the renewal is failing. A name Caddy has no certificate for (Caddy answers with a TLS "internal error" alert) is reported as **missing**, a certificate that does not cover the name as a **mismatch**. Any other TLS error (for example a host that demands a client certificate) is not taken as a missing certificate.
- The rule fires for managed certificates that expire within `days`, whose renewal is overdue, that are missing or that do not cover the name. A missing certificate of a host saved in the last 15 minutes is left alone while Caddy obtains it. When Caddy's HTTPS port cannot be reached, alerts about managed certificates keep their state.
- `GET /api/v1/certificates/managed` (permission `certificates:read`, limited to the caller's tag scope) lists them; `?refresh=true` checks names older than a minute again.

What is not covered, and why:

- **L4 (TCP/UDP) hosts** that terminate TLS are not checked.
- **Upstream health.** In Caddy 2.11 the admin API reports, per HTTP reverse-proxy upstream, only its address, requests in flight and `fails`: the failures counted by *passive* health checks within their `fail_duration`. Caddy counts nothing unless the host has passive health checks with a non-zero fail duration (load balancing settings of the proxy host). The result of *active* health checks is not exposed, and caddy-l4 (TCP/UDP) upstreams are not in this pool. `upstream_down` therefore means "recent failed requests", not "marked unhealthy by an active check".
- **Environment-configured slaves** (`INSTANCE_SLAVES`) do not store their last sync result; only instances added in the dashboard are watched by `instance_sync_failed`.
- **`caddy_apply_failed`** watches the last apply attempt made by this process. A brief failure that a later apply fixes before the next evaluation (within a minute) is not reported. If the apply at startup fails (for example because Caddy was not up yet), the alert fires and stays until the next successful apply.

## Channels

| Type | Settings | Secrets (encrypted, never returned) |
| --- | --- | --- |
| `email` | `host`, `port` (default 587, or 465 with `secure`), `secure` (implicit TLS; otherwise STARTTLS when offered), `user`, `from`, `to` (1-20 addresses) | `password` |
| `slack` | | `webhookUrl` (incoming webhook, https) |
| `teams` | | `webhookUrl` (Workflows "post to a channel when a webhook request is received" URL, or a legacy incoming webhook; https). Sent as an Adaptive Card. |
| `webhook` | | `url` (http or https), optional `hmacSecret` |
| `pagerduty` | `region` (`us` or `eu`) | `routingKey` (Events API v2 integration key). Triggers and resolves with a stable `dedup_key` per rule and subject. |
| `ntfy` | `serverUrl` (default `https://ntfy.sh`), `topic` | optional `token` |

Credentials, including webhook URLs that embed a token, are stored encrypted with `SESSION_SECRET` and re-encrypted by the startup rotation pass like every other stored secret. The API and the dashboard only show `has*` flags and, for URLs, the scheme and host. When updating a channel, an omitted or empty secret keeps the stored one and `null` removes an optional one. Changing the SMTP host or the ntfy server requires entering the password or token again, so a stored credential is never sent to a destination it was not entered for.

Delivery uses a 10 s timeout and does not follow redirects. Errors are reduced to fixed messages (HTTP status, connection error code, SMTP error class); URLs, response bodies and exception messages are never stored or shown. The last delivery result is shown per channel; each history entry lists the result per channel.

**Send test** posts a test notification (for PagerDuty it opens and immediately resolves an incident).

### Webhook payload

```json
{
  "version": 1,
  "source": "ingressi",
  "status": "firing",
  "severity": "critical",
  "rule": { "id": 3, "name": "Upstreams", "type": "upstream_down" },
  "subject": "upstream:10.0.0.5:8080",
  "eventId": 42,
  "title": "Upstream 10.0.0.5:8080 is failing (3 recent failures)",
  "message": "Caddy counted 3 recent failed requests to upstream 10.0.0.5:8080, used by \"App\". ...",
  "facts": { "upstream": "10.0.0.5:8080", "recentFailures": 3, "proxyHosts": ["App"] },
  "explanation": { "label": "AI-generated explanation", "text": "..." },
  "at": "2026-10-02T10:00:00.000Z"
}
```

`status` is `firing`, `resolved` or `test`; `explanation` is null unless the rule asks for one and the model answered. With an HMAC secret, requests carry `X-Ingressi-Timestamp` (Unix seconds) and `X-Ingressi-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + raw body)>`. Verify the signature over the raw body and reject old timestamps.

## AI explanations

A rule with `explain: true` asks the AI provider configured on AI settings for a short plain-language explanation of each firing alert. See [ai-analyst.md](ai-analyst.md).

## REST API

All endpoints are admin-only (API token or session) and audited; see `/api/v1/openapi.json` (tags *Alerting* and *AI*).

| Method and path | |
| --- | --- |
| `GET /api/v1/alert-channels`, `POST /api/v1/alert-channels` | List, create |
| `GET`, `PUT`, `DELETE /api/v1/alert-channels/{id}` | Read, update (partial), delete (409 while a rule uses it) |
| `POST /api/v1/alert-channels/{id}/test` | Send a test notification: `{"ok": true, "error": null}` |
| `GET /api/v1/alert-rules`, `POST /api/v1/alert-rules` | List (with the subjects currently firing), create |
| `GET`, `PUT`, `DELETE /api/v1/alert-rules/{id}` | Read, update (partial; params are merged), delete |
| `GET /api/v1/alert-events?page=&per_page=&rule_id=` | History, newest first. A firing event carries `resolvedAt`, when that episode ended (null while it fires). |
| `GET /api/v1/alert-events/firing` | Every subject firing now, with the event that started it, the channels told and its `dismissal` and `mute` (or null): those neither dismissed nor muted first, then most severe first |
| `GET /api/v1/alert-silences`, `POST /api/v1/alert-silences` | List the dismissals and mutes in effect; dismiss or mute: `{"ruleId": 3, "subjectKey": "certificate:7", "durationMinutes": 480, "note": "…"}`. Without `subjectKey` the whole rule is muted (it then needs `durationMinutes` or `until`); without a duration, the dismissal lasts until the alert resolves (409 if it is not firing). |
| `DELETE /api/v1/alert-silences/{id}` | Undo a dismissal or mute |

```bash
curl -X POST https://ingressi.example.com/api/v1/alert-channels \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Ops","type":"email","config":{"host":"smtp.example.com","user":"alerts","password":"…","from":"alerts@example.com","to":["ops@example.com"]}}'

curl -X POST https://ingressi.example.com/api/v1/alert-rules \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Certificates","type":"cert_expiring","params":{"days":21},"channelIds":[1]}'
```

The type of a channel or rule cannot be changed after creation.

## Data

Tables (migration `drizzle/0028_alerting.sql`; `scope`, `forMinutes` and `pendingSince` from `0046_governance.sql`; `alert_silences` and `alert_events.silenced` from `0058_alert_silences.sql`): `alert_channels`, `alert_rules`, `alert_rule_states` (per rule and subject: firing, pending or not, last notification, whether the firing notice was sent), `alert_events` (history; no foreign key, survives rule deletion) and `alert_silences` (dismissals and mutes in effect: rule, subject or none for a mute, until when or until it resolves, note, who). Who created or changed what is in the audit log (`alert_channel_*`, `alert_rule_*`, `alert_silence_*`).
