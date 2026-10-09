/**
 * Litestream as the supervisor runs it (ee/high-availability/cluster/litestream.ts):
 * the generated configuration, the commands and their environment (the
 * storage keys only, never in a file), the restore results, the warm copies,
 * and the control socket. Plus the pinned, checksum-verified binary in the
 * web image, and the example override leaving the default stack alone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Litestream, LitestreamError, litestreamMetaPath, type ExitResult, type SpawnOptions } from '@/ee/high-availability/cluster/litestream';
import type { HaConfig } from '@/ee/high-availability/cluster/config';

let dir: string;

function config(overrides: Partial<HaConfig> = {}): HaConfig {
  return {
    nodeId: 'web-1',
    redis: {
      mode: 'standalone', addresses: ['valkey.example.com:6379'], masterName: null, db: 0, username: null,
      password: 'redis-secret-1', sentinelPassword: null, tls: { enabled: false, insecureSkipVerify: false }, keyPrefix: 'ingressi-ha',
    },
    leaseTtlMs: 15_000,
    storage: {
      endpoint: 'https://s3.example.com', apiEndpoint: 'https://s3.example.com', region: 'eu-central-1', bucket: 'ingressi-ha',
      path: 'prod', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 's3-secret-sentinel', forcePathStyle: true,
    },
    syncIntervalSeconds: 1,
    followIntervalSeconds: 5,
    databasePath: join(dir, 'ingressi.db'),
    haDir: join(dir, 'ha'),
    recoverFromLocal: false,
    litestreamBin: '/usr/local/bin/litestream',
    ...overrides,
  };
}

type Call = { command: string; args: string[]; options: SpawnOptions };

/** A spawner that records the call and exits with `code`, after `effect`. */
function spawner(code: number, effect: (args: string[]) => void = () => {}) {
  const calls: Call[] = [];
  const spawn = (command: string, args: string[], options: SpawnOptions) => {
    calls.push({ command, args, options });
    effect(args);
    return {
      exited: Promise.resolve<ExitResult>({ code, signal: null }),
      kill: () => {},
      output: () => [],
    };
  };
  return { calls, spawn };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ha-litestream-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Litestream configuration', () => {
  it('describes the S3 replica of one leader term, with the socket for replicate only', () => {
    const litestream = new Litestream(config());
    const yaml = litestream.buildConfig('e4-0a1b2c3d', true);
    expect(yaml).toContain(`  - path: "${join(dir, 'ingressi.db')}"`);
    expect(yaml).toContain('      type: s3\n');
    expect(yaml).toContain('      bucket: "ingressi-ha"\n');
    expect(yaml).toContain('      path: "prod/replicas/e4-0a1b2c3d"\n');
    expect(yaml).toContain('      region: "eu-central-1"\n');
    expect(yaml).toContain('      endpoint: "https://s3.example.com"\n');
    expect(yaml).toContain('      force-path-style: true\n');
    expect(yaml).toContain('      sync-interval: 1s\n');
    expect(yaml).toContain(`socket:\n  enabled: true\n  path: "${join(dir, 'ha', 'litestream.sock')}"\n  permissions: 384\n`);
    expect(litestream.buildConfig('e4-0a1b2c3d', false)).not.toContain('socket:');
    expect(new Litestream(config({ storage: { ...config().storage, endpoint: null } })).buildConfig('e4-0a1b2c3d', false)).not.toContain('endpoint:');
    for (const secret of ['AKIAEXAMPLE', 's3-secret-sentinel', 'redis-secret-1']) expect(yaml).not.toContain(secret);
  });
});

describe('litestream restore', () => {
  it('restores into a new file with the keys in its environment only', async () => {
    const out = join(dir, 'ha', 'restore.db');
    const { calls, spawn } = spawner(0, () => writeFileSync(out, 'db'));
    expect(await new Litestream(config(), spawn).restore('e3-aaaaaaaa', out)).toBe(true);
    const [call] = calls;
    expect(call.command).toBe('/usr/local/bin/litestream');
    expect(call.args).toEqual([
      'restore', '-config', join(dir, 'ha', 'restore.yml'), '-no-expand-env', '-if-replica-exists', '-integrity-check', 'quick',
      '-o', out, join(dir, 'ingressi.db'),
    ]);
    expect(call.options.env.AWS_ACCESS_KEY_ID).toBe('AKIAEXAMPLE');
    expect(call.options.env.AWS_SECRET_ACCESS_KEY).toBe('s3-secret-sentinel');
    expect(call.options.env.SESSION_SECRET).toBeUndefined();
    expect(Object.keys(call.options.env).some((name) => name.startsWith('HA_'))).toBe(false);
    const file = join(dir, 'ha', 'restore.yml');
    expect(readFileSync(file, 'utf8')).toContain('prod/replicas/e3-aaaaaaaa');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'ha')).mode & 0o777).toBe(0o700);
  });

  it('tells an empty replica apart from a failure', async () => {
    const out = join(dir, 'restore.db');
    expect(await new Litestream(config(), spawner(0).spawn).restore('e3-aaaaaaaa', out)).toBe(false);
    const failing = spawner(1, () => writeFileSync(out, 'partial'));
    await expect(new Litestream(config(), failing.spawn).restore('e3-aaaaaaaa', out)).rejects.toThrow(
      new LitestreamError('the restore failed (litestream exited with 1)')
    );
    expect(existsSync(out)).toBe(false);
  });

  it('starts replicate with the control socket, and follow into a copy of its own', () => {
    const { calls, spawn } = spawner(0);
    const litestream = new Litestream(config(), spawn);
    litestream.startReplicate('e4-0a1b2c3d');
    expect(calls[0].args).toEqual(['replicate', '-config', join(dir, 'ha', 'replicate.yml'), '-no-expand-env']);

    // A copy of another replica, and a copy that cannot be resumed, are removed first.
    mkdirSync(join(dir, 'ha'), { recursive: true });
    writeFileSync(join(dir, 'ha', 'standby-e3-aaaaaaaa.db'), 'old');
    writeFileSync(join(dir, 'ha', 'standby-e3-aaaaaaaa.db-txid'), '5');
    writeFileSync(join(dir, 'ha', 'standby-e4-0a1b2c3d.db'), 'no txid file');
    litestream.startFollow('e4-0a1b2c3d');
    expect(calls[1].args).toEqual([
      'restore', '-config', join(dir, 'ha', 'follow.yml'), '-no-expand-env', '-f', '-follow-interval', '5s',
      '-o', join(dir, 'ha', 'standby-e4-0a1b2c3d.db'), join(dir, 'ingressi.db'),
    ]);
    expect(existsSync(join(dir, 'ha', 'standby-e3-aaaaaaaa.db'))).toBe(false);
    expect(existsSync(join(dir, 'ha', 'standby-e3-aaaaaaaa.db-txid'))).toBe(false);
    expect(existsSync(join(dir, 'ha', 'standby-e4-0a1b2c3d.db'))).toBe(false);
    expect(litestream.standbyCopyReady('e4-0a1b2c3d')).toBe(false);
    writeFileSync(join(dir, 'ha', 'standby-e4-0a1b2c3d.db'), 'copy');
    writeFileSync(join(dir, 'ha', 'standby-e4-0a1b2c3d.db-txid'), '9');
    expect(litestream.standbyCopyReady('e4-0a1b2c3d')).toBe(true);
    expect(litestreamMetaPath('/app/data/ingressi.db')).toBe('/app/data/.ingressi.db-litestream');
  });
});

describe('control socket', () => {
  it('reads when the replica was last confirmed up to date', async () => {
    const cfg = config();
    mkdirSync(cfg.haDir, { recursive: true });
    const litestream = new Litestream(cfg);
    let body = JSON.stringify({ databases: [{ path: cfg.databasePath, status: 'replicating', last_sync_at: '2026-10-03T10:00:00Z' }] });
    let status = 200;
    const server = http.createServer((request, response) => {
      expect(request.url).toBe('/list');
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(litestream.socketPath, resolve));
    try {
      expect((await litestream.lastSyncAt())?.toISOString()).toBe('2026-10-03T10:00:00.000Z');
      body = JSON.stringify({ databases: [{ path: cfg.databasePath, status: 'replicating' }] });
      expect(await litestream.lastSyncAt()).toBeNull();
      body = JSON.stringify({ databases: [] });
      await expect(litestream.lastSyncAt()).rejects.toThrow('litestream does not replicate the database yet');
      status = 500;
      await expect(litestream.lastSyncAt()).rejects.toThrow("litestream's control socket refused the request");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await expect(litestream.lastSyncAt()).rejects.toThrow("litestream's control socket cannot be reached");
  });
});

const ROOT = process.cwd();

describe('the web image and the example', () => {
  it('pins Litestream and checks its SHA-256 before use', () => {
    const dockerfile = readFileSync(join(ROOT, 'docker/web/Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/ARG LITESTREAM_VERSION=\d+\.\d+\.\d+\n/);
    expect(dockerfile).toMatch(/ARG LITESTREAM_SHA256_AMD64=[0-9a-f]{64}\n/);
    expect(dockerfile).toMatch(/ARG LITESTREAM_SHA256_ARM64=[0-9a-f]{64}\n/);
    expect(dockerfile).toContain('sha256sum -c -');
    expect(dockerfile).toContain('COPY --from=litestream /opt/litestream/litestream /usr/local/bin/litestream');
    expect(dockerfile).toContain('bun build ee/high-availability/cluster/main.ts --target=bun');
    const entrypoint = readFileSync(join(ROOT, 'docker/web/entrypoint.sh'), 'utf8');
    expect(entrypoint).toContain('exec bun /app/ha/supervisor.js');
    expect(entrypoint).toContain('exec env HOSTNAME=0.0.0.0 bun server.js');
    // Set before either start, so the supervisor's application inherits it.
    expect(entrypoint.indexOf('export KEEP_ALIVE_TIMEOUT="${KEEP_ALIVE_TIMEOUT:-125000}"')).toBeGreaterThan(-1);
    expect(entrypoint.indexOf('export KEEP_ALIVE_TIMEOUT')).toBeLessThan(entrypoint.indexOf('exec bun /app/ha/supervisor.js'));
  });

  it('keeps high availability out of the default and test stacks', () => {
    for (const file of ['docker-compose.yml', 'tests/docker-compose.test.yml']) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).not.toMatch(/HA_ENABLED|docker-compose\.ha\.yml/);
    }
    const example = readFileSync(join(ROOT, 'docker-compose.ha.yml'), 'utf8');
    expect(example).toContain('HA_ENABLED: "true"');
    expect(example.match(/api\/health\?scope=live/g)).toHaveLength(2);
    expect(example).toContain('health_uri /api/health\n');
  });
});
