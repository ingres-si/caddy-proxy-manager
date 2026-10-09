// SPDX-License-Identifier: Elastic-2.0
/**
 * Sends notifications. Errors are reduced to application-authored messages:
 * a channel's URL can embed a token, so raw errors and response bodies are
 * never stored, logged or returned.
 */
import { createTransport } from "nodemailer";
import { safeSystemErrorCode } from "@/src/lib/caddy-apply-error";
import { BRAND_NAME } from "@/src/lib/brand";
import { getBranding } from "@/ee/white-label/store";
import type { ResolvedChannel } from "./channels";
import { blockedDestination } from "./validation";
import {
  buildEmail,
  buildNtfyMessage,
  buildPagerDutyEvent,
  buildSlackPayload,
  buildTeamsPayload,
  buildWebhookBody,
  pagerDutyDedupKey,
  signWebhook,
  type AlertNotification,
} from "./format";

export const DELIVERY_TIMEOUT_MS = 10_000;

const PAGERDUTY_ENDPOINTS = {
  us: "https://events.pagerduty.com/v2/enqueue",
  eu: "https://events.eu.pagerduty.com/v2/enqueue",
} as const;

export type DeliveryResult = { ok: true; error: null } | { ok: false; error: string };

export class DeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryError";
  }
}

/** A safe description of a failed fetch: never the URL, the message or the body. */
export function describeFetchError(error: unknown): string {
  if (error instanceof DeliveryError) return error.message;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "The request timed out";
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const code = safeSystemErrorCode(cause) ?? safeSystemErrorCode(error);
  if (cause instanceof Error && /redirect/i.test(cause.message)) {
    return "The endpoint answered with a redirect, which is not followed";
  }
  return code ? `Could not reach the endpoint (${code})` : "Could not reach the endpoint";
}

const SMTP_ERRORS: Record<string, string> = {
  EAUTH: "The SMTP server rejected the user name or password",
  ENOAUTH: "The SMTP server requires authentication",
  ETLS: "TLS negotiation with the SMTP server failed",
  EENVELOPE: "The SMTP server refused the sender or a recipient",
  EMESSAGE: "The SMTP server refused the message",
  ETIMEDOUT: "The SMTP server did not answer in time",
  EDNS: "The SMTP server name could not be resolved",
};

export function describeSmtpError(error: unknown): string {
  const code = safeSystemErrorCode(error);
  if (code && SMTP_ERRORS[code]) return SMTP_ERRORS[code];
  const responseCode = (error as { responseCode?: unknown } | null)?.responseCode;
  if (typeof responseCode === "number" && Number.isInteger(responseCode)) {
    return `The SMTP server answered with error ${responseCode}`;
  }
  return code ? `Sending the e-mail failed (${code})` : "Sending the e-mail failed";
}

/**
 * POSTs JSON without following redirects; throws DeliveryError on a non-2xx
 * answer, or without a request when the URL is a blocked destination (a
 * channel stored or synced before the rule existed).
 */
export async function postJson(url: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  const blocked = blockedDestination(url);
  if (blocked) throw new DeliveryError(`The endpoint is ${blocked}, which is not allowed`);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": `${BRAND_NAME}-Alerts/1`, ...headers },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  // Drain the body without keeping it: it may echo the request.
  await response.arrayBuffer().catch(() => undefined);
  if (!response.ok) throw new DeliveryError(`The endpoint answered with HTTP ${response.status}`);
  return response;
}

export type EmailMessage = { subject: string; text: string; html: string };

/** Sends one message through an e-mail channel; throws DeliveryError with a safe message. */
export async function sendEmailMessage(channel: Extract<ResolvedChannel, { type: "email" }>, email: EmailMessage): Promise<void> {
  const { config, secrets } = channel;
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: secrets.password ?? "" } : undefined,
    connectionTimeout: DELIVERY_TIMEOUT_MS,
    greetingTimeout: DELIVERY_TIMEOUT_MS,
    socketTimeout: DELIVERY_TIMEOUT_MS,
  });
  // White-label: the sender name of your own, if set, in front of the channel's address (nodemailer encodes it).
  const senderName = getBranding().emailSenderName;
  const from = senderName ? { name: senderName, address: config.from } : config.from;
  try {
    await transport.sendMail({ from, to: config.to, subject: email.subject, text: email.text, html: email.html });
  } catch (error) {
    throw new DeliveryError(describeSmtpError(error));
  } finally {
    transport.close();
  }
}

async function send(channel: ResolvedChannel, n: AlertNotification): Promise<void> {
  switch (channel.type) {
    case "email":
      return sendEmailMessage(channel, buildEmail(n));
    case "slack":
      await postJson(channel.secrets.webhookUrl, JSON.stringify(buildSlackPayload(n)));
      return;
    case "teams":
      await postJson(channel.secrets.webhookUrl, JSON.stringify(buildTeamsPayload(n)));
      return;
    case "webhook": {
      const body = JSON.stringify(buildWebhookBody(n));
      const timestamp = String(Math.floor(Date.parse(n.at) / 1000));
      const headers: Record<string, string> = { "X-Ingressi-Timestamp": timestamp };
      if (channel.secrets.hmacSecret) headers["X-Ingressi-Signature"] = signWebhook(channel.secrets.hmacSecret, timestamp, body);
      await postJson(channel.secrets.url, body, headers);
      return;
    }
    case "pagerduty": {
      const endpoint = PAGERDUTY_ENDPOINTS[channel.config.region];
      if (n.kind === "test") {
        // A test opens an incident and closes it right away.
        const dedupKey = `${pagerDutyDedupKey(null, `test-${channel.id}`)}-${Date.parse(n.at)}`;
        await postJson(endpoint, JSON.stringify(buildPagerDutyEvent(n, channel.secrets.routingKey, "trigger", dedupKey)));
        await postJson(endpoint, JSON.stringify(buildPagerDutyEvent(n, channel.secrets.routingKey, "resolve", dedupKey)));
        return;
      }
      const action = n.kind === "resolved" ? "resolve" : "trigger";
      await postJson(endpoint, JSON.stringify(buildPagerDutyEvent(n, channel.secrets.routingKey, action)));
      return;
    }
    case "ntfy": {
      const headers: Record<string, string> = {};
      if (channel.secrets.token) headers.Authorization = `Bearer ${channel.secrets.token}`;
      // JSON publishing to the server root avoids non-ASCII header values.
      await postJson(`${channel.config.serverUrl}/`, JSON.stringify(buildNtfyMessage(n, channel.config.topic)), headers);
      return;
    }
  }
}

/** Delivers one notification; never throws. */
export async function deliverToChannel(channel: ResolvedChannel, n: AlertNotification): Promise<DeliveryResult> {
  try {
    await send(channel, n);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: channel.type === "email" && !(error instanceof DeliveryError) ? describeSmtpError(error) : describeFetchError(error) };
  }
}
