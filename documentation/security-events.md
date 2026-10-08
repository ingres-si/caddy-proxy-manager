# Security events

**Security events** (`/security`, under Observe) shows what Ingressi stopped: requests the WAF blocked or logged, and requests refused by geo rules, access lists, sign-in (forward authentication) and rate limits. It reads ClickHouse analytics; without analytics the page says so and shows only the WAF rule set.

Reading the page needs the `waf:read` permission. Actions need their own: adding a WAF exclusion needs `waf:write`, blocking an address needs `access_lists:write`. Buttons a user may not use are disabled with the reason.

The old **WAF events** page (`/waf/events`) now opens Security events with the WAF filter and the same time range.

## What the page shows

- **Rule set**: the OWASP Core Rule Set version, the paranoia level and inbound anomaly threshold, how many hosts block and how many only detect, and how many rule exclusions there are. It links to [WAF settings](waf.md).
- **Mitigated requests**: how many requests were stopped in the range, their share of all requests, the change from the period before, and the split by source (WAF, geo rules, access lists, sign-in, rate limiting).
- **Source addresses** and **most targeted host**: how many addresses were stopped, how many WAF rules matched, and the host with the most events. The host opens its events.
- **Mitigated requests by source**: one bar per bucket (a minute for the last hour, 30 minutes for 24 hours, 3 hours for 7 days, a day for 30 days). The busiest bucket is marked and explained: what stopped the requests, the busiest source address, the host they went to and the WAF rule that matched most. **Show these events** narrows the page to that bucket.
- **Top rules**: the WAF rules that matched most, with their category, the paths and hosts they matched on, a trend and their events (detection-only matches included). **Add exclusion** opens the exclusion form with the rule, and the host and path when it matched on only one.
- **Top sources**: the addresses with the most events, with country, network (AS number), the WAF rules they hit and when they were last seen. **Block** adds the address to the [Blocked sources](access-lists.md#blocked-sources) list after a confirmation, optionally for a limited time. Addresses already on that list show as blocked.
- **Events**: every WAF event and every stopped request, newest first, 50 to a page. The pager under the list goes to the next (older) or previous page; the page is in the address (`?page=2`). The events are not counted in advance, so the pager shows the range of the page (`51–100 events`) rather than a total. Select an event to see why it was stopped.

## Filters and range

The range is the last hour, 24 hours, 7 days (the default) or 30 days, or a custom range in UTC of at most 92 days. The events can be filtered by source (WAF, geo, access, sign-in, rate limit) and by host, rule, address, path and country, with "is" or "is not". The range and filters are in the page address, so a filtered view can be bookmarked or shared. Clicking a rule, an address or the most targeted host adds it as a filter.

## Why a request was stopped

Select an event to open it.

For a WAF event the page reads the stored audit record. It shows the score against the threshold once, then every rule that matched: the points it added, what it checks, what it matched and in which variable (**Show the value** shows the whole value). Control characters are shown as escapes, so the CR/LF a header-injection rule found reads `\r\n`. Then:

- **Exclude N rules…** (or **Exclude rule …**) reviews the narrowest exclusions the record allows, together: each rule that added to the score, on the host that served the request, for its exact path, on the variable it matched when the record names one. Untick the ones to keep, give one reason, and they are added at once with a single Caddy apply (all or none). Only exclude when the request was legitimate. When the exclusions exist already, or nothing can be excluded, the page says why.
- **Block** the address. When the address is one of Cloudflare's, the page says so first: behind Cloudflare that is the edge server, and blocking it blocks every visitor it forwards. Add Cloudflare under **Trusted proxies** (Host defaults) so the real client address is recorded instead.
- **Copy as curl** copies a command that repeats the request (over HTTPS, with its headers; credentials were redacted when the event was stored). Treat it as untrusted: it repeats what an attacker sent.
- **Raw audit record** shows the stored Coraza record.
- **Open in analytics** shows all traffic from the address.

For a request stopped by another rule, the page says which kind of rule stopped it, from its outcome:

| Source | Rule |
| --- | --- |
| Geo rules | A country, continent or network (AS number) rule of the global geoblocking settings or the host's own, or fail-closed blocking of an unknown address. |
| Access lists | An address rule (a blocked address or network), or an access list asking for a user name and password (status 401). |
| Sign-in | The host requires forward-authentication sign-in, and the visitor was sent to the sign-in page. |
| Rate limiting | A rate limit rule refused the request with 429. |

[Analytics](analytics.md) describes how each request's outcome is decided.

## Tuning suggestions

With the AI analyst ([ai-analyst.md](../ee/docs/ai-analyst.md)) the page also lists likely false positives found in the last 14 days of WAF events, each with its evidence and a proposed exclusion.

## REST API

The page's data comes from the analytics API (permission `analytics:read`); the explanation and exclusions from the WAF API (`waf:read`, `waf:write`); blocking from the access lists API (`access_lists:write`).

| Endpoint | What |
| --- | --- |
| `GET /api/v1/analytics/security/series` | Mitigated requests by source per bucket, totals, and the peak with its busiest address, host and rule. |
| `GET /api/v1/analytics/security/rules` | Top WAF rules. |
| `GET /api/v1/analytics/security/sources` | Top source addresses. |
| `GET /api/v1/analytics/security/hosts` | Most targeted hosts, with the proxy host serving each. |
| `GET /api/v1/analytics/security/events` | The event list: `kind`, `filters` (JSON, on `host`, `path`, `country`, `ip`, `method`, `waf_rule`), `limit`, `offset`. A WAF event's `eventId` is its id in the WAF API. |
| `GET /api/v1/waf/events/{id}/explain` | Why a WAF event was blocked. |
| `GET /api/v1/waf/events/{id}/suggested-exclusion` | Its suggested exclusions; post one to `/api/v1/waf/exclusions`, or several to `/api/v1/waf/exclusions/batch` (`{ "exclusions": [...] }`, all or none, one apply). |
| `POST /api/v1/access-lists/blocked-sources/entries` | Block an address: `{"address": "198.51.100.7", "reason": "...", "expiresInSeconds": 86400}`. |

```bash
curl -G https://dash.example.com/api/v1/analytics/security/events \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'range=24h' \
  --data-urlencode 'kind=waf' \
  --data-urlencode 'filters=[{"dim":"waf_rule","op":"is","value":"930130"}]'
```
