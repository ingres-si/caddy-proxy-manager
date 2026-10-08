# Host tags

Proxy hosts and L4 proxy hosts can carry free-form **tags**, such as `team-a`, `production` or `eu/west`.

Tags alone change nothing: Caddy's configuration does not use them. They label hosts in the lists, the search on the Proxy Hosts and L4 Proxy Hosts pages also matches them, and a custom role (`ee/docs/custom-roles.md`) can be limited to hosts that carry one of its tags.

## Rules

- A tag starts with a letter or a digit and contains only letters, digits and `.` `_` `:` `/` `-` (no spaces), at most 40 characters.
- Tags are stored lowercased, without duplicates, sorted. A host has at most 16 tags.
- In the proxy host and L4 host editors, add them one by one under **Tags** (Enter or comma after each).

## REST API

Proxy host (`/api/v1/proxy-hosts`) and L4 proxy host (`/api/v1/l4-proxy-hosts`) responses carry `tags` (an array of strings). Create and update bodies accept `tags` as an array of strings; on update, leaving `tags` out keeps the current tags and `[]` or `null` removes them. An invalid tag answers `400`.

```bash
curl -X PUT https://dash.example.com/api/v1/proxy-hosts/12 -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"tags": ["team-a", "production"]}'
```

When the caller's custom role is limited to tags, it may only add or remove its own tags and must leave at least one of them on the host; see `ee/docs/custom-roles.md`.

## Sync, export and history

Tags are part of the host rows: instance sync sends them to slaves, and configuration export, import, history and backups include them. A master older than host tags sends hosts without tags; the slave stores them with none.
