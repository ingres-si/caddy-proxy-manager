/**
 * The traffic signals' queries (src/lib/analytics/signals.ts): mitigation
 * spikes and blocked-traffic concentrations leave out sign-in redirects, so a
 * busy login page is never reported as blocked traffic; 5xx bursts read every
 * request.
 */
import { describe, expect, it, vi } from 'vitest';

const queries = vi.hoisted(() => [] as string[]);

vi.mock('@/src/lib/analytics/run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/analytics/run')>()),
  withAnalytics: async <T extends object>(_operation: string, _empty: T, run: () => Promise<T>) => ({ ...(await run()), status: 'ok' }),
  selectRows: vi.fn(async (sql: string) => {
    queries.push(sql);
    return [];
  }),
}));

import { getTrafficSignals } from '@/src/lib/analytics/signals';

describe('traffic signal queries', () => {
  it('leave sign-in redirects out of spikes and concentrations only', async () => {
    await getTrafficSignals([]);
    const spikes = queries.find((sql) => sql.includes('p_spike_min'));
    const concentrations = queries.find((sql) => sql.includes('by_country'));
    const minutes = queries.find((sql) => sql.includes('toStartOfMinute'));
    expect(spikes).toContain("!= 'auth'");
    expect(concentrations).toContain("!= 'auth'");
    expect(minutes).not.toContain("'auth'");
  });
});
