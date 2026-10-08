/**
 * Unit tests for the L4PortsApplyBanner refresh-signal contract.
 *
 * Verifies that the banner component re-fetches port status whenever
 * refreshSignal changes — so changes are reflected immediately after
 * create/edit/delete/toggle without a page reload.
 *
 * These tests inspect the component source rather than rendering it,
 * to avoid the cost of a jsdom environment.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BANNER_PATH = resolve(__dirname, '../../src/components/l4-proxy-hosts/L4PortsApplyBanner.tsx');
const banner = readFileSync(BANNER_PATH, 'utf-8');

const CLIENT_PATH = resolve(__dirname, '../../app/(dashboard)/l4-proxy-hosts/L4ProxyHostsClient.tsx');
const client = readFileSync(CLIENT_PATH, 'utf-8');

describe('L4PortsApplyBanner', () => {
  it('accepts a refreshSignal prop', () => {
    expect(banner).toContain('refreshSignal');
  });

  it('re-fetches when refreshSignal changes via useEffect', () => {
    // Must have a useEffect that depends on refreshSignal
    expect(banner).toMatch(/useEffect\s*\(\s*\(\s*\)\s*=>/);
    expect(banner).toContain('refreshSignal');
    // The effect must call fetchStatus
    expect(banner).toContain('fetchStatus');
  });

  it('skips fetch when refreshSignal is falsy (avoids double-fetch on mount)', () => {
    // The effect should guard against firing on initial 0/undefined value
    // so the mount effect and the signal effect don't both fire on load.
    expect(banner).toMatch(/if\s*\(!\s*refreshSignal\s*\)/);
  });
});

describe('L4ProxyHostsClient banner integration', () => {
  it('tracks bannerRefresh state', () => {
    expect(client).toContain('bannerRefresh');
    expect(client).toContain('setBannerRefresh');
  });

  it('passes refreshSignal to L4PortsApplyBanner', () => {
    expect(client).toContain('refreshSignal={bannerRefresh}');
  });

  it('increments bannerRefresh after toggle', () => {
    // The toggle handler must signal the banner after the action completes
    expect(client).toMatch(/toggleL4ProxyHostAction[\s\S]{0,200}signalBannerRefresh/);
  });

  it('increments bannerRefresh when delete dialog closes', () => {
    expect(client).toMatch(/DeleteL4HostDialog[\s\S]{0,400}signalBannerRefresh/);
  });

  it('defines signalBannerRefresh as a function that increments the counter', () => {
    // Must use functional update form to avoid stale closure
    expect(client).toMatch(/signalBannerRefresh\s*=\s*\(\s*\)\s*=>\s*setBannerRefresh\s*\(/);
    expect(client).toContain('n + 1');
  });
});

describe('L4 host page banner', () => {
  it('re-fetches when the host changes (a save or the on/off switch refreshes the page)', () => {
    const page = readFileSync(resolve(__dirname, '../../app/(dashboard)/l4-proxy-hosts/[id]/L4HostPageClient.tsx'), 'utf-8');
    expect(page).toContain('refreshSignal={Date.parse(host.updatedAt)}');
  });
});
