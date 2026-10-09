# AI analyst

Four tools that use a model you choose, never in the way of traffic or alerts:

- **Alert explanations**: firing alerts can carry a short, plain-language explanation of what they mean and a suggested next step.
- **Daily security digest**: one message a day with the security figures of the last 24 hours, optionally with an AI-written summary.
- **WAF tuning suggestions**: likely WAF false positives, each with the narrowest exclusion the WAF settings support and its evidence.
- **Analytics questions**: ask about your traffic in plain language on the Analytics page; the model turns the question into a checked query that runs on your analytics, and saved questions can be part of compliance report schedules. See [analytics-questions.md](analytics-questions.md).

Code: `ee/ai/` (Elastic License 2.0).

## The AI provider

On **AI settings**, or with `PUT /api/v1/ai/settings`:

| Field | |
| --- | --- |
| `provider` | `anthropic` (Claude, through the official `@anthropic-ai/sdk`) or `openai_compatible` (any server with an OpenAI-style `/chat/completions` endpoint, such as Ollama, vLLM or LM Studio, so explanations can stay on your network) |
| `model` | Default `claude-opus-5` for Anthropic; required for `openai_compatible` (for example `llama3.1`) |
| `apiKey` | Required for Anthropic, optional for `openai_compatible`. Stored encrypted, never returned (`hasApiKey`). |
| `baseUrl` | `openai_compatible` only, for example `http://ollama:11434/v1`; requests go to `{baseUrl}/chat/completions` |
| `timeoutSeconds` | How long one model call may take, 5 to 300 seconds. Default 60, also for settings saved before the field existed. It applies to alert explanations, the digest summary, analytics questions, WAF risk assessments, incident drafts and **Explain a sample alert**. A call that runs out of time reports "The model did not answer within 60 seconds. A slower model needs a longer timeout (AI settings)." Raise it for slow models, such as large self-hosted ones. |
| `enabled` | Default true |

Then turn on **Add an AI-generated explanation** (`"explain": true`) for the rules that should get one. **Explain a sample alert** (`POST /api/v1/ai/test`) sends a made-up certificate alert to the model and shows the answer.

```bash
curl -X PUT https://ingressi.example.com/api/v1/ai/settings \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"provider":"openai_compatible","model":"llama3.1","baseUrl":"http://ollama:11434/v1"}'
```

The key goes only to the provider it was entered for: Anthropic keys only to `https://api.anthropic.com` (the SDK ignores `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` here), OpenAI-compatible keys only to the configured base URL, and redirects are never followed. Changing the provider or the base URL requires entering the key again (or `"apiKey": null`). The settings live in the settings table under `ai_provider`, are re-encrypted on `SESSION_SECRET` rotation, and are not synced to slaves.

The same provider answers [analytics questions](analytics-questions.md), which have their own settings under **AI settings → Analytics questions** (`/api/v1/ai/question-settings`): whether users may ask, whether the model writes the summary, and whether client addresses, user agents and paths may be sent when a question needs them (off by default).

## Alert explanations: what the model sees

Only structured, aggregated facts about the alert: its type and what the type means, severity, status and the rule's `facts` (for example a certificate's name, domains and expiry; an upstream's address, failure count and the proxy hosts that use it; blocked-request counts with the top WAF rule ids, their rule messages and the top hosts). No log lines or raw requests, and no rule names.

Some of those values can come from users, logs or requests (host names, WAF rule messages). They are sent as JSON inside a data block delimited by a tag with a random id, with `<` and `>` escaped so nothing inside can close it. The system prompt tells the model that the block is untrusted data, that it must never follow instructions, requests or links inside it, and to answer in 2 to 4 plain sentences. The model gets no tools.

Anthropic requests use `messages.create` with `max_tokens: 1024` and `output_config: {effort: "low"}`. A response whose `stop_reason` is `refusal` yields no explanation; only `text` content blocks are used. OpenAI-compatible requests send the same system and user messages with `max_tokens: 4096`, room for a reasoning model's thinking as well as its answer; a `content_filter` finish yields no explanation, `<think>` blocks are removed, an answer given as content parts is read from its text parts, and a reply with only reasoning (no answer before the limit) says so. The answer is reduced to plain text of at most 1200 characters.

## Never in the way of an alert

The model is asked right before the alert is sent, with the provider's timeout as a hard limit and no retries. If the call fails, times out, is refused or returns nothing, the alert goes out without an explanation; a slow model delays an alert by at most the timeout and never holds up another one (alerts are sent concurrently). When it succeeds, the explanation is appended to the notification on every channel, labeled **AI-generated explanation**, and stored with the history entry. Resolve notices carry no explanation.

## Daily security digest

On **Alerts → Channels → Daily security digest**, or with `PUT /api/v1/ai/digest`:

| Field | |
| --- | --- |
| `enabled` | Send the digest every day |
| `timeOfDay` | `"HH:MM"`, 24-hour clock, default `08:00` |
| `timeZone` | IANA time zone, default `UTC` (for example `Europe/Rome`) |
| `channelIds` | Alert channels to send it to (at least one when enabled). E-mail gets HTML and plain text; Slack, Teams, webhooks and ntfy get their own text formats. PagerDuty channels never receive digests. |
| `ai` | Add an AI-generated summary when a provider is configured, default false |

```bash
curl -X PUT https://ingressi.example.com/api/v1/ai/digest \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"enabled":true,"timeOfDay":"07:30","timeZone":"Europe/Rome","channelIds":[1,2],"ai":true}'
```

`POST /api/v1/ai/digest/preview` returns the digest as it would be sent now (subject, text, HTML, the facts it was built from and what happened to the AI summary) without sending it; `{"ai": false}` previews it without the model. `POST /api/v1/ai/digest/send` sends it to the enabled channels right away and reports each delivery.

### Contents

The digest covers the 24 hours before it is built and is made from aggregated figures only, never log lines, client addresses or request contents:

- requests and distinct clients; blocked requests by reason: WAF (requests the WAF interrupted), geo/ASN blocking, and access lists (401 answers on hosts protected by an access list, which includes first-time credential prompts); WAF matches that did not block;
- the most attacked hosts, paths (query strings removed) and WAF rules, and the source countries and autonomous systems of WAF events and geo-blocked requests;
- countries and autonomous systems that sent traffic in the last 24 hours but none in the 7 days before. Autonomous systems come from the GeoLite2-ASN database used by the geo blocker (looked up in the dashboard, only AS numbers and names are kept); the comparison uses the busiest client addresses of each period and confirms that the new networks sent nothing before;
- certificates expiring within 14 days (imported, CA and issued client certificates; ACME certificates are renewed by Caddy), configuration changes from the audit log (sign-ins, tests and exports left out), and alerts fired and resolved.

Without ClickHouse analytics the traffic part is replaced by a sentence saying it is not available, and the rest is sent; the same happens when ClickHouse cannot be queried. A missing ASN database or missing earlier traffic is noted in the digest.

### The AI summary

With `ai` on and a provider configured, the model writes 3 to 6 sentences on what happened and what to look at, from the digest's facts only (without who made each configuration change). The facts go in a JSON data block with a random tag, as for alert explanations, the system prompt says the block is untrusted and must never be followed, the model gets no tools and the provider's timeout, and the answer becomes plain text of at most 1500 characters, shown first and labeled **AI-generated summary** in every format. If the call fails, times out, is refused or no provider is configured, the plain digest is sent; the preview and the last-run record say why.

### Schedule

A job checks every minute and sends the digest once per local day at or after `timeOfDay` in `timeZone` (daylight-saving changes included). A slot missed by more than 6 hours (the dashboard was down) is skipped until the next day, and enabling the digest or changing its time never sends a slot that has already passed today. The day is claimed before sending, so a slow or failing run is not repeated. The settings live in the settings table under `ai_digest` (last run under `ai_digest_state`) and are not synced to slaves: each node sends its own digest only if one is set up there.

## WAF tuning suggestions

On **WAF → Tuning suggestions**, or with `GET /api/v1/waf/tuning-suggestions`. Needs ClickHouse analytics.

Suggestions come from the WAF events of the last 14 days (or the ClickHouse retention, if shorter). A candidate is one OWASP CRS rule (protocol, scanner, injection, data-leakage families; anomaly evaluation and custom rules are never proposed) matching on one host for at least 5 different clients on at least 2 days. Each is scored on:

- how many different clients and days it matched on;
- the share of matches that did not block the request (detection-only, or below the anomaly threshold) and their severity and total anomaly score;
- the share of those clients that triggered no other WAF rule, and the share that also made successful requests to the same host (from the access log, when available);
- whether the matches concentrate under one path prefix.

Suggestions are ranked by confidence, then volume. Rules of attack-critical families (local and remote file inclusion, remote code execution, PHP and generic injection, SQL injection, Java attacks, web shells) are never **high** confidence, and only **low** when most matches are critical, blocked or have a high anomaly score. Candidates that look like real attacks are not proposed at all, nor are rules already suppressed for the host or globally, hosts that no proxy host serves, or suggestions dismissed before.

Each suggestion proposes the narrowest exclusion the WAF settings support: suppressing the rule for that proxy host (rule exclusions apply to the whole host; they cannot be limited to a path). The evidence lists the counts, the busiest path prefixes with example paths (query strings removed) and the client counts; client addresses are never shown. With `?explain=true`, up to 5 suggestions without one get an **AI-generated risk assessment** (what the rule protects against, what turning it off risks, whether the evidence looks like a false positive), built with the same untrusted data block, no tools and the provider's timeout; failures leave the assessment out and are reported in `explanationError`.

Each run replaces the open suggestions. Nothing is applied automatically:

- `POST /api/v1/waf/tuning-suggestions/{id}/apply` adds the rule to the proxy host's excluded rules, as a host-wide rule exclusion (so the change is recorded as a proxy host update, applied to Caddy and, with configuration history on, snapshotted) and records `waf_tuning_suggestion_applied` in the audit log. Undo it in the host's WAF settings.
- `POST /api/v1/waf/tuning-suggestions/{id}/dismiss` records `waf_tuning_suggestion_dismissed`; a dismissed suggestion is never proposed again.

Suggestions are stored in the `waf_tuning_suggestions` table, which is not synced to slaves.

## Turning it off

`DELETE /api/v1/ai/settings` or `PUT {"provider": null}` removes the provider and its key, `PUT {"enabled": false}` (optionally with `"apiKey": null`) switches it off, `{"explain": false}` turns explanations off for a rule, and `PUT /api/v1/ai/digest` with `{"enabled": false}` and/or `{"ai": false}` turns the digest or its summary off.
