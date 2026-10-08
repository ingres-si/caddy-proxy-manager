# Users and groups

**Users and groups** (Users and sign-in in the sidebar) has three tabs: **Users**, **Groups** and **Roles**. `/users` opens the first, `/groups` the second and `/users?tab=roles` the third; `/users?user=<id>` opens a user's panel. Each tab needs its own permission: Users `users:read`, Groups `groups:read`, Roles `users:read`.

## Users

One row per account, newest first, 25 to a page; the page is kept in the address (`/users?page=2`). A search or a filter starts again at the first page.

- **User:** name, e-mail and sign-in username. Tags mark you, the primary admin (the account `ADMIN_USERNAME` manages) and break-glass accounts of enforced SSO.
- **Role:** a built-in role or a custom role with its permission count and tag scope. When an LDAP directory or SAML provider with group mappings, or SCIM with **Manage roles**, sets the role, the line says so: a role you choose here is replaced at their next sign-in.
- **Comes from:** Local (a password), OIDC, SAML, LDAP and SCIM, with the provider or directory by name. An account with none of them only uses API tokens.
- **Second factor:** authenticator app, passkey, at the identity provider (the account signs in only through OIDC or SAML, so the provider asks for its own), not needed (it cannot sign in to the dashboard), or **None**. None is red for administrators and for accounts the MFA policy has locked out.
- **Last sign-in:** when and how the last dashboard sign-in completed. A token-only account shows when one of its API tokens was last used.
- **Status:** active, invited (never signed in, no token used) or disabled, with the date it was disabled. The date is recorded whichever way the account was disabled (here, the REST API, SCIM or an access review); accounts disabled before Ingressi recorded it show no date.

Search looks in names, e-mails, usernames, roles and sources. **Administrators** lists the admin role and administrator-level custom roles; **Invited or disabled** the accounts nobody uses.

A banner names any active administrator who can sign in with a password and has no second factor, with **Change role** and **Disable account**. The MFA policy line under it opens **Edit policy** (`mfa_policy:write`); see `documentation/mfa.md`.

### A user's panel

Click a name, or **Open details** in the row menu:

- **Role:** change it (`users:write`). You cannot change your own.
- **Details:** name, e-mail and the sign-in username, saved together.
- **Multi-factor authentication:** authenticator app with backup codes left, passkeys and what the policy asks. **Reset MFA** removes all of them; their sessions are kept.
- **Sessions:** every browser signed in, with device, place and times. **Sign out** ends one; **Sign out everywhere** ends all (for your own account, all but this one). API tokens are not affected.
- **Account:** **Disable user** ends their dashboard and forward-auth sessions and stops their API tokens until you enable them again; **Delete user** removes the account.

Every change is recorded in the audit log, and the same guards apply as through the REST API: you cannot change your own role or status, the last active administrator stays, and the last break-glass administrator of enforced SSO stays until it is taken off the break-glass list.

**Add user** creates a local account with a password. Directory, SAML and SCIM accounts arrive on their own.

## Groups

The groups are listed by name, 25 to a page (`/groups?page=2`); the search looks in names, descriptions and members. A group's members dialog lists 10 members at a time, with a search once there are more; **Add a user to this group** shows the first 50 users that match its search.

Forward-auth groups decide who gets through the sign-in portal of hosts protected by forward auth ([forward-auth.md](forward-auth.md)). Every request to such a host checks the user's access again, so removing a member, deleting a group or taking a host's grant away refuses the next request. With high availability shared state (`ee/docs/high-availability.md`) the sessions this takes access from are also ended on every web node at once. Each row shows the members, whether SCIM manages the group, the dashboard role a SCIM group-to-role mapping gives (with `scim:read`) and the hosts that let the group in (with `proxy_hosts:read`, only hosts in your tag scope). **Manage members** adds and removes people; **Edit group** renames it. A name is required, at most 100 characters and unique; when a change is refused, the dialog says why (the name is taken, the person is already a member, the group is gone), and `POST /api/v1/groups` and `PATCH /api/v1/groups/{id}` refuse the same input with 400 or 409, and adding a member twice answers 409.

Adding someone to a SCIM group by hand changes what they can reach, never their role: only memberships the identity provider sends count for role mappings.

## Roles

Built-in roles are described (see [Built-in roles](#built-in-roles) below); custom roles show their permissions grouped by area, their tag scope and who holds them. See `ee/docs/custom-roles.md`.

## Built-in roles

Ingressi has three roles with increasing privileges:

| Capability | Viewer | User | Admin |
|------------|:------:|:----:|:-----:|
| Log in to the dashboard | Yes | Yes | Yes |
| View own profile | Yes | Yes | Yes |
| Access forward-auth-protected apps (when granted) | Yes | Yes | Yes |
| Manage proxy hosts, certificates, access lists | No | No | Yes |
| Manage users, groups, and settings | No | No | Yes |
| View analytics, audit log, and API docs | No | No | Yes |
| Create and manage own API tokens | Yes | Yes | Yes |
| Access role-appropriate REST API endpoints (`/api/v1/`) | Yes | Yes | Yes |

New users default to the **user** role.

> **Forward auth access** is separate from the role: every role, administrators included, needs to be granted access to each protected host in the forward auth access list ([forward-auth.md](forward-auth.md#per-host-access-control)).

### The primary admin

The initial admin account is created from the `ADMIN_USERNAME` / `ADMIN_PASSWORD` environment variables on the first start. Deleting it is permanent: a restart does not create it again, only changing `ADMIN_PASSWORD` or `ADMIN_USERNAME` does (account recovery, below). The variables are applied again only when they change, so a password later changed in the UI is kept across restarts. To recover a lost admin password, change `ADMIN_PASSWORD` (or `ADMIN_USERNAME`) and recreate the web container (`docker compose up -d`; `docker compose restart` keeps the old values): this resets the primary admin's password and its username to `ADMIN_USERNAME`, restores its admin role, re-activates it if it was disabled, and, when the password changed, signs out all of its dashboard and forward-auth sessions. A new `ADMIN_USERNAME` that another account already signs in with, or has as its email address (also as `<ADMIN_USERNAME>@localhost`), is not applied: nothing changes and the start logs `ADMIN_USERNAME "…" is not applied` until that account's username or email is changed or another `ADMIN_USERNAME` is chosen.

### Deleting a user

Deleting a user (**Users** page or `DELETE /api/v1/users/:id`) also deletes their sessions, the API tokens they created, their sign-in methods (password and OAuth accounts) and pending OAuth links, their forward-auth sessions and access grants, and their group memberships. Proxy hosts, L4 hosts, certificates, CAs, client certificates, access lists, mTLS roles and rules, and groups they owned or created are kept without an owner, and their audit log entries are kept without a user.

### API tokens

API tokens can only be created from an authenticated dashboard session; an existing bearer token cannot mint replacement credentials. Viewer and user tokens are restricted to the same user-scoped API capabilities as their owner.

## REST API

| Method and path | Permission | What |
| --- | --- | --- |
| `GET /api/v1/users/overview` | `users:read` | Every account as the Users tab shows it: `sources`, `secondFactor`, `roleManagedBy`, `administrator`, `breakGlass`, `primaryAdmin`, `apiTokenLastUsedAt`, and the MFA policy (null without `mfa_policy:read`). |
| `GET /api/v1/groups/overview` | `groups:read` | Every group with members, `scim`, `roleMappings` (null without `scim:read`) and `hosts` (null without `proxy_hosts:read`). |
| `GET /api/v1/users/{id}/sessions`, `DELETE …` | `users:read`, `users:write` | A user's sessions; see `documentation/profile.md`. |
| `GET /api/v1/users/{id}/mfa`, `DELETE …` | `users:read`, `users:write` | A user's MFA state and the reset; see `documentation/mfa.md`. |

Neither overview returns a password hash, secret or token value.
