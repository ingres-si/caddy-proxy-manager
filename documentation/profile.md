# Profile, sessions and API tokens

**Profile** (the account menu) is where you manage your own account: your picture, how you sign in, where you are signed in, your API tokens and how the dashboard shows times and numbers. Nothing on it changes anyone else's account.

## Account

- **Picture:** a square image up to 2 MB.
- **Name and e-mail** show in the audit log and on approvals. An administrator changes them on **Users**; you cannot rename yourself, because the name and e-mail also reach the applications behind forward auth.
- **Signs in with** lists your password and the identity providers your account is linked to. Linking and unlinking a provider works as before.

## Sign-in security

Your password, authenticator app and passkeys. See `documentation/mfa.md` for multi-factor authentication and passkeys.

## Sessions

**Active sessions** lists every browser signed in to your account, the one you are using first ("This device"):

- **Device:** browser and operating system, read from the User-Agent. Best effort.
- **Place:** the country and the network (AS number and operator) of the address the session signed in from, looked up in the GeoLite2 Country and ASN databases the geo blocker uses. Nothing is stored: the session keeps only the address and the User-Agent, as before, and the place is looked up each time the list is shown. Without the databases the place is "Unknown place".
- **Last seen:** the session's last request, to the minute.
- **Signed in:** when the session was created.

The list shows 25 sessions a page; the page is in the address (`?sessions=2`), so reloading keeps it.

**Sign out** ends one session; **Sign out all other sessions** ends every one except yours. Those browsers have to sign in again. Both are recorded in the audit log (`session_revoked`, `sessions_revoked`).

Administrators, and custom roles with `users:read` / `users:write`, can do the same for another user through the REST API. Signing out someone else's sessions needs every permission that user's role holds, like any other change to a user.

## API tokens

Tokens are for scripts and tools, sent as `Authorization: Bearer <token>`. A token acts as you, with your current role.

- **Scopes:** a token can be limited to some of your permissions, for example `proxy_hosts:read`. On every request it holds your current permissions **intersected with** its scopes: it can never do more than your role, and if your role loses a permission, the token loses it too. A write scope includes its read (`proxy_hosts:write` can also read proxy hosts). Your tag scope, if you have one, still applies.
  - **Same as my role:** no scopes; the token has your role's access, as tokens always had.
  - **Read only:** every read permission your role holds when you create the token.
  - **Choose permissions:** any of the permissions your role holds.
- **A token with scopes is never an administrator**, even yours. Endpoints that only administrators can use, and the endpoints for your own account (sessions, tokens, passkeys, preferences, MFA state, access review assignments), refuse it with `403`. Use a session or a token without scopes for them.
- **Expiry:** in 30 days, 90 days, a year, or never. An expired token stops working; delete it from the list.
- **At most 10 tokens** per account. The token is shown once, right after it is created.
- **Creating a token** needs a session; a token cannot create another one.

Creating and revoking a token are recorded in the audit log (`api_token_created`, `api_token_deleted`).

## Interface

- **Theme:** system, dark or light.
- **Time zone:** any IANA time zone; UTC by default.
- **Number format:** `1,234.5`, `1.234,5` or `1 234,5`.
- **Default list order:** the initial sort column and direction for Proxy Hosts, L4 Proxy Hosts and Client Certificates. **Application default** keeps each list's built-in behavior. Where a list stores sorting in its URL, explicit sort parameters take precedence.

All interface preferences follow your account to every browser. Exports, the audit log export and the REST API stay in UTC with plain numbers. Changes are recorded as `preferences_updated`.

For developers: client components get formatters bound to the signed-in account from `useFormat()` (`src/components/preferences/PreferencesProvider.tsx`), built on `formatDateTime`, `formatDate`, `formatTime`, `formatNumber` and `formatPercent` in `src/lib/date-format.ts`.

## Last sign-in and invited accounts

Every account records when and how it last completed a dashboard sign-in: with a password, through single sign-on (OAuth/OpenID Connect), SAML, an LDAP directory, or with a passkey. A password step that still waits for its second factor does not count. Accounts that signed in before this release take the time from the audit log or their newest session.

An account is **invited** while it is active, has never signed in to the dashboard and none of its API tokens has been used: an administrator created it or SCIM provisioned it, and nobody uses it yet. The Users page and the users API show both (`lastSignInAt`, `lastSignInMethod`, `invited`).

## REST API

| Method and path | Who | What |
| --- | --- | --- |
| `GET /api/v1/sessions` | Any user | Your sessions, with `device`, `location`, `signedInAt`, `lastSeenAt` and `current` |
| `DELETE /api/v1/sessions` | Any user | Sign out your other sessions |
| `DELETE /api/v1/sessions/{id}` | Any user | Sign out one of your sessions |
| `GET /api/v1/users/{id}/sessions` | `users:read` | A user's sessions |
| `DELETE /api/v1/users/{id}/sessions` | `users:write` | Sign out all of a user's sessions (your own current one is kept) |
| `DELETE /api/v1/users/{id}/sessions/{sessionId}` | `users:write` | Sign out one of a user's sessions |
| `GET /api/v1/tokens` | Any user | Your tokens with their `scopes` (administrators: every user's) |
| `POST /api/v1/tokens` | Any user, session only | `{"name", "scopes"?, "expiresIn"?: "30d" \| "90d" \| "365d" \| "never", "expires_at"?}` |
| `DELETE /api/v1/tokens/{id}` | Any user | Revoke one of your tokens (administrators: anyone's) |
| `GET /api/v1/preferences` | Any user | Your theme, time zone, number format and default list ordering |
| `PUT /api/v1/preferences` | Any user | Change any interface preference |

```bash
curl -X POST https://proxy.example.com/api/v1/tokens \
  -H "Content-Type: application/json" -H "Origin: https://proxy.example.com" -b cookies.txt \
  -d '{"name": "Terraform", "scopes": ["proxy_hosts:write", "certificates:read"], "expiresIn": "90d"}'
```

A scope your role does not hold, an unknown permission, an empty list, an unknown `expiresIn` or both `expiresIn` and `expires_at` answer `400`. Sessions, tokens and preferences are per dashboard, like users: they are not synchronized to sync slaves.
