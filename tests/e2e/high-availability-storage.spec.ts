/**
 * High availability, phase 1: shared certificate storage across Caddy nodes
 * (ee/high-availability), on the master/slave pair of the test stack.
 *
 * caddy-master and caddy-slave share the valkey service (ha-storage-network).
 * Only caddy-master can reach Step-CA (ha-acme-network, where it is also
 * ha-storage-e2e.test for the challenges), so a Step-CA certificate served by
 * the slave can only have come from the shared storage. To leave no doubt about
 * which node ordered it, the slave's Caddy is stopped while the master
 * obtains the certificate, then started and synced; the test then checks the
 * slave serves the very same certificate and never tried to obtain one.
 *
 * The storage is written straight into the master's database; everything
 * after that goes through the normal apply and sync paths. Switching back to
 * local storage is done through the API at the end. Each run uses its own
 * key prefix.
 */
import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeSettingRow } from '../helpers/e2e-sql';
import { escapeRegExp } from '../helpers/text';

const MASTER = 'http://localhost:3002';
const SLAVE = 'http://localhost:3003';
const DOMAIN = 'ha-storage-e2e.test';
const STEP_CA_NAME = 'Ingressi E2E Step-CA';
const STEP_CA_DIRECTORY = 'https://step-ca:9000/acme/acme/directory';
const VALKEY_PASSWORD = 'e2e-valkey-password-2026';
const PREFIX = `e2e-ha/run-${Date.now()}`;
const CONTAINERS = {
  stepCa: 'ingressi-step-ca',
  valkey: 'ingressi-valkey',
  webMaster: 'ingressi-web-master',
  webSlave: 'ingressi-web-slave',
  caddyMaster: 'ingressi-caddy-master',
  caddySlave: 'ingressi-caddy-slave',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function docker(args: string[], options: { input?: string; allowFailure?: boolean } = {}): string {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf-8',
      input: options.input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000,
    });
  } catch (error) {
    if (options.allowFailure) return '';
    throw error;
  }
}

async function loginContext(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${baseURL}/login`);
  await page.getByRole('textbox', { name: /username/i }).fill('testadmin');
  await page.getByRole('textbox', { name: /password/i }).fill('TestPassword2026!');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 20_000 });
  await page.close();
  return context;
}

async function readStepCaRoot(timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = docker(['exec', CONTAINERS.stepCa, 'cat', '/home/step/certs/root_ca.crt'], { allowFailure: true });
    if (out.includes('BEGIN CERTIFICATE')) return out.trim();
    await sleep(2_000);
  }
  throw new Error('Step-CA root certificate not available');
}

function valkey(...args: string[]): string {
  return docker(['exec', CONTAINERS.valkey, 'valkey-cli', '-a', VALKEY_PASSWORD, '--no-auth-warning', ...args]);
}

/** The storage block a Caddy is running with, or null. */
function liveStorage(container: string): Record<string, unknown> | null {
  const out = docker(['exec', container, 'wget', '-qO-', 'http://localhost:2019/config/storage'], { allowFailure: true }).trim();
  if (!out || out === 'null') return null;
  try {
    return JSON.parse(out) as Record<string, unknown>;
  } catch {
    return null;
  }
}

type ServedCertificate = { issuer?: Record<string, string>; fingerprint256?: string; serialNumber?: string; subjectaltname?: string; error?: string };

/**
 * The certificate a node's Caddy serves for DOMAIN, read from that node's web
 * container (each Caddy is only reachable on its own internal network).
 * rejectUnauthorized: false is deliberate: this only inspects the leaf the
 * node serves (issuer, fingerprint, serial); nothing is sent over the
 * connection, and the Step-CA root is not installed in the web container.
 */
function servedCertificate(webContainer: string): ServedCertificate {
  const script = `
    import tls from "node:tls";
    const socket = tls.connect({ host: "caddy", port: 443, servername: ${JSON.stringify(DOMAIN)}, rejectUnauthorized: false, timeout: 5000 }, () => {
      const cert = socket.getPeerCertificate();
      console.log(JSON.stringify({ issuer: cert.issuer, fingerprint256: cert.fingerprint256, serialNumber: cert.serialNumber, subjectaltname: cert.subjectaltname }));
      socket.end();
      process.exit(0);
    });
    socket.on("error", (error) => { console.log(JSON.stringify({ error: String(error.code || error.message) })); process.exit(0); });
    socket.on("timeout", () => { console.log(JSON.stringify({ error: "timeout" })); process.exit(0); });
  `;
  const out = docker(['exec', webContainer, 'bun', '-e', script], { allowFailure: true }).trim().split('\n').pop() ?? '';
  try {
    return JSON.parse(out) as ServedCertificate;
  } catch {
    return { error: out || 'no output' };
  }
}

async function waitForStepCaCertificate(webContainer: string, timeoutMs = 120_000): Promise<ServedCertificate> {
  const deadline = Date.now() + timeoutMs;
  let last: ServedCertificate = {};
  while (Date.now() < deadline) {
    last = servedCertificate(webContainer);
    if (JSON.stringify(last.issuer ?? {}).includes(STEP_CA_NAME)) return last;
    await sleep(2_000);
  }
  throw new Error(`${webContainer}: no Step-CA certificate for ${DOMAIN} (last: ${JSON.stringify(last)})`);
}

/** Caddy log lines about obtaining a certificate for DOMAIN, since `since`. */
/**
 * A container's log since `since`. Caddy logs to stderr, which `docker logs`
 * replays on its own stderr, so both streams are read.
 */
function containerLogs(container: string, since: string): string {
  const result = spawnSync('docker', ['logs', '--since', since, container], { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function obtainLogLines(container: string, since: string): { obtaining: number; obtained: number } {
  const logs = containerLogs(container, since);
  const lines = logs.split('\n').filter((line) => line.includes(`"identifier":"${DOMAIN}"`));
  return {
    obtaining: lines.filter((line) => line.includes('"msg":"obtaining certificate"')).length,
    obtained: lines.filter((line) => line.includes('"msg":"certificate obtained successfully"')).length,
  };
}

/** Writes the storage setting into the master's database, as the dashboard would have saved it. */
function seedMasterStorage() {
  writeSettingRow('certificate_storage', {
    backend: 'redis',
    redis: {
      mode: 'standalone',
      addresses: ['valkey:6379'],
      db: 0,
      keyPrefix: PREFIX,
      tls: { enabled: false, insecureSkipVerify: false },
      // Stored as given: decryptSecret passes values without the enc: prefix through.
      password: VALKEY_PASSWORD,
    },
  }, { container: CONTAINERS.webMaster });
}

async function waitForCaddy(container: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (docker(['exec', container, 'wget', '-qO-', 'http://localhost:2019/config/'], { allowFailure: true })) return;
    await sleep(1_000);
  }
  throw new Error(`${container} did not come back`);
}

test.describe.serial('High availability: shared certificate storage (master + slave + Valkey)', () => {
  test.describe.configure({ timeout: 240_000 });

  let master: BrowserContext;
  let slave: BrowserContext;
  let hostId: number | undefined;
  let masterCertificate: ServedCertificate;

  const json = { 'Content-Type': 'application/json', Origin: MASTER };

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    master = await loginContext(browser, MASTER);
    slave = await loginContext(browser, SLAVE);
    expect(valkey('ping').trim()).toBe('PONG');

    seedMasterStorage();
    // Saving the ACME settings applies the configuration (with the storage)
    // on the master and syncs both to the slave.
    const acme = await master.request.put(`${MASTER}/api/v1/settings/acme`, {
      data: { caUrl: STEP_CA_DIRECTORY, caRootPem: await readStepCaRoot() },
      headers: json,
    });
    expect(acme.status()).toBe(200);
  });

  test.afterAll(async () => {
    docker(['start', CONTAINERS.caddySlave], { allowFailure: true });
    await waitForCaddy(CONTAINERS.caddySlave).catch(() => {});
    if (hostId !== undefined) {
      await master.request.delete(`${MASTER}/api/v1/proxy-hosts/${hostId}`, { headers: { Origin: MASTER } });
    }
    // Back to local storage.
    await master.request.delete(`${MASTER}/api/v1/high-availability/storage`, { headers: { Origin: MASTER } });
    await master.request.put(`${MASTER}/api/v1/settings/acme`, { data: { caUrl: '', caRootPem: '' }, headers: json });
    await master.request.post(`${MASTER}/api/v1/instances/sync`, { headers: { Origin: MASTER } });
    docker(['exec', CONTAINERS.valkey, 'valkey-cli', '-a', VALKEY_PASSWORD, '--no-auth-warning', 'FLUSHALL'], { allowFailure: true });
    await master.close();
    await slave.close();
  });

  test('both Caddys use the shared storage, and no secret leaves the API', async () => {
    const view = await master.request.get(`${MASTER}/api/v1/high-availability/storage`);
    expect(view.status()).toBe(200);
    const text = await view.text();
    expect(text).not.toContain(VALKEY_PASSWORD);
    expect(JSON.parse(text)).toMatchObject({
      backend: 'redis', source: 'local', redis: { addresses: ['valkey:6379'], keyPrefix: PREFIX, hasPassword: true },
    });

    await expect.poll(async () => {
      const response = await slave.request.get(`${SLAVE}/api/v1/high-availability/storage`);
      return response.status() === 200 ? (await response.json()) : null;
    }, { timeout: 30_000 }).toMatchObject({ backend: 'redis', source: 'master', editable: false, redis: { keyPrefix: PREFIX } });

    for (const container of [CONTAINERS.caddyMaster, CONTAINERS.caddySlave]) {
      await expect.poll(() => liveStorage(container), { timeout: 30_000 }).toMatchObject({
        module: 'redis', address: ['valkey:6379'], key_prefix: PREFIX,
      });
    }

    // The slave tests the storage from its own node.
    const tested = await slave.request.post(`${SLAVE}/api/v1/high-availability/storage/test`, { headers: { Origin: SLAVE } });
    expect(tested.status()).toBe(200);
    expect(await tested.json()).toMatchObject({ ok: true, complete: true, server: 'valkey:6379' });
  });

  test('the master orders the certificate once; the slave serves the same one without ordering', async () => {
    const start = new Date().toISOString();

    // The slave's Caddy is down while the master obtains the certificate.
    docker(['stop', CONTAINERS.caddySlave]);
    const created = await master.request.post(`${MASTER}/api/v1/proxy-hosts`, {
      data: { name: 'HA shared storage', domains: [DOMAIN], upstreams: ['whoami-server:80'], sslForced: true },
      headers: json,
    });
    expect(created.status()).toBe(201);
    hostId = (await created.json()).id as number;

    masterCertificate = await waitForStepCaCertificate(CONTAINERS.webMaster);
    expect(masterCertificate.subjectaltname ?? '').toContain(DOMAIN);

    // It is in the shared storage, under this run's prefix.
    await expect.poll(() => valkey('--scan', '--pattern', `${PREFIX}/certificates/*`).split('\n').filter(Boolean), {
      timeout: 30_000,
    }).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`/${escapeRegExp(DOMAIN)}\\.crt$`))]));

    // The slave comes back and receives the host.
    const restarted = new Date().toISOString();
    docker(['start', CONTAINERS.caddySlave]);
    await waitForCaddy(CONTAINERS.caddySlave);
    await expect.poll(async () => {
      const sync = await master.request.post(`${MASTER}/api/v1/instances/sync`, { headers: { Origin: MASTER } });
      return sync.status() === 200 ? (await sync.json()).success : null;
    }, { timeout: 60_000, intervals: [2_000, 5_000] }).toBeGreaterThanOrEqual(1);

    const slaveCertificate = await waitForStepCaCertificate(CONTAINERS.webSlave, 90_000);
    expect(slaveCertificate.fingerprint256).toBe(masterCertificate.fingerprint256);
    expect(slaveCertificate.serialNumber).toBe(masterCertificate.serialNumber);

    // One order, by the master; the slave never tried (it cannot reach the CA either).
    expect(obtainLogLines(CONTAINERS.caddyMaster, start).obtained).toBe(1);
    expect(obtainLogLines(CONTAINERS.caddySlave, restarted)).toEqual({ obtaining: 0, obtained: 0 });
  });
});
