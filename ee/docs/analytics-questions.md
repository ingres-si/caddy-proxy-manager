# Analytics questions

Ask about your traffic in plain language, such as "Which countries were blocked most last week on the shop hosts?" or "Did 5xx errors on api hosts go up after Tuesday?", and get the numbers, a chart or a ranked table, a short summary and the query the question was read as.

Part of the AI analyst. Code: `ee/ai/questions/` (Elastic License 2.0). Adding questions to compliance report schedules is part of [compliance reports](compliance-reports.md).

## Asking

The **Ask about your traffic** box is at the top of **Analytics** (`/analytics`), and **Ask about traffic** opens the same box on **Compliance**. It needs:

- `analytics:read`;
- an AI provider (AI settings, see [ai-analyst.md](ai-analyst.md)): your own Anthropic key, or an OpenAI-compatible server such as Ollama on your network;
- questions turned on (AI settings → Analytics questions; on by default);
- ClickHouse analytics.

The answer shows:

- **Read as**: the query in words, for example "Mitigated requests by country (top 10), 27 Sep–4 Oct 2026, hosts tagged shop". Times are UTC.
- **Open in Analytics**: the same period, metric, grouping and filters on the Analytics page. Host tags become host filters for the host names they matched; when they do not fit in the page's 20 filters the link shows every host and the answer says so.
- **Summary**: 1 to 3 sentences. Labelled **AI-generated summary** when the model wrote it from the aggregated result; otherwise the dashboard writes it from the numbers.
- **The result**: one figure (with the change from the previous period when asked), a chart over time (the analytics chart, with the previous period as a line), or a ranked list or table.
- **What was sent** to the provider for this answer.

**Save question** keeps the question and the query it was read as (optionally shared with everyone who can read analytics). A saved question runs again with fresh data without asking the model to read it again: a relative range such as "the last 7 days" ends now. Saved questions are listed under the box, ten a page.

The question goes to the AI provider, which turns it into a query; the query runs on your analytics, and only aggregated figures are used for the summary (see [What the model sees](#what-the-model-sees) and [Audit](#audit)).

A question that is ambiguous gets a short question back ("For which period and hosts?"). One that traffic data cannot answer (configuration, users, certificates, predictions) says so. Neither runs anything.

## From question to query

1. The model receives the question and a description of the query schema (below), with today's date and the retention. It must answer with one JSON object: a query, a clarification or "unsupported". It never writes SQL and has no tools.
2. The server validates the answer: one of the three shapes and nothing else, every object checked for unknown fields (an extra `sql` field, or `__proto__`, is refused rather than ignored), every name from a fixed list, every value checked for its dimension, sizes bounded. An answer that fails is refused and **nothing runs**; the reason is shown.
3. The query runs through the same query layer as the Analytics page (`src/lib/analytics`): every SQL fragment is a constant picked by name, every value a bound parameter.

| Field | Values |
| --- | --- |
| `metric` | `requests`, `mitigated` (any outcome but served: WAF, geo rules, access rules, sign-in, rate limit), `errors` (status 400 and above), `bytes` (bytes sent), `visitors` (distinct client addresses) |
| `breakdown` | `none` (one total), `time` (over time), or a dimension ranked: `host`, `path`, `country`, `asn`, `status`, `method`, `protocol`, `ip`, `user_agent`, `outcome`, `waf_rule`. `bytes` allows `none`, `time` and `host`; `visitors` `none` and `time` |
| `filters` | At most 10 `{dim, op: "is" \| "is_not", value}`, validated like the Analytics filters |
| `hostTags` | At most 5 proxy host tags |
| `range` | `{"preset": "1h" \| "24h" \| "7d" \| "30d"}`; `{"minutes": N}` for the last N minutes (1 to 1440, minute buckets); or `{"from": …, "to": … \| "now"}` with dates `YYYY-MM-DD` in UTC (both days included) or date-times with a time zone, at most 92 days, capped at now |
| `comparison` | `none`, or `previous_period` (the same length right before) |
| `limit` | 1 to 50 values listed by a breakdown (bytes by host: at most 10) |

Ranked dimensions count requests; `mitigated` adds "outcome is not served" and `errors` keeps only status filters of 400 and above (or adds 4xx and 5xx).

## Whose traffic

A question reads exactly what the asker can read:

- every host, as on the Analytics page;
- host tags name only the proxy hosts the asker's role reaches (its tag scope). A tag on no such host gets a question back listing the tags in use. The stored host names of the tagged hosts are the names Caddy routes to them: their exact domains, and names under a wildcard domain that no other host serves exactly.

## What the model sees

| Call | Sent |
| --- | --- |
| Interpretation | The question as typed, inside a data block delimited by a tag with a random id (`<` and `>` escaped), and the schema above with the current date and the retention. No traffic data, host names or tags from the configuration. |
| Summary (when on) | The question, the query in words, the period, and the aggregated result: totals, the ranked values with their counts and shares, the series per interval, the previous period's numbers and notes. |

Client addresses, user agents and paths are request details. In the summary call they are replaced by placeholders (`[address 1]`, `[user agent 2]`, `[path 3]`), in the ranked values and in the query in words, which the dashboard puts back into the summary it shows. They are sent as they are only when both:

- the question ranks or filters by that dimension, and
- **Send client addresses, user agents and paths when a question needs them** is on (off by default).

Turn **AI-written summaries** off and the result never reaches the model: the dashboard writes the summary. The question itself is always sent as typed, so do not type what you would not send. No log lines, raw requests or other configuration are ever sent.

Both calls follow the AI analyst's rules: the provider and key from AI settings (keys go only to the provider they were entered for), no tools, one call each, no retries, the provider's timeout (60 seconds unless set otherwise) and at most 1024 output tokens. A question that runs out of time says so: "The model did not answer within 60 seconds. A slower model needs a longer timeout (AI settings)." Raise **Timeout (seconds)** there for a slow model, such as a large self-hosted one. The system prompt says the question and the data are untrusted and never instructions. The summary is reduced to plain text.

## Limits and cost

- Questions are at most 500 characters.
- At most two model calls per question (interpretation, then summary), one question at a time per user, 10 questions per 10 minutes and 100 per day per user (`429` beyond). Running a saved question counts too.
- Each ClickHouse query stops after 30 seconds; a question runs at most a handful of them.

## Audit

Every question is recorded in the audit log as `analytics_question_asked`: who asked, the question, the outcome (answered, asked back, not answerable), the query that ran and its words, the provider and model, whether the summary came from the model and whether request details were sent. A refused model answer records why. Saving, changing and deleting saved questions are recorded too (`analytics_question`), and changing the settings (`ai_question_settings_updated`).

## Settings

On **AI settings → Analytics questions**, or with `GET`/`PUT /api/v1/ai/question-settings` (`ai:read`, `ai:write`):

| Field | Default | |
| --- | --- | --- |
| `enabled` | `true` | Users who can read analytics may ask, within their host tags |
| `aiSummaries` | `true` | The model writes the summary from the aggregated result; off, the dashboard writes it and the result is never sent |
| `shareRequestDetails` | `false` | Send client addresses, user agents and paths when a question needs them; off, they reach the model as placeholders such as `[address 1]`. The question is always sent as typed |

Stored under `ai_questions` in the settings table, not synced to slave instances (like the provider). Saved questions (`analytics_questions`) are master-only and not part of configuration export or history; deleting a user deletes their questions.

## In compliance reports

A report schedule can include up to 10 saved questions (`questionIds`, see [compliance-reports.md](compliance-reports.md)). The schedule keeps a copy of each question and its query, so deleting the saved question or its owner leaves the schedule as it was. Each run adds a **Traffic questions** report: every question re-run for the report's period over every host (compliance reports cover every host; host tags name every proxy host that carries them then), one table per question with the query in words and a summary the dashboard writes. No AI model is asked when a report is generated.

## REST API

| Method and path | Permission | |
| --- | --- | --- |
| `POST /api/v1/analytics/questions` | `analytics:read` | `{question}`; the answer. `400` without a provider, `409` when questions are off, `429` over the limits, `502` when the provider fails |
| `GET /api/v1/analytics/questions/saved` | `analytics:read` | Your saved questions and the shared ones |
| `POST /api/v1/analytics/questions/saved` | `analytics:read` | `{question, query, shared?}`; the query is validated again; `201` |
| `GET /api/v1/analytics/questions/saved/{id}` | `analytics:read` | |
| `PATCH /api/v1/analytics/questions/saved/{id}` | `analytics:read` | Owner only |
| `DELETE /api/v1/analytics/questions/saved/{id}` | `analytics:read` | Owner, or an administrator for a shared one; `204` |
| `POST /api/v1/analytics/questions/saved/{id}/run` | `analytics:read` | Fresh data, no interpretation call |
| `GET /api/v1/ai/question-settings` | `ai:read` | |
| `PUT /api/v1/ai/question-settings` | `ai:write` | |

```bash
curl -X POST https://ingressi.example.com/api/v1/analytics/questions \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"question":"Which countries were blocked most in the last 7 days on the shop hosts?"}'
```
