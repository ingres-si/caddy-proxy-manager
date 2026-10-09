import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mail = vi.hoisted(() => ({ sendMail: vi.fn(), close: vi.fn(), options: [] as unknown[] }));

vi.mock('nodemailer', () => ({
  createTransport: vi.fn((options: unknown) => {
    mail.options.push(options);
    return { sendMail: mail.sendMail, close: mail.close };
  }),
}));

import { deliverToChannel, describeFetchError, DELIVERY_TIMEOUT_MS } from '@/ee/alerting/deliver';
import { blockedDestination } from '@/ee/alerting/validation';
import { config } from '@/src/lib/config';
import { pagerDutyDedupKey, testNotification, type AlertNotification } from '@/ee/alerting/format';
import type { ResolvedChannel } from '@/ee/alerting/channels';

const at = '2026-10-02T10:00:00.000Z';
const firing: AlertNotification = {
  kind: 'firing', ruleId: 3, ruleName: 'Upstreams', ruleType: 'upstream_down', subjectKey: 'upstream:10.0.0.5:8080',
  severity: 'critical', title: 'Upstream 10.0.0.5:8080 is failing', message: 'Check it.', facts: { recentFailures: 2 },
  explanation: 'The backend stopped answering.', eventId: 9, at,
};

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mail.sendMail.mockReset();
  mail.close.mockReset();
  mail.options.length = 0;
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 202 }));
});

afterEach(() => vi.restoreAllMocks());

function call(index = 0): { url: string; init: RequestInit; body: any } {
  const [url, init] = fetchSpy.mock.calls[index] as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) };
}

describe('e-mail', () => {
  const channel: ResolvedChannel = {
    id: 1, name: 'Mail', type: 'email',
    config: { host: 'smtp.example.com', port: 465, secure: true, user: 'alerts', from: 'alerts@example.com', to: ['a@example.com', 'b@example.com'] },
    secrets: { password: 'pw' },
  };

  it('sends through the configured SMTP server with timeouts', async () => {
    mail.sendMail.mockResolvedValue({ messageId: 'x' });
    expect(await deliverToChannel(channel, firing)).toEqual({ ok: true, error: null });
    expect(mail.options[0]).toMatchObject({
      host: 'smtp.example.com', port: 465, secure: true, auth: { user: 'alerts', pass: 'pw' },
      connectionTimeout: DELIVERY_TIMEOUT_MS, greetingTimeout: DELIVERY_TIMEOUT_MS, socketTimeout: DELIVERY_TIMEOUT_MS,
    });
    expect(mail.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: 'alerts@example.com', to: ['a@example.com', 'b@example.com'], subject: '[Ingressi] [FIRING] Upstream 10.0.0.5:8080 is failing',
    }));
    expect(mail.close).toHaveBeenCalled();
  });

  it('sends without authentication when no user is set', async () => {
    mail.sendMail.mockResolvedValue({});
    await deliverToChannel({ ...channel, config: { ...channel.config, user: null } } as ResolvedChannel, firing);
    expect((mail.options[0] as { auth?: unknown }).auth).toBeUndefined();
  });

  it.each([
    [Object.assign(new Error('Invalid login: 535 pw rejected'), { code: 'EAUTH', responseCode: 535 }), 'The SMTP server rejected the user name or password'],
    [Object.assign(new Error('x'), { code: 'ECONNECTION' }), 'Sending the e-mail failed (ECONNECTION)'],
    [Object.assign(new Error('Mailbox full'), { responseCode: 552 }), 'The SMTP server answered with error 552'],
  ])('reports SMTP failures without their messages', async (error, message) => {
    mail.sendMail.mockRejectedValue(error);
    expect(await deliverToChannel(channel, firing)).toEqual({ ok: false, error: message });
  });
});

describe('webhook', () => {
  it('signs the exact body with the timestamp', async () => {
    const channel: ResolvedChannel = { id: 2, name: 'Hook', type: 'webhook', config: {}, secrets: { url: 'https://hooks.example.com/in?token=t', hmacSecret: 's3cret' } };
    expect(await deliverToChannel(channel, firing)).toEqual({ ok: true, error: null });
    const { url, init } = call();
    expect(url).toBe('https://hooks.example.com/in?token=t');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Ingressi-Timestamp']).toBe(String(Date.parse(at) / 1000));
    const expected = createHmac('sha256', 's3cret').update(`${headers['X-Ingressi-Timestamp']}.${init.body}`).digest('hex');
    expect(headers['X-Ingressi-Signature']).toBe(`sha256=${expected}`);
    expect(JSON.parse(String(init.body))).toMatchObject({ status: 'firing', explanation: { label: 'AI-generated explanation' } });
  });

  it('omits the signature without a secret', async () => {
    await deliverToChannel({ id: 2, name: 'Hook', type: 'webhook', config: {}, secrets: { url: 'https://hooks.example.com/in' } }, firing);
    expect((call().init.headers as Record<string, string>)['X-Ingressi-Signature']).toBeUndefined();
  });
});

describe('PagerDuty', () => {
  const channel: ResolvedChannel = { id: 4, name: 'PD', type: 'pagerduty', config: { region: 'eu' }, secrets: { routingKey: 'rk' } };

  it('triggers and resolves on the regional endpoint with one dedup key', async () => {
    await deliverToChannel(channel, firing);
    await deliverToChannel(channel, { ...firing, kind: 'resolved' });
    expect(call(0).url).toBe('https://events.eu.pagerduty.com/v2/enqueue');
    expect(call(0).body).toMatchObject({ event_action: 'trigger', dedup_key: pagerDutyDedupKey(3, 'upstream:10.0.0.5:8080') });
    expect(call(1).body).toEqual({ routing_key: 'rk', event_action: 'resolve', dedup_key: call(0).body.dedup_key });
  });

  it('opens and closes a test incident', async () => {
    await deliverToChannel({ ...channel, config: { region: 'us' } }, testNotification(new Date(at)));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(call(0).url).toBe('https://events.pagerduty.com/v2/enqueue');
    expect([call(0).body.event_action, call(1).body.event_action]).toEqual(['trigger', 'resolve']);
    expect(call(0).body.dedup_key).toBe(call(1).body.dedup_key);
  });
});

describe('ntfy and chat webhooks', () => {
  it('publishes ntfy JSON to the server root with the token', async () => {
    await deliverToChannel({ id: 5, name: 'ntfy', type: 'ntfy', config: { serverUrl: 'https://ntfy.example.com', topic: 'ops' }, secrets: { token: 'tk_1' } }, firing);
    expect(call().url).toBe('https://ntfy.example.com/');
    expect((call().init.headers as Record<string, string>).Authorization).toBe('Bearer tk_1');
    expect(call().body).toMatchObject({ topic: 'ops', priority: 5 });
  });

  it('posts Slack and Teams payloads to their webhook URLs', async () => {
    await deliverToChannel({ id: 6, name: 'Slack', type: 'slack', config: {}, secrets: { webhookUrl: 'https://hooks.slack.com/services/x' } }, firing);
    await deliverToChannel({ id: 7, name: 'Teams', type: 'teams', config: {}, secrets: { webhookUrl: 'https://teams.example.com/hook' } }, firing);
    expect(call(0).body.text).toContain('Upstream 10.0.0.5:8080 is failing');
    expect(call(1).body.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
  });
});

describe('blocked destinations', () => {
  const caddyAdmin = new URL(config.caddyApiUrl);

  it.each([
    ['http://169.254.169.254/latest/meta-data/', 'a link-local or cloud metadata address'],
    ['http://[fe80::1]/hook', 'a link-local or cloud metadata address'],
    ['http://[::ffff:169.254.169.254]/', 'a link-local or cloud metadata address'],
    ['http://[fd00:ec2::254]/', 'a link-local or cloud metadata address'],
    ['http://metadata.google.internal/computeMetadata/v1/', 'a cloud metadata service'],
    [`${caddyAdmin.origin}/stop`, "Caddy's admin API"],
    [`${caddyAdmin.protocol}//${caddyAdmin.host.toUpperCase()}/load`, "Caddy's admin API"],
  ])('names why %s is refused', (url, reason) => {
    expect(blockedDestination(url)).toBe(reason);
  });

  it.each([
    'https://hooks.slack.com/services/x',
    'http://10.0.0.5:5678/webhook/alerts',
    'http://localhost:11434/v1',
    `${caddyAdmin.protocol}//${caddyAdmin.hostname}:${Number(caddyAdmin.port || 80) + 1}/`,
    'not a url',
  ])('allows %s', (url) => {
    expect(blockedDestination(url)).toBeNull();
  });

  it('refuses a stored channel at a blocked destination without a request', async () => {
    const channel: ResolvedChannel = { id: 8, name: 'Hook', type: 'webhook', config: {}, secrets: { url: `${caddyAdmin.origin}/stop` } };
    expect(await deliverToChannel(channel, firing)).toEqual({ ok: false, error: "The endpoint is Caddy's admin API, which is not allowed" });
    const ntfy: ResolvedChannel = { id: 9, name: 'ntfy', type: 'ntfy', config: { serverUrl: 'http://169.254.169.254', topic: 'ops' }, secrets: {} };
    expect(await deliverToChannel(ntfy, firing)).toEqual({ ok: false, error: 'The endpoint is a link-local or cloud metadata address, which is not allowed' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('error reporting', () => {
  it('never includes URLs, messages or bodies', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('token xoxb-123 invalid', { status: 404 }));
    const result = await deliverToChannel({ id: 6, name: 'Slack', type: 'slack', config: {}, secrets: { webhookUrl: 'https://hooks.slack.com/services/secret-path' } }, firing);
    expect(result).toEqual({ ok: false, error: 'The endpoint answered with HTTP 404' });

    expect(describeFetchError(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe('The request timed out');
    expect(describeFetchError(new TypeError('fetch failed', { cause: new Error('unexpected redirect') }))).toBe('The endpoint answered with a redirect, which is not followed');
    expect(describeFetchError(new TypeError('fetch failed https://hooks.slack.com/services/secret-path', { cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }) })))
      .toBe('Could not reach the endpoint (ENOTFOUND)');
    expect(describeFetchError(new Error('https://hooks.slack.com/services/secret-path'))).toBe('Could not reach the endpoint');
  });
});
