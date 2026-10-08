// SPDX-License-Identifier: Elastic-2.0
/**
 * Alert channels: where notifications go.
 *
 * Non-secret settings are stored as JSON in `config`. Credentials (SMTP
 * password, webhook URLs that embed a token, PagerDuty routing key, ntfy
 * token, HMAC secret) are stored together, encrypted, in `secrets`, and never
 * leave this module except to deliver a notification: the API and the
 * dashboard get `has*` flags and, for URLs, the scheme and host only.
 */
import { eq } from "drizzle-orm";
import { appDb, nowIso, toIso } from "@/src/lib/db";
import { alertChannels, alertRules } from "@/src/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/src/lib/secret";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import {
  CHANNEL_TYPE_LABELS,
  CHANNEL_TYPES,
  isChannelType,
  type AlertChannelView,
  type ChannelConfigView,
  type ChannelType,
  type EmailChannelView,
} from "./types";
import {
  isPlainObject,
  parseJsonObject,
  readBoolean,
  readEmailAddress,
  readHttpUrl,
  readInteger,
  readName,
  readSecretInput,
  readText,
  rejectUnknownKeys,
  requireObject,
  urlHint,
  type SecretInput,
} from "./validation";
import { asc } from "@/src/lib/db/ops";

export type EmailConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  from: string;
  to: string[];
};
export type PagerDutyRegion = "us" | "eu";
export type NtfyConfig = { serverUrl: string; topic: string };

/** A channel with its decrypted credentials, for delivery only. */
export type ResolvedChannel =
  | { id: number; name: string; type: "email"; config: EmailConfig; secrets: { password?: string } }
  | { id: number; name: string; type: "slack"; config: Record<string, never>; secrets: { webhookUrl: string } }
  | { id: number; name: string; type: "teams"; config: Record<string, never>; secrets: { webhookUrl: string } }
  | { id: number; name: string; type: "webhook"; config: Record<string, never>; secrets: { url: string; hmacSecret?: string } }
  | { id: number; name: string; type: "pagerduty"; config: { region: PagerDutyRegion }; secrets: { routingKey: string } }
  | { id: number; name: string; type: "ntfy"; config: NtfyConfig; secrets: { token?: string } };

type ChannelSettings = { config: Record<string, unknown>; secrets: Record<string, string> };
type ChannelRow = typeof alertChannels.$inferSelect;

const MAX_RECIPIENTS = 20;
const DEFAULT_NTFY_SERVER = "https://ntfy.sh";
const HOSTNAME = /^[A-Za-z0-9.-]{1,253}$|^\[[0-9A-Fa-f:.]+\]$/;

export class ChannelSecretsUnavailableError extends Error {
  constructor() {
    super("The stored credentials of this channel cannot be decrypted with the current SESSION_SECRET; enter them again");
    this.name = "ChannelSecretsUnavailableError";
  }
}

function notFound(): ApiClientError {
  return new ApiClientError("Alert channel not found", 404);
}

// ── Validation ─────────────────────────────────────────────────────────

function applySecret(
  input: SecretInput,
  existing: string | undefined,
  field: string,
  options: { required: boolean; boundToChangedDestination?: boolean; validate?: (value: string) => string }
): string | undefined {
  if (input.kind === "set") return options.validate ? options.validate(input.value) : input.value;
  if (input.kind === "clear") {
    if (options.required) throw new ApiValidationError(`${field} is required`);
    return undefined;
  }
  if (existing !== undefined && options.boundToChangedDestination) {
    // Never send a stored credential to a destination it was not entered for.
    throw new ApiValidationError(`Enter ${field} again when changing where the channel sends to, or send null to remove it`);
  }
  if (existing === undefined && options.required) throw new ApiValidationError(`${field} is required`);
  return existing;
}

function readHostname(value: unknown, field: string): string {
  const host = readText(value, field, 253);
  if (!HOSTNAME.test(host)) throw new ApiValidationError(`${field} must be a host name or IP address`);
  return host;
}

function readRecipients(value: unknown): string[] {
  const list = typeof value === "string" ? value.split(/[,\s]+/).filter(Boolean) : value;
  if (!Array.isArray(list) || list.length === 0) throw new ApiValidationError("to must list at least one e-mail address");
  if (list.length > MAX_RECIPIENTS) throw new ApiValidationError(`to may list at most ${MAX_RECIPIENTS} addresses`);
  return [...new Set(list.map((item, index) => readEmailAddress(item, `to[${index}]`)))];
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

const CONFIG_FIELDS: Record<ChannelType, readonly string[]> = {
  email: ["host", "port", "secure", "user", "password", "from", "to"],
  slack: ["webhookUrl"],
  teams: ["webhookUrl"],
  webhook: ["url", "hmacSecret"],
  pagerduty: ["routingKey", "region"],
  ntfy: ["serverUrl", "topic", "token"],
};

/**
 * Validates `raw` (all fields for a new channel, any subset for an update)
 * merged over `existing`, and returns what to store.
 */
export function normalizeChannelSettings(
  type: ChannelType,
  raw: Record<string, unknown>,
  existing: ChannelSettings | null
): ChannelSettings {
  rejectUnknownKeys(raw, CONFIG_FIELDS[type], "config");
  const prev = existing?.config ?? {};
  const prevSecrets = existing?.secrets ?? {};
  const pick = <T>(key: string, read: (value: unknown) => T, fallback: () => T): T =>
    raw[key] !== undefined ? read(raw[key]) : prev[key] !== undefined ? (prev[key] as T) : fallback();
  const required = (field: string) => () => {
    throw new ApiValidationError(`${field} is required`);
  };
  const secrets: Record<string, string> = {};
  const setSecret = (key: string, value: string | undefined) => {
    if (value !== undefined) secrets[key] = value;
  };

  switch (type) {
    case "email": {
      const host = pick("host", (v) => readHostname(v, "host"), required("host"));
      const secure = pick("secure", (v) => readBoolean(v, "secure", false), () => false);
      const port = pick("port", (v) => readInteger(v, "port", 1, 65535), () => (secure ? 465 : 587));
      const user = pick<string | null>(
        "user",
        (v) => (v === null || v === "" ? null : readText(v, "user", 255)),
        () => null
      );
      const from = pick("from", (v) => readEmailAddress(v, "from"), required("from"));
      const to = pick("to", readRecipients, required("to"));
      setSecret(
        "password",
        applySecret(readSecretInput(raw.password, "password", 1024), prevSecrets.password, "password", {
          required: false,
          boundToChangedDestination: existing !== null && prev.host !== host,
        })
      );
      return { config: { host, port, secure, user, from, to }, secrets };
    }
    case "slack":
    case "teams": {
      setSecret(
        "webhookUrl",
        applySecret(readSecretInput(raw.webhookUrl, "webhookUrl", 2048), prevSecrets.webhookUrl, "webhookUrl", {
          required: true,
          validate: (value) => readHttpUrl(value, "webhookUrl", { https: true, allowQuery: type === "teams" }),
        })
      );
      return { config: {}, secrets };
    }
    case "webhook": {
      setSecret(
        "url",
        applySecret(readSecretInput(raw.url, "url", 2048), prevSecrets.url, "url", {
          required: true,
          validate: (value) => readHttpUrl(value, "url", { allowQuery: true }),
        })
      );
      setSecret(
        "hmacSecret",
        applySecret(readSecretInput(raw.hmacSecret, "hmacSecret", 512), prevSecrets.hmacSecret, "hmacSecret", {
          required: false,
        })
      );
      return { config: {}, secrets };
    }
    case "pagerduty": {
      const region = pick<"us" | "eu">(
        "region",
        (v) => {
          if (v !== "us" && v !== "eu") throw new ApiValidationError('region must be "us" or "eu"');
          return v;
        },
        () => "us"
      );
      setSecret(
        "routingKey",
        applySecret(readSecretInput(raw.routingKey, "routingKey", 128), prevSecrets.routingKey, "routingKey", {
          required: true,
          validate: (value) => {
            if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
              throw new ApiValidationError("routingKey must be a PagerDuty Events API v2 integration key");
            }
            return value;
          },
        })
      );
      return { config: { region }, secrets };
    }
    case "ntfy": {
      const serverUrl = pick(
        "serverUrl",
        (v) => stripTrailingSlashes(readHttpUrl(v, "serverUrl")),
        () => DEFAULT_NTFY_SERVER
      );
      const topic = pick(
        "topic",
        (v) => {
          const value = readText(v, "topic", 64);
          if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ApiValidationError("topic may only contain letters, digits, - and _");
          return value;
        },
        required("topic")
      );
      setSecret(
        "token",
        applySecret(readSecretInput(raw.token, "token", 512), prevSecrets.token, "token", {
          required: false,
          boundToChangedDestination: existing !== null && prev.serverUrl !== serverUrl,
          validate: (value) => {
            if (!/^[\x21-\x7e]+$/.test(value)) throw new ApiValidationError("token contains invalid characters");
            return value;
          },
        })
      );
      return { config: { serverUrl, topic }, secrets };
    }
  }
}

// ── Storage ────────────────────────────────────────────────────────────

function encryptSecrets(secrets: Record<string, string>): string | null {
  return Object.keys(secrets).length > 0 ? encryptSecret(JSON.stringify(secrets)) : null;
}

/** Throws ChannelSecretsUnavailableError when SESSION_SECRET no longer decrypts them. */
function decryptSecrets(row: ChannelRow): Record<string, string> {
  if (!row.secrets) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptSecret(row.secrets, `alert channel ${row.id} credentials`));
  } catch {
    throw new ChannelSecretsUnavailableError();
  }
  if (!isPlainObject(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function tryDecryptSecrets(row: ChannelRow): Record<string, string> | null {
  try {
    return decryptSecrets(row);
  } catch {
    return null;
  }
}

function toConfigView(type: ChannelType, config: Record<string, unknown>, secrets: Record<string, string> | null): ChannelConfigView {
  const has = (key: string) => Boolean(secrets?.[key]);
  switch (type) {
    case "email":
      return {
        host: String(config.host ?? ""),
        port: Number(config.port ?? 587),
        secure: config.secure === true,
        user: typeof config.user === "string" ? config.user : null,
        from: String(config.from ?? ""),
        to: Array.isArray(config.to) ? config.to.map(String) : [],
        hasPassword: has("password"),
      };
    case "slack":
    case "teams":
      return { hasWebhookUrl: has("webhookUrl"), webhookUrlHint: urlHint(secrets?.webhookUrl) };
    case "webhook":
      return { hasUrl: has("url"), urlHint: urlHint(secrets?.url), hasHmacSecret: has("hmacSecret") };
    case "pagerduty":
      return { region: config.region === "eu" ? "eu" : "us", hasRoutingKey: has("routingKey") };
    case "ntfy":
      return { serverUrl: String(config.serverUrl ?? DEFAULT_NTFY_SERVER), topic: String(config.topic ?? ""), hasToken: has("token") };
  }
}

/** Allowlisted, secret-free view for the API and the dashboard. */
export function toAlertChannelView(row: ChannelRow): AlertChannelView {
  const type = isChannelType(row.type) ? row.type : "webhook";
  return {
    id: row.id,
    name: row.name,
    type,
    enabled: row.enabled,
    config: toConfigView(type, parseJsonObject(row.config), tryDecryptSecrets(row)),
    lastDeliveryAt: row.lastDeliveryAt ? toIso(row.lastDeliveryAt) : null,
    lastDeliveryError: row.lastDeliveryError ?? null,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

async function getChannelRow(id: number): Promise<ChannelRow | null> {
  const [row] = await appDb.select().from(alertChannels).where(eq(alertChannels.id, id));
  return row ?? null;
}

export async function listAlertChannels(): Promise<AlertChannelView[]> {
  const rows = await appDb.select().from(alertChannels).orderBy(asc(alertChannels.name), asc(alertChannels.id));
  return rows.map(toAlertChannelView);
}

export async function getAlertChannel(id: number): Promise<AlertChannelView | null> {
  const row = await getChannelRow(id);
  return row ? toAlertChannelView(row) : null;
}

/** Types of the given channels; unknown ids are rejected. */
export async function getChannelTypes(ids: readonly number[]): Promise<Map<number, ChannelType>> {
  const rows = ids.length === 0 ? [] : await appDb.select({ id: alertChannels.id, type: alertChannels.type }).from(alertChannels);
  const types = new Map<number, ChannelType>();
  for (const row of rows) {
    if (ids.includes(row.id) && isChannelType(row.type)) types.set(row.id, row.type);
  }
  for (const id of ids) {
    if (!types.has(id)) throw new ApiValidationError(`Alert channel ${id} does not exist`);
  }
  return types;
}

function readChannelType(value: unknown): ChannelType {
  if (!isChannelType(value)) throw new ApiValidationError(`type must be one of: ${CHANNEL_TYPES.join(", ")}`);
  return value;
}

export async function createAlertChannel(body: unknown, actorUserId: number): Promise<AlertChannelView> {
  const record = requireObject(body, "Request body");
  const type = readChannelType(record.type);
  rejectUnknownKeys(record, ["name", "type", "enabled", "config"], "the channel");
  const name = readName(record.name);
  const enabled = readBoolean(record.enabled, "enabled", true);
  const settings = normalizeChannelSettings(type, requireObject(record.config ?? {}, "config"), null);
  const now = nowIso();
  const [row] = await appDb
    .insert(alertChannels)
    .values({
      name,
      type,
      enabled,
      config: JSON.stringify(settings.config),
      secrets: encryptSecrets(settings.secrets),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await logAuditEvent({
    userId: actorUserId,
    action: "alert_channel_created",
    entityType: "alert_channel",
    entityId: row.id,
    summary: `Created ${CHANNEL_TYPE_LABELS[type]} alert channel "${name}"`,
    data: { type, name, enabled },
  });
  return toAlertChannelView(row);
}

export async function updateAlertChannel(id: number, body: unknown, actorUserId: number): Promise<AlertChannelView> {
  const row = await getChannelRow(id);
  if (!row) throw notFound();
  const type = readChannelType(row.type);
  const record = requireObject(body, "Request body");
  rejectUnknownKeys(record, ["name", "type", "enabled", "config"], "the channel");
  if (record.type !== undefined && record.type !== type) {
    throw new ApiValidationError("The type of an alert channel cannot be changed; create a new channel instead");
  }
  const name = record.name !== undefined ? readName(record.name) : row.name;
  const enabled = readBoolean(record.enabled, "enabled", row.enabled);
  let config = row.config;
  let secrets = row.secrets;
  if (record.config !== undefined) {
    const raw = requireObject(record.config, "config");
    // Credentials that no longer decrypt (SESSION_SECRET changed) are useless:
    // treat them as missing so the admin is asked to enter them again.
    const existingSecrets = tryDecryptSecrets(row) ?? {};
    const settings = normalizeChannelSettings(type, raw, { config: parseJsonObject(row.config), secrets: existingSecrets });
    config = JSON.stringify(settings.config);
    secrets = encryptSecrets(settings.secrets);
  }
  const [updated] = await appDb
    .update(alertChannels)
    .set({ name, enabled, config, secrets, updatedAt: nowIso() })
    .where(eq(alertChannels.id, id))
    .returning();
  await logAuditEvent({
    userId: actorUserId,
    action: "alert_channel_updated",
    entityType: "alert_channel",
    entityId: id,
    summary: `Updated ${CHANNEL_TYPE_LABELS[type]} alert channel "${name}"`,
    data: { type, name, enabled, fields: Object.keys(isPlainObject(record.config) ? record.config : {}) },
  });
  return toAlertChannelView(updated);
}

/**
 * A channel as it would be saved from `body` (a new channel, or the changes
 * to channel `id` merged over what is stored), for a test before saving.
 * Nothing is written; stored credentials are kept unless `body` replaces them.
 */
export async function draftChannelRow(id: number | null, body: unknown): Promise<ChannelRow> {
  const record = requireObject(body, "Request body");
  rejectUnknownKeys(record, ["name", "type", "enabled", "config"], "the channel");
  const row = id === null ? null : await getChannelRow(id);
  if (id !== null && !row) throw notFound();
  const type = row ? readChannelType(row.type) : readChannelType(record.type);
  if (row && record.type !== undefined && record.type !== type) {
    throw new ApiValidationError("The type of an alert channel cannot be changed; create a new channel instead");
  }
  const name = record.name !== undefined ? readName(record.name) : row?.name ?? CHANNEL_TYPE_LABELS[type];
  const existing = row ? { config: parseJsonObject(row.config), secrets: tryDecryptSecrets(row) ?? {} } : null;
  const settings = normalizeChannelSettings(type, requireObject(record.config ?? {}, "config"), existing);
  const now = nowIso();
  return {
    id: row?.id ?? 0,
    name,
    type,
    enabled: true,
    config: JSON.stringify(settings.config),
    secrets: encryptSecrets(settings.secrets),
    lastDeliveryAt: row?.lastDeliveryAt ?? null,
    lastDeliveryError: row?.lastDeliveryError ?? null,
    createdAt: row?.createdAt ?? now,
    updatedAt: now,
  };
}

/** Rules that notify the channel, by name. */
async function rulesUsingChannel(id: number): Promise<string[]> {
  const rules = await appDb.select({ name: alertRules.name, channelIds: alertRules.channelIds }).from(alertRules).orderBy(alertRules.id);
  return rules
    .filter((rule) => {
      try {
        const ids = JSON.parse(rule.channelIds);
        return Array.isArray(ids) && ids.includes(id);
      } catch {
        return false;
      }
    })
    .map((rule) => rule.name);
}

export async function deleteAlertChannel(id: number, actorUserId: number): Promise<void> {
  const row = await getChannelRow(id);
  if (!row) throw notFound();
  const type = readChannelType(row.type);
  const users = await rulesUsingChannel(id);
  if (users.length > 0) {
    throw new ApiConflictError(`The channel is used by ${users.length === 1 ? "rule" : "rules"} ${users.map((name) => `"${name}"`).join(", ")}; delete those rules or remove the channel from them first`);
  }
  await appDb.delete(alertChannels).where(eq(alertChannels.id, id));
  await logAuditEvent({
    userId: actorUserId,
    action: "alert_channel_deleted",
    entityType: "alert_channel",
    entityId: id,
    summary: `Deleted ${CHANNEL_TYPE_LABELS[type]} alert channel "${row.name}"`,
    data: { type, name: row.name },
  });
}

// ── Delivery support ───────────────────────────────────────────────────

/** Decrypts a stored channel for delivery. Throws ChannelSecretsUnavailableError. */
export function resolveChannel(row: ChannelRow): ResolvedChannel {
  const type = readChannelType(row.type);
  const config = parseJsonObject(row.config);
  const secrets = decryptSecrets(row);
  const base = { id: row.id, name: row.name };
  switch (type) {
    case "email": {
      const view = toConfigView("email", config, null) as EmailChannelView;
      const emailConfig: EmailConfig = {
        host: view.host,
        port: view.port,
        secure: view.secure,
        user: view.user,
        from: view.from,
        to: view.to,
      };
      return { ...base, type, config: emailConfig, secrets: { password: secrets.password } };
    }
    case "slack":
    case "teams":
      return { ...base, type, config: {}, secrets: { webhookUrl: secrets.webhookUrl ?? "" } };
    case "webhook":
      return { ...base, type, config: {}, secrets: { url: secrets.url ?? "", hmacSecret: secrets.hmacSecret } };
    case "pagerduty":
      return { ...base, type, config: { region: config.region === "eu" ? "eu" : "us" }, secrets: { routingKey: secrets.routingKey ?? "" } };
    case "ntfy":
      return {
        ...base,
        type,
        config: { serverUrl: String(config.serverUrl ?? DEFAULT_NTFY_SERVER), topic: String(config.topic ?? "") },
        secrets: { token: secrets.token },
      };
  }
}

export async function getChannelRows(ids: readonly number[]): Promise<ChannelRow[]> {
  if (ids.length === 0) return [];
  const rows = await appDb.select().from(alertChannels);
  return rows.filter((row) => ids.includes(row.id));
}

export async function getChannelRowForTest(id: number): Promise<ChannelRow> {
  const row = await getChannelRow(id);
  if (!row) throw notFound();
  return row;
}

export async function recordChannelDelivery(id: number, error: string | null, at: string = nowIso()): Promise<void> {
  await appDb
    .update(alertChannels)
    .set({ lastDeliveryAt: at, lastDeliveryError: error })
    .where(eq(alertChannels.id, id));
}
