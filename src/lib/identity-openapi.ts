/**
 * OpenAPI paths and schemas of the identity endpoints (passkeys, interface
 * preferences, a user's sessions), spread into
 * app/api/v1/openapi.json/route.ts.
 */
import { NUMBER_FORMATS, THEMES } from "./preferences-shared";
import {
  CLIENT_CERTIFICATE_SORT_PREFERENCES,
  L4_PROXY_HOST_SORT_PREFERENCES,
  PROXY_HOST_SORT_PREFERENCES,
} from "./list-sort-preferences";

export const PASSKEYS_OPENAPI_TAG = {
  name: "Passkeys",
  description:
    "Your passkeys (WebAuthn) for dashboard sign-in. A passkey asks for your PIN or biometrics, so it counts as " +
    "multi-factor authentication. Adding one is a ceremony in the browser through Better Auth's " +
    "/api/auth/passkey/generate-register-options and /api/auth/passkey/verify-registration (session and password); " +
    "signing in uses /api/auth/passkey/generate-authenticate-options and /api/auth/passkey/verify-authentication. " +
    "These endpoints need a session or a token without scopes.",
};

export const PREFERENCES_OPENAPI_TAG = {
  name: "Preferences",
  description: "Your interface preferences: theme, time zone, number format and default ordering of sortable lists. They follow your account to every browser.",
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });
const errors = (...codes: string[]) => {
  const map: Record<string, unknown> = {
    "400": { $ref: "#/components/responses/BadRequest" },
    "401": { $ref: "#/components/responses/Unauthorized" },
    "403": { $ref: "#/components/responses/Forbidden" },
    "404": { $ref: "#/components/responses/NotFound" },
  };
  return Object.fromEntries(codes.map((code) => [code, map[code]]));
};

const userIdParameter = { name: "id", in: "path", required: true, schema: { type: "integer" }, description: "User id" };

export const IDENTITY_OPENAPI_PATHS = {
  "/api/v1/passkeys": {
    get: {
      tags: [PASSKEYS_OPENAPI_TAG.name],
      summary: "List your passkeys",
      description: "Never returns a public key or a credential id.",
      operationId: "listPasskeys",
      responses: { "200": { description: "Your passkeys", content: json(ref("PasskeyList")) }, ...errors("401", "403") },
    },
  },
  "/api/v1/passkeys/{id}": {
    patch: {
      tags: [PASSKEYS_OPENAPI_TAG.name],
      summary: "Rename one of your passkeys",
      operationId: "renamePasskey",
      parameters: [{ $ref: "#/components/parameters/IdPath" }],
      requestBody: {
        required: true,
        content: json({
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: { name: { type: "string", minLength: 1, maxLength: 64 } },
        }),
      },
      responses: { "200": { description: "The passkey", content: json(ref("Passkey")) }, ...errors("400", "401", "403", "404") },
    },
    delete: {
      tags: [PASSKEYS_OPENAPI_TAG.name],
      summary: "Remove one of your passkeys",
      description:
        "400 when it is the last second factor (no authenticator app, no other passkey) of an account the MFA policy covers. " +
        "Recorded as passkey_removed.",
      operationId: "removePasskey",
      parameters: [{ $ref: "#/components/parameters/IdPath" }],
      responses: { "204": { description: "Removed" }, ...errors("400", "401", "403", "404") },
    },
  },
  "/api/v1/preferences": {
    get: {
      tags: [PREFERENCES_OPENAPI_TAG.name],
      summary: "Get your interface preferences",
      operationId: "getPreferences",
      responses: { "200": { description: "Your preferences", content: json(ref("Preferences")) }, ...errors("401", "403") },
    },
    put: {
      tags: [PREFERENCES_OPENAPI_TAG.name],
      summary: "Change your interface preferences",
      description: "Fields left out keep their values; unknown fields are refused. Recorded as preferences_updated.",
      operationId: "updatePreferences",
      requestBody: { required: true, content: json(ref("PreferencesInput")) },
      responses: { "200": { description: "Your preferences", content: json(ref("Preferences")) }, ...errors("400", "401", "403") },
    },
  },
  "/api/v1/users/{id}/sessions": {
    get: {
      tags: ["Users"],
      summary: "List a user's active sessions",
      description: "Permission users:read. Device and approximate place are worked out when asked, never stored.",
      operationId: "listUserSessions",
      parameters: [userIdParameter],
      responses: {
        "200": { description: "The user's active sessions", content: json({ type: "array", items: ref("Session") }) },
        ...errors("401", "403", "404"),
      },
    },
    delete: {
      tags: ["Users"],
      summary: "Sign out all of a user's sessions",
      description:
        "Permission users:write, and the caller must hold every permission of the user's role. Naming yourself keeps the " +
        "session making the request. Recorded as sessions_revoked.",
      operationId: "revokeUserSessions",
      parameters: [userIdParameter],
      responses: {
        "200": {
          description: "How many sessions were signed out",
          content: json({ type: "object", properties: { revoked: { type: "integer" } }, required: ["revoked"] }),
        },
        ...errors("401", "403", "404"),
      },
    },
  },
  "/api/v1/users/{id}/sessions/{sessionId}": {
    delete: {
      tags: ["Users"],
      summary: "Sign out one of a user's sessions",
      description: "Permission users:write. Recorded as session_revoked.",
      operationId: "revokeUserSession",
      parameters: [
        userIdParameter,
        { name: "sessionId", in: "path", required: true, schema: { type: "integer" }, description: "Session id" },
      ],
      responses: { "200": { $ref: "#/components/responses/Ok" }, ...errors("401", "403", "404") },
    },
  },
} as const;

export const IDENTITY_OPENAPI_SCHEMAS = {
  Session: {
    type: "object",
    description: "An active dashboard session.",
    properties: {
      id: { type: "integer" },
      current: { type: "boolean", description: "The session making this request" },
      signedInAt: { type: "string", format: "date-time" },
      lastSeenAt: { type: "string", format: "date-time", description: "The session's last request, to the minute" },
      expiresAt: { type: "string", format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      ipAddress: { type: ["string", "null"], description: "The address the session signed in from" },
      userAgent: { type: ["string", "null"] },
      device: ref("SessionDevice"),
      location: { oneOf: [ref("SessionLocation"), { type: "null" }] },
    },
    required: ["id", "current", "signedInAt", "lastSeenAt", "expiresAt", "ipAddress", "userAgent", "device", "location"],
  },
  SessionDevice: {
    type: "object",
    description: "Read from the User-Agent; best effort.",
    properties: {
      browser: { type: ["string", "null"], example: "Firefox" },
      os: { type: ["string", "null"], example: "Linux" },
      kind: { type: "string", enum: ["desktop", "mobile", "tablet", "unknown"] },
      label: { type: "string", example: "Firefox on Linux" },
    },
    required: ["browser", "os", "kind", "label"],
  },
  SessionLocation: {
    type: "object",
    description: "Approximate place of the session's address from the GeoLite2 Country and ASN databases.",
    properties: {
      countryCode: { type: ["string", "null"], example: "IT" },
      country: { type: ["string", "null"], example: "Italy" },
      asn: { type: ["integer", "null"], example: 64500 },
      network: { type: ["string", "null"], example: "Example Telecom" },
    },
    required: ["countryCode", "country", "asn", "network"],
  },
  Passkey: {
    type: "object",
    properties: {
      id: { type: "integer" },
      name: { type: "string" },
      authenticator: { type: ["string", "null"], description: "The authenticator model, when known (e.g. 1Password)" },
      deviceType: { type: "string", enum: ["singleDevice", "multiDevice"], description: "singleDevice: a security key; multiDevice: synced" },
      backedUp: { type: "boolean" },
      createdAt: { type: ["string", "null"], format: "date-time" },
      lastUsedAt: { type: ["string", "null"], format: "date-time" },
    },
    required: ["id", "name", "authenticator", "deviceType", "backedUp", "createdAt", "lastUsedAt"],
  },
  PasskeyList: {
    type: "object",
    properties: {
      passkeys: { type: "array", items: ref("Passkey") },
      canAdd: { type: "boolean", description: "Whether you can add a passkey now" },
      blocker: { type: ["string", "null"], description: "Why you cannot, when you cannot" },
    },
    required: ["passkeys", "canAdd", "blocker"],
  },
  Preferences: {
    type: "object",
    properties: {
      theme: { type: "string", enum: [...THEMES] },
      timeZone: { type: "string", example: "Europe/Rome", description: "An IANA time zone; UTC by default" },
      numberFormat: { type: "string", enum: [...NUMBER_FORMATS], description: "1,234.5 (en-US), 1.234,5 (de-DE) or 1 234,5 (fr-FR)" },
      proxyHostsSort: { type: "string", enum: [...PROXY_HOST_SORT_PREFERENCES], description: "Default ordering of Proxy Hosts; default keeps the application default" },
      l4ProxyHostsSort: { type: "string", enum: [...L4_PROXY_HOST_SORT_PREFERENCES], description: "Default ordering of L4 Proxy Hosts; default keeps the application default" },
      clientCertificatesSort: { type: "string", enum: [...CLIENT_CERTIFICATE_SORT_PREFERENCES], description: "Default ordering of Client Certificates; default keeps the application default" },
    },
    required: ["theme", "timeZone", "numberFormat", "proxyHostsSort", "l4ProxyHostsSort", "clientCertificatesSort"],
  },
  PreferencesInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      theme: { type: "string", enum: [...THEMES] },
      timeZone: { type: "string" },
      numberFormat: { type: "string", enum: [...NUMBER_FORMATS] },
      proxyHostsSort: { type: "string", enum: [...PROXY_HOST_SORT_PREFERENCES] },
      l4ProxyHostsSort: { type: "string", enum: [...L4_PROXY_HOST_SORT_PREFERENCES] },
      clientCertificatesSort: { type: "string", enum: [...CLIENT_CERTIFICATE_SORT_PREFERENCES] },
    },
  },
} as const;
