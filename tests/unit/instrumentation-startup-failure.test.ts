/**
 * A server that cannot start (here: an ADMIN_PASSWORD the production checks
 * reject) exits in production. Next.js would otherwise catch the error from
 * register() and answer every request with 500 while the container keeps
 * running. Outside production the error is thrown as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  validateProductionConfig: vi.fn(),
  runDatabaseStartup: vi.fn(),
}));

vi.mock('../../src/lib/shutdown', () => ({ installShutdownHandler: () => {} }));
vi.mock('../../src/lib/config', () => ({ validateProductionConfig: mocks.validateProductionConfig }));
vi.mock('../../src/lib/db/startup', () => ({ runDatabaseStartup: mocks.runDatabaseStartup }));
vi.mock('../../ee/high-availability/role', () => ({ startLeaderWatchdog: () => {} }));

import { register } from '../../src/instrumentation';

const configError = new Error('Admin credentials validation failed');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mocks.validateProductionConfig.mockReset();
  mocks.runDatabaseStartup.mockReset();
});

describe('register() when start-up fails', () => {
  it('exits with status 1 in production on a configuration error', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NODE_ENV', 'production');
    mocks.validateProductionConfig.mockImplementation(() => { throw configError; });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await register();

    expect(exit).toHaveBeenCalledWith(1);
    expect(logged).toHaveBeenCalledWith('Ingressi could not start:', configError);
    expect(mocks.runDatabaseStartup).not.toHaveBeenCalled();
  });

  it('exits in production when a later start-up step fails', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NODE_ENV', 'production');
    mocks.runDatabaseStartup.mockRejectedValue(new Error('migration failed'));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await register();

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('throws outside production', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    mocks.runDatabaseStartup.mockRejectedValue(new Error('migration failed'));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await expect(register()).rejects.toThrow('migration failed');
    expect(exit).not.toHaveBeenCalled();
  });
});
