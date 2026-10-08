# Compliance reports

Code: `ee/compliance/` (Elastic License 2.0).

Reports that turn the configuration and the audit log into audit evidence for NIS2 and ISO/IEC 27001, and drafts of NIS2 incident notifications:

- **Access review**: every dashboard user, what they can do and how they sign in.
- **Change log**: the audit events of a period, grouped, with the audit log's hash-chain verification.
- **Certificate inventory**: every certificate, who issued it, when it expires and who uses it.
- **Protection coverage**: what stands in front of each host (WAF, authentication, geo blocking, TLS) and the MFA coverage of users.
- **Traffic questions**: saved plain-language analytics questions, re-run with fresh data for each scheduled report's period.
- **Report schedules**: every week or month, the chosen reports for the period that ended, stored and hashed like reports made by hand, with a notice on alert channels.
- **Live control status**: six checks of the running install (TLS, MFA for administrators, audit log integrity, test restores, access reviews, WAF blocking) with their evidence.
- **Test restores**: a record of each backup restored as a test.
- **Incident register**: every security event with its window, timeline, NIS2 Article 23 significance assessment, classification and cause, and for significant incidents the three notification stages with their deadlines, prefilled from WAF, traffic, alert and change data, optionally with an AI-written first draft.

A report is evidence that can support the controls mapped to it. It does not by itself show compliance with NIS2, its national transpositions (in Italy D.Lgs. 138/2024) or ISO/IEC 27001: those also depend on policies, processes and systems outside Ingressi, and on how the evidence is reviewed and acted on. Every report carries this statement.

## Using it

Open **Compliance** in the sidebar (`/compliance`). The **NIS2** / **ISO/IEC 27001** switch in the header chooses which references the controls show (`?framework=iso27001`).

- **Overview**: the next scheduled report and what it will cover; the last evidence pack (or the last report made by hand) with its findings, **PDF** and **JSON** downloads, SHA-256 and whether it still matches the hash in its audit event; the live control status with its evidence; the test restores (25 to a page, `?restorePage=`); and the **incident register** (25 to a page, newest first, `?incidentPage=`). **Record an incident** (from scratch or from a recent alert), then open its details for the timeline, the Article 23(3) questions, the classification and the cause: **Assess and classify**, **Add an entry**, **Close the incident**, **Download record (PDF)** (`/print/compliance/incidents/{id}`) or the notification drafts (`/compliance/incidents/{id}`). `?incident={id}` opens one, on the page that holds it.
- **Generate report** (header): choose a report and a period (last 30 days, last calendar month or quarter, year to date, or any dates up to 366 days; times are UTC and the end date is inclusive). The report opens in the dashboard. Download it as **JSON** or as **CSV** (one table at a time: summary, findings or any section), or open the **Print / PDF** view (`/print/compliance/reports/{id}`), a black-on-white landscape document to print or save as PDF from the browser.
- **Reports** (`?tab=reports`): every stored report, newest first, 25 to a page (`&page=`), and the **report schedules** (new, edit, run now, turn on or off, delete).
- **Control mapping** (`?tab=mapping`): the table below.

Every generated report is stored until you delete it. Generating one is recorded in the audit log.

## Reports

Users, roles, certificates and host settings are shown as they are when the report is generated; sign-ins, changes and WAF activity cover the period. Each report has a summary, findings (high, medium, low, info) and tables.

### Access review

| Table | Contents |
| --- | --- |
| Users | E-mail, name, username, status, role (built-in or custom), administrator (built-in admin or an administrator-level custom role), permissions (`all` for admins), tag scope, MFA enrolment, whether the MFA policy requires it, password sign-in, linked SSO identities, break-glass account, last sign-in, sign-ins in the period, created, API tokens, forward-auth groups, direct forward-auth host access, flags |
| API tokens | Name, owner, created, expires, last used, flags. Never the token or its hash. |
| Custom roles | Permissions, tag scope, administrator-level, users |
| Forward-auth groups | Members and the hosts the group can access |
| Sign-in policies | MFA policy, grace period and deadline, enforced SSO, break-glass accounts |
| Access changes | Audit events of the period that changed users, roles, MFA, groups, forward-auth access, SSO or the MFA policy |

Findings: active administrators without MFA (high), active accounts without a recorded sign-in for more than 90 days (medium; counted from creation when there is none), API tokens of active accounts unused for more than 90 days (medium), expired tokens (low), accounts the MFA policy requires to enrol that have not (low).

Last sign-in is the latest of the recorded dashboard sign-ins in the audit log and the dashboard sessions. Sign-ins removed by audit retention are not visible.

### Change log

| Table | Contents |
| --- | --- |
| Audit log integrity | Result of verifying the whole audit log's hash chain (`ee/audit/verify.ts`) at generation: events checked, first mismatch and reason, anchor, head event and head hash, events from before the chain existed, retention |
| Events by area | Events, changes, sign-ins and other events per area (proxy hosts, certificates and mTLS, users and roles, settings, ...), with the actions |
| Events by actor | The same per actor, with the areas and first and last event |
| Events | Every event of the period (up to 5,000 listed): time, actor, kind, area, action, entity, summary, whether it is in the hash chain |

Findings: broken hash chain (high), events in the period without a hash (medium), audit retention shorter than the period (low). Event `data` is left out; the full events with their hashes are in the audit log export (audit streaming). Keep the head hash: a later copy of the log whose chain does not contain it has lost events.

### Certificate inventory

| Table | Contents |
| --- | --- |
| TLS server certificates | Imported certificates (subject, issuer, SANs, key type, serial number, SHA-256 fingerprint, validity, days left, whether the private key is stored, hosts using them), certificates managed through ACME, and hosts on automatic HTTPS |
| CA certificates (mTLS) | The same, whether it can issue (its key is stored), active and revoked client certificates |
| Issued client certificates | Common name, issuing CA, key type, serial, fingerprint, validity, status, revocation |
| Automatic certificates | The ACME CA (Let's Encrypt, or the host of a custom ACME directory) and the challenge |
| Certificate changes | Audit events of the period about certificates, CAs, client certificates and mTLS roles |

Findings: expired certificates (high when a host uses them), certificates and CAs expiring within 30 days (medium), unreadable imported certificates, unused certificates. Certificates that Caddy manages are stored by Caddy, so their serial, key type and expiry are not shown; Caddy renews them automatically. Private keys are never read or included.

### Protection coverage

| Table | Contents |
| --- | --- |
| Proxy hosts | Effective WAF (blocking, detection only or off, and whether the settings are global, the host's or an override), OWASP CRS, geo blocking, authentication in front (access list, built-in forward auth with its allowed users and groups, external forward auth, Authentik, mTLS, API keys) and whether it covers only some paths, certificate, HTTPS redirect, HSTS, upstream TLS verification, and WAF blocked and detected events in the period when ClickHouse analytics is configured |
| L4 proxy hosts | Protocol, listen address, matcher, TLS termination (the WAF and HTTP authentication do not apply) |
| Global protection settings | WAF and geo blocking |
| MFA coverage | Active users and administrators with and without MFA |

Findings: active administrators without MFA (high), enabled hosts without the WAF, without an HTTPS redirect or not verifying their HTTPS upstream (medium), WAF in detection-only mode, WAF without rules, no HSTS (low). A host without authentication can be meant to be public, so that is shown, not flagged. Disabled hosts are listed but not counted or flagged.

### Traffic questions

Generated only by report schedules that include saved analytics questions ([analytics-questions.md](analytics-questions.md)); `POST /api/v1/compliance/reports` refuses `traffic_questions`. Each question is re-run for the report's period (exactly, in the schedule's time zone) over every host, from its stored, validated query:

| Table | Contents |
| --- | --- |
| One per question, titled with the question | The query in words and a summary the dashboard writes from the figures; a total (with the previous period and the change when the question compares), the totals per day (UTC) for questions over time, or the ranked values with their counts, shares and, when comparing, the previous period |

Summary: questions, answered, not answered. A question that could not be answered (ClickHouse not configured or not answering, a host tag on no proxy host, a stored query that is no longer valid) is an info finding. No AI model is asked when the report is generated. Host tags name every proxy host that carries them when the report is generated. A question that ranks client addresses, user agents or paths puts them in the stored report.

## Control mapping

NIS2 references are to Directive (EU) 2022/2555: Article 21(2) (risk-management measures) and Article 23 (reporting). In Italy D.Lgs. 138/2024 transposes them (Articles 24 and 25), with ACN's determinations setting the detail. ISO references are to Annex A of ISO/IEC 27001:2022. The mapping lives in one file, `ee/compliance/controls.ts`; `tests/unit/compliance-controls.test.ts` keeps this table equal to it. Review it against your own risk assessment and statement of applicability.

<!-- control-mapping:start -->
| Report | Framework | Control | How it supports the control |
| --- | --- | --- | --- |
| Access review | NIS2 | Art. 21(2)(i) Human resources security, access control policies and asset management | Lists every account with its role, permissions and status for a periodic review of access rights, and flags inactive accounts and unused API tokens. |
| Access review | NIS2 | Art. 21(2)(j) Multi-factor or continuous authentication, secured voice, video and text communications and secured emergency communication systems | Shows which accounts use multi-factor authentication and flags administrators without it. |
| Access review | ISO/IEC 27001:2022 | A.5.15 Access control | Records who can use the reverse proxy's management dashboard and API, and with which permissions. |
| Access review | ISO/IEC 27001:2022 | A.5.16 Identity management | Lists every dashboard identity, its status and its linked SSO identities. |
| Access review | ISO/IEC 27001:2022 | A.5.18 Access rights | Supports the periodic review of access rights: roles, tag scopes, API tokens and group memberships. |
| Access review | ISO/IEC 27001:2022 | A.8.2 Privileged access rights | Identifies administrators and administrator-level roles. |
| Access review | ISO/IEC 27001:2022 | A.8.5 Secure authentication | Shows MFA enrolment and the sign-in methods of each account. |
| Change log | NIS2 | Art. 21(2)(b) Incident handling | A tamper-evident record of who changed what and when, as input to incident investigation. |
| Change log | NIS2 | Art. 21(2)(e) Security in network and information systems acquisition, development and maintenance, including vulnerability handling and disclosure | Records maintenance changes to the reverse proxy's configuration. |
| Change log | ISO/IEC 27001:2022 | A.8.15 Logging | Audit events of the period, with the result of the audit log's hash-chain verification. |
| Change log | ISO/IEC 27001:2022 | A.8.32 Change management | Lists changes by area and actor, for review against approved changes. |
| Change log | ISO/IEC 27001:2022 | A.8.9 Configuration management | Shows changes to the configuration of hosts, certificates and security settings. |
| Change log | ISO/IEC 27001:2022 | A.5.28 Collection of evidence | The report is hashed and its generation recorded in the hash-chained audit log, which helps preserve it as evidence. |
| Certificate inventory | NIS2 | Art. 21(2)(h) Policies and procedures regarding the use of cryptography and, where appropriate, encryption | Inventory of TLS server, CA and client certificates with issuer, key type and expiry. |
| Certificate inventory | NIS2 | Art. 21(2)(i) Human resources security, access control policies and asset management | Certificates and the hosts that use them, as managed assets. |
| Certificate inventory | ISO/IEC 27001:2022 | A.8.24 Use of cryptography | Shows key types, issuers, validity and revocation, as input to key lifecycle management. |
| Certificate inventory | ISO/IEC 27001:2022 | A.5.9 Inventory of information and other associated assets | Inventory of certificates and where they are used. |
| Protection coverage | NIS2 | Art. 21(2)(f) Policies and procedures to assess the effectiveness of cybersecurity risk-management measures | Shows coverage gaps (hosts without WAF, authentication or HSTS) as input to assessing the effectiveness of the measures. |
| Protection coverage | NIS2 | Art. 21(2)(h) Policies and procedures regarding the use of cryptography and, where appropriate, encryption | Shows HTTPS redirects, HSTS and upstream TLS verification per host. |
| Protection coverage | NIS2 | Art. 21(2)(i) Human resources security, access control policies and asset management | Shows which hosts are protected by access lists, forward auth or mTLS. |
| Protection coverage | NIS2 | Art. 21(2)(j) Multi-factor or continuous authentication, secured voice, video and text communications and secured emergency communication systems | Shows the MFA coverage of dashboard users. |
| Protection coverage | ISO/IEC 27001:2022 | A.8.20 Networks security | Shows which published hosts are behind the WAF and geo blocking. |
| Protection coverage | ISO/IEC 27001:2022 | A.8.21 Security of network services | Lists the security mechanisms of each published web service: WAF, authentication and TLS. |
| Protection coverage | ISO/IEC 27001:2022 | A.8.3 Information access restriction | Hosts whose access is restricted by access lists, forward auth or mTLS. |
| Protection coverage | ISO/IEC 27001:2022 | A.8.5 Secure authentication | MFA coverage of dashboard users and authentication in front of hosts. |
| Protection coverage | ISO/IEC 27001:2022 | A.8.24 Use of cryptography | HTTPS redirects, HSTS and upstream TLS verification per host. |
| Traffic questions | NIS2 | Art. 21(2)(f) Policies and procedures to assess the effectiveness of cybersecurity risk-management measures | Re-runs the chosen traffic questions for every period, so trends in requests, errors and mitigated requests can be reviewed as input to assessing the measures. |
| Traffic questions | NIS2 | Art. 21(2)(b) Incident handling | Keeps aggregated traffic figures of each period, a baseline when investigating incidents. |
| Traffic questions | ISO/IEC 27001:2022 | A.8.16 Monitoring activities | Documents a recurring review of the traffic of published web services, from aggregated figures only. |
| Traffic questions | ISO/IEC 27001:2022 | A.5.28 Collection of evidence | The figures are stored in a hashed report whose generation is recorded in the hash-chained audit log. |
| Incident notification drafts | NIS2 | Art. 21(2)(b) Incident handling | Structured preparation of incident notifications from collected facts. |
| Incident notification drafts | NIS2 | Art. 23 Reporting obligations (early warning, incident notification, final report) | Drafts of the early warning, incident notification and final report, with their deadlines. |
| Incident notification drafts | ISO/IEC 27001:2022 | A.5.5 Contact with authorities | Records when each notification was submitted to the CSIRT or authority, with its reference. |
| Incident notification drafts | ISO/IEC 27001:2022 | A.5.24 Information security incident management planning and preparation | A prepared, deadline-tracked notification workflow. |
| Incident notification drafts | ISO/IEC 27001:2022 | A.5.25 Assessment and decision on information security events | Collects aggregated facts (WAF, traffic, alerts, changes) that support assessing the event. |
| Incident notification drafts | ISO/IEC 27001:2022 | A.5.26 Response to information security incidents | Supports the communication part of the incident response. |
<!-- control-mapping:end -->

## Integrity

Every report records its generation time, the user who generated it (id, name and e-mail at that time), the product name and version, the instance mode and a random report id. The report is stored as canonical JSON (RFC 8785, JSON Canonicalization Scheme: sorted keys, no whitespace) together with the SHA-256 of that text, and generation adds an audit event (`compliance_report_generated`) with the same SHA-256. Audit events are hash-chained, so the recorded hash cannot be changed unnoticed.

The report page shows whether the stored report still matches its SHA-256 and whether that matches the audit event. A downloaded JSON report has an `integrity` member with the SHA-256; to check a copy, remove that member, canonicalize the rest with any RFC 8785 library and hash it:

```bash
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const { integrity, ...doc } = r;
const c = (v) => v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? "[" + v.map(c).join(",") + "]"
  : "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + c(v[k])).join(",") + "}";
const hash = require("crypto").createHash("sha256").update(c(doc)).digest("hex");
console.log(hash === integrity.sha256 ? "intact" : "CHANGED", hash);
' access-review-2026-09-01_2026-09-30-12.json
```

CSV files are views of the report and carry no hash of their own; the `summary` table includes the JSON report's SHA-256. Downloads also send it in the `X-Report-Sha256` header. Deleting a report is recorded in the audit log with its SHA-256.

## Report schedules

A schedule generates its reports every week (on a weekday, for the seven days before the day it runs) or every month (on day 1 to 28, for the previous calendar month), at a time of day in an IANA time zone. Each run:

1. verifies the audit log's hash chain and records the result in the audit log (`audit_log_verified`, by no user), which the "Audit log integrity verified" control reads;
2. generates each chosen report for the period, stores it and records its SHA-256 in the audit log exactly like a report made by hand, with `scheduleId` and a `packId` shared by the reports of the run (the **evidence pack**); `generatedBy` names the schedule. With saved questions in the schedule, the pack also has a **Traffic questions** report;
3. sends a short notice to the chosen alert channels (e-mail, Slack, Teams, webhook, ntfy; never PagerDuty): the findings per report, the SHA-256 digests, the chain check and a link to the Compliance page. Report contents (users, token names, hosts) are never sent; they stay in the dashboard;
4. records the run on the schedule (`lastRunAt`, `lastStatus` `success` | `partial` | `failed`, `lastPackId`, the deliveries) and in the audit log (`compliance_evidence_pack_generated`).

The run is claimed before it starts, so a slow or failing run is never repeated; the next run is at the next occurrence. A scheduler checks every five minutes (started from `src/instrumentation.ts`, never in tests). **Run now** (`POST /api/v1/compliance/schedules/{id}/run`) generates the reports for the week or month that has ended, by the caller.

**Traffic questions** in the schedule dialog (`questionIds`, at most 10) lists the saved analytics questions you can see (your own and the shared ones). The schedule keeps a copy of each question and its query as it is when the schedule is saved; saving the schedule again refreshes the copies of questions that still exist, and keeps the others. A schedule needs at least one report or question.

Schedules (`compliance_report_schedules`) are master-local and not synced. At most 20.

## Live control status

`GET /api/v1/compliance/controls/status` checks the running install. Each control has a status (`met`, `attention`, `not_met`, `unknown`), a short label ("Due in 3 days", "Overdue"), what was checked, the evidence (the newest report of the matching type, the pages and records) and its NIS2 and ISO/IEC 27001 references. Like a report, a status is evidence that can support the control, not proof that it is in place.

| Control | Met when | NIS2 | ISO/IEC 27001 |
| --- | --- | --- | --- |
| TLS on every host | Every enabled proxy host redirects HTTP to HTTPS and has a valid certificate (imported, or obtained by Caddy and read from it, see [alerting.md](alerting.md)); attention when one expires within 14 days, a renewal is overdue or Caddy's certificates could not be checked | Art. 21(2)(h) | A.8.24 |
| MFA for administrators | Every active administrator (built-in or administrator-level custom role) who signs in with a password here has a second factor; attention when some sign in through single sign-on only (the identity provider decides their second factor) | Art. 21(2)(j) | A.8.5 |
| Audit log integrity verified | The hash chain was verified in the last 31 days and was intact; not met when the last verification found a mismatch | Art. 21(2)(b) | A.8.15 |
| Backups restored in a test | A successful test restore was recorded, or a backup was restored, in the last 90 days, and scheduled backups are set up and not failing | Art. 21(2)(c) | A.8.13 |
| Access reviews completed | A review was completed in the last 100 days and none is overdue; attention while one is due within 7 days | Art. 21(2)(i) | A.5.18 |
| WAF blocking on internet-facing hosts | Every enabled proxy host has the WAF in blocking mode. Ingressi cannot tell which hosts are reachable from the internet, so every enabled proxy host counts | Art. 21(2)(e) | A.8.20 |

## Test restores

Restoring a backup as a test usually happens on a spare instance, outside this one. Record it with `POST /api/v1/compliance/restore-tests` (`testedAt`, `source` `backup` | `snapshot` | `export` | `other`, `outcome` `success` | `partial` | `failed`, optionally the backup destination, the object key and notes). The record (`compliance_restore_tests`) names who recorded it. A restore from a backup made on this install (`config_backup_restored` in the audit log) counts too.

## Incident register

Every security event can be recorded, significant or not. An incident has:

- its window: `startedAt` and `endedAt` (not before the start; null while unknown or ongoing), and `detectedAt`, when you became aware of it, from which the notification deadlines run;
- a **timeline**: the entries people add (`{at, text}`) and entries from the collected facts (became aware, first and last WAF event, busiest hour, alerts fired and resolved, configuration changes), oldest first;
- the **significance assessment** of NIS2 Article 23(3), as answers (`yes`, `no`, `unknown`) with reasons: did it cause, or can it cause, severe operational disruption or financial loss (`severeDisruption`), or considerable damage to others (`considerableDamage`)? Two more answers go into the early warning: suspected unlawful or malicious acts (`suspectedMalicious`) and cross-border impact (`crossBorderImpact`); while the early warning's own choices are unknown they follow these answers;
- `suggestedClassification`, what the deciding answers suggest, and the **classification** a person makes (`undetermined`, `not_significant`, `significant`), recorded with who made it and when (`compliance_incident_classified` in the audit log);
- the **cause**, and `closedAt` when it is closed;
- `notification`: `not_required` for an incident that is not significant, `required` until every stage of a significant one is submitted, then `submitted`.

## Incident notification drafts

NIS2 Article 23 has three stages, counted from when the organisation **became aware** of the significant incident:

| Stage | Deadline | Contents |
| --- | --- | --- |
| Early warning (Art. 23(4)(a)) | 24 hours | Whether the incident is suspected of being caused by unlawful or malicious acts and whether it could have a cross-border impact |
| Incident notification (Art. 23(4)(b)) | 72 hours | Update of the early warning, initial assessment (severity, impact), indicators of compromise where available |
| Final report (Art. 23(4)(d)) | One month after the incident notification | Detailed description with severity and impact, type of threat or root cause, applied and ongoing mitigation, cross-border impact |

The final report's deadline runs from the time you record for the incident notification's submission; until then, from its 72-hour deadline. If the incident is still ongoing when the final report is due, Article 23 asks for a progress report then and the final report within one month of handling the incident; an intermediate report can also be requested by the CSIRT. In Italy, D.Lgs. 138/2024 (Art. 25) sets the same stages and the notifications go to CSIRT Italia at ACN.

**Nothing is sent from Ingressi.** A person copies each stage into the CSIRT's or authority's channel and records here when it was submitted and the reference received.

### Facts

A draft starts from a time range (by default the 24 hours before you became aware, up to now; at most 31 days), optionally an alert event and the affected proxy hosts. It collects aggregated figures only:

- from ClickHouse, when analytics is configured: requests, unique clients, responses by status class, geo-blocked requests, WAF events (blocked and detection only, first and last event, busiest hour), the top WAF rules with their messages, the most targeted hosts and paths (no query strings) and the source countries;
- the source alert and the alerts of the period;
- the configuration changes of the period from the audit log.

Never log lines, client addresses or request contents. **Collect again** refreshes them; changing the period or hosts does it on save.

### Template and AI first draft

A new draft fills every stage from a structured template (English or Italian): the facts in plain sentences and bracketed placeholders for what only you can know. **Fill from template** does it again for one stage.

**Draft with AI** asks the AI provider configured for the AI analyst (AI settings, your own model: Anthropic or an OpenAI-compatible server on your network) for a first draft of one stage. The rules of the AI analyst apply:

- the model receives the stage's legal requirements and the aggregated facts only, without who made each change;
- the facts are untrusted (titles, host names, paths, rule messages, alert titles and change summaries can come from users, logs or requests): they travel as JSON inside a data block delimited by a tag with a random id, with `<` and `>` escaped, and the system prompt tells the model never to follow instructions inside it;
- the model gets no tools, one call and the AI provider's timeout, and must answer with a JSON object of the stage's text fields; anything else is discarded;
- it never fills the yes/no judgements (malicious, cross-border), and it is told not to invent facts and to leave placeholders;
- the stage is labelled **AI-generated first draft** (with provider, model and time) in the dashboard, the API and the print view, and **edited** once a person changes it.

Asking for an AI draft is recorded in the audit log (stage, provider, model, success), never the text.

## REST API

All endpoints accept a Bearer token or the dashboard session. OpenAPI tag **Compliance**.

| Method and path | Permission | Notes |
| --- | --- | --- |
| `GET /api/v1/compliance/controls` | `compliance:read` | The control mapping |
| `GET /api/v1/compliance/controls/status` | `compliance:read` | Live control status |
| `GET /api/v1/compliance/schedules` | `compliance:read` | Schedules with their next run and last evidence pack |
| `POST /api/v1/compliance/schedules` | `compliance:write` | `{name, frequency, weekday?, dayOfMonth?, time?, timeZone?, reportTypes?, questionIds?, channelIds?, enabled?}`; `201` |
| `GET /api/v1/compliance/schedules/{id}` | `compliance:read` | |
| `PUT /api/v1/compliance/schedules/{id}` | `compliance:write` | Partial |
| `DELETE /api/v1/compliance/schedules/{id}` | `compliance:write` | `204`; the reports are kept |
| `POST /api/v1/compliance/schedules/{id}/run` | `compliance:write` | Generates the pack for the week or month that ended |
| `GET /api/v1/compliance/packs` | `compliance:read` | Evidence packs, newest first |
| `GET /api/v1/compliance/restore-tests` | `compliance:read` | `?page=&perPage=` |
| `POST /api/v1/compliance/restore-tests` | `compliance:write` | `{testedAt, source, outcome, backupDestinationId?, backupObjectKey?, notes?}`; `201` |
| `DELETE /api/v1/compliance/restore-tests/{id}` | `compliance:write` | `204` |
| `GET /api/v1/compliance/reports` | `compliance:read` | `?type=&packId=&page=&perPage=`, without content |
| `POST /api/v1/compliance/reports` | `compliance:write` | `{type, from?, to?, format?}` (not `traffic_questions`); `201` with the report, or its first table with `format: "csv"` |
| `GET /api/v1/compliance/reports/{id}` | `compliance:read` | The report with the integrity check |
| `DELETE /api/v1/compliance/reports/{id}` | `compliance:write` | `204` |
| `GET /api/v1/compliance/reports/{id}/export` | `compliance:read` | `?format=json` (with `integrity`) or `?format=csv&section=` |
| `GET /api/v1/compliance/incidents` | `compliance:read` | The register: `?status=open\|closed&page=&perPage=`, with window, classification, notification status and the next stage due |
| `POST /api/v1/compliance/incidents` | `compliance:write` | `{title?, detectedAt?, from?, to?, alertEventId?, proxyHostIds?, language?, startedAt?, endedAt?, assessment?, classification?, cause?, timeline?}`; `201` |
| `GET /api/v1/compliance/incidents/{id}` | `compliance:read` | With facts, stages and deadlines |
| `PUT /api/v1/compliance/incidents/{id}` | `compliance:write` | Partial: `title`, `status` (`open`/`closed`), `language` (`en`/`it`), `detectedAt`, `from`, `to`, `proxyHostIds`, `stages.<stage>.{fields, submittedAt, reference}`, `startedAt`, `endedAt`, `assessment.<question>.{answer, reason}`, `classification`, `cause`, `timeline` (replaces the entries people added) |
| `DELETE /api/v1/compliance/incidents/{id}` | `compliance:write` | `204` |
| `POST /api/v1/compliance/incidents/{id}/facts` | `compliance:write` | Collect the facts again |
| `POST /api/v1/compliance/incidents/{id}/draft` | `compliance:write` | `{stage, source: "template" \| "ai"}`; `400` without an AI provider, `502` when the provider fails |

`from` and `to` are ISO 8601 dates (`2026-09-01`; a bare `to` date means the end of that day) or date-times with a time zone. `to` defaults to now and is capped at now; for reports `from` defaults to 30 days before `to`.

```bash
# Last month's access review as JSON, stored and hashed
curl -X POST https://dash.example.com/api/v1/compliance/reports -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"type":"access_review","from":"2026-09-01","to":"2026-09-30"}'
# Its users table as CSV
curl -OJ "https://dash.example.com/api/v1/compliance/reports/12/export?format=csv&section=users" -H "Authorization: Bearer $TOKEN"
# Record that the early warning was submitted
curl -X PUT https://dash.example.com/api/v1/compliance/incidents/3 -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"stages":{"early_warning":{"submittedAt":"2026-09-30T07:40:00Z","reference":"CSIRT-2026-0042"}}}'
```

## Permissions

The permission area is `compliance` (`read`, `write`), and it covers every host. Reports list every user, API token name and host, and the change log every audit event of the period: grant `compliance:read` as you would `users:read` and `audit_log:read` together. A role's tag scope does not limit it. `compliance:write` lets a role generate reports and edit incident drafts, and shows it recent alert titles and proxy host names to start a draft from; it does not change anything else. With it a role can also add the saved analytics questions it can see to a schedule, without `analytics:read`; their figures then cover every host, like every report. Asking questions and saving them needs `analytics:read` ([analytics-questions.md](analytics-questions.md)).

## Security notes

- Reports never contain secrets: no token, token hash, password or password hash, TOTP secret or backup code, private key (imported, CA or ACME), OAuth or DNS provider credential, or session. The tests check every report, export and CSV table against such values.
- CSV cells that a spreadsheet would run as a formula (starting with `=`, `+`, `-`, `@`, tab or carriage return) get a leading apostrophe.
- The dashboard and print views render report values as text.
- Report and draft data is master-local: it is not synced to slave instances (it is not configuration and there is no settings group to sync), and it is not part of configuration export, history or backups.

## Limits

- The change log lists at most 5,000 events and groups at most 50,000; it says so when a period has more. The access review lists at most 2,000 access changes.
- Report periods span at most 366 days, incident fact periods at most 31 days. ClickHouse keeps 90 days by default.
- Certificates managed by Caddy (ACME, automatic HTTPS) are stored by Caddy, so their expiry is not in the inventory report; the TLS control and the certificate expiry alert read them from Caddy with a TLS handshake.
- Coverage is read from the configuration. It shows what is set up, not whether the applications behind it are secure.
- Notices of a report schedule carry the findings and digests, never the reports themselves.
