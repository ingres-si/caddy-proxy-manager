/**
 * Small identity helpers: describing a session's device from its User-Agent,
 * its approximate place from the GeoLite2 databases, the interface
 * preferences' checks and the preference-aware date and number formatting.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const geo = vi.hoisted(() => ({
  country: new Map<string, unknown>(),
  asn: new Map<string, unknown>(),
}));

vi.mock('maxmind', () => ({
  default: {
    open: vi.fn(async (path: string) => ({
      get: (ip: string) => (path.includes('Country') ? geo.country : geo.asn).get(ip) ?? null,
    })),
  },
}));

import { parseUserAgent } from '@/src/lib/user-agent';
import { lookupIpLocation, normalizeIp, resetGeoipLookupForTests } from '@/src/lib/geoip-lookup';
import { parsePreferencesInput } from '@/src/lib/preferences';
import { isValidTimeZone, listTimeZones, numberFormatExample } from '@/src/lib/preferences-shared';
import { formatDate, formatDateTime, formatNumber, formatPercent, formatRelative, formatTime } from '@/src/lib/date-format';
import { ApiValidationError } from '@/src/lib/api-errors';

const dir = mkdtempSync(join(tmpdir(), 'ingressi-geoip-'));
const paths = { country: join(dir, 'GeoLite2-Country.mmdb'), asn: join(dir, 'GeoLite2-ASN.mmdb') };

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('parseUserAgent', () => {
  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'Safari on macOS', 'desktop'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox on Linux', 'desktop'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', 'Chrome on Windows', 'desktop'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0', 'Edge on Windows', 'desktop'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari on iOS', 'mobile'],
    ['Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1', 'Chrome on iOS', 'tablet'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36', 'Chrome on Android', 'mobile'],
    ['curl/8.7.1', 'curl', 'unknown'],
  ])('%s', (ua, label, kind) => {
    expect(parseUserAgent(ua)).toMatchObject({ label, kind });
  });

  it('describes a missing or odd User-Agent without guessing', () => {
    expect(parseUserAgent(null)).toEqual({ browser: null, os: null, kind: 'unknown', label: 'Unknown device' });
    expect(parseUserAgent('   ')).toMatchObject({ label: 'Unknown device' });
    expect(parseUserAgent('x'.repeat(100_000)).label).toBe('Unknown device');
  });
});

describe('lookupIpLocation', () => {
  beforeEach(() => {
    resetGeoipLookupForTests();
    geo.country.clear();
    geo.asn.clear();
    rmSync(paths.country, { force: true });
    rmSync(paths.asn, { force: true });
  });

  it('answers null without the databases, and for addresses that are not addresses', async () => {
    expect(await lookupIpLocation('203.0.113.24', paths)).toBeNull();
    expect(await lookupIpLocation('not an ip', paths)).toBeNull();
    expect(await lookupIpLocation(null, paths)).toBeNull();
  });

  it('combines the country and the network, and strips IPv4-mapped prefixes', async () => {
    writeFileSync(paths.country, '');
    writeFileSync(paths.asn, '');
    geo.country.set('203.0.113.24', { country: { iso_code: 'IT', names: { en: 'Italy' } } });
    geo.asn.set('203.0.113.24', { autonomous_system_number: 64500, autonomous_system_organization: 'Example Telecom' });
    expect(await lookupIpLocation('::ffff:203.0.113.24', paths)).toEqual({
      countryCode: 'IT', country: 'Italy', asn: 64500, network: 'Example Telecom',
    });
    // Only one database knows the address.
    geo.asn.set('2001:db8::1', { autonomous_system_number: 64501, autonomous_system_organization: 'Example Mobile' });
    expect(await lookupIpLocation('2001:db8::1', paths)).toEqual({ countryCode: null, country: null, asn: 64501, network: 'Example Mobile' });
  });

  it('normalizes addresses', () => {
    expect(normalizeIp(' 198.51.100.40 ')).toBe('198.51.100.40');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeIp('example.com')).toBeNull();
  });
});

describe('interface preferences', () => {
  it('accepts the documented values only', () => {
    expect(parsePreferencesInput({
      theme: 'dark',
      timeZone: 'Europe/Rome',
      numberFormat: 'de-DE',
      proxyHostsSort: 'host:asc',
      l4ProxyHostsSort: 'name:desc',
      clientCertificatesSort: 'expires:asc',
    })).toEqual({
      theme: 'dark',
      timeZone: 'Europe/Rome',
      numberFormat: 'de-DE',
      proxyHostsSort: 'host:asc',
      l4ProxyHostsSort: 'name:desc',
      clientCertificatesSort: 'expires:asc',
    });
    expect(parsePreferencesInput({})).toEqual({});
    for (const body of [null, [], 'dark', { theme: 'blue' }, { timeZone: 'Mars/Olympus' }, { timeZone: '../etc' },
      { numberFormat: 'xx-XX' }, { proxyHostsSort: 'host:sideways' }, { l4ProxyHostsSort: 'magic:asc' },
      { clientCertificatesSort: 'expires:first' }, { language: 'it' }]) {
      expect(() => parsePreferencesInput(body)).toThrow(ApiValidationError);
    }
  });

  it('knows time zones and number formats', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Nowhere/City')).toBe(false);
    expect(listTimeZones()[0]).toBe('UTC');
    expect(numberFormatExample('en-US')).toBe('1,234.5');
    expect(numberFormatExample('de-DE')).toBe('1.234,5');
  });
});

describe('preference-aware formatting', () => {
  const at = '2026-10-03T11:36:00.000Z';

  it('formats dates and times in the account\'s time zone, UTC by default', () => {
    expect(formatDateTime(at)).toBe('3 Oct 2026, 11:36 UTC');
    expect(formatDateTime(at, { timeZone: 'Asia/Tokyo' })).toMatch(/^3 Oct 2026, 20:36 GMT\+9$/);
    expect(formatDate(at, { timeZone: 'America/New_York' })).toBe('3 Oct 2026');
    expect(formatTime(at, { timeZone: 'Europe/London' })).toBe('12:36');
    expect(formatDateTime('not a date')).toBe('');
  });

  it('formats numbers with the account\'s number format', () => {
    expect(formatNumber(61817.5, { numberFormat: 'en-US' })).toBe('61,817.5');
    expect(formatNumber(61817.5, { numberFormat: 'de-DE' })).toBe('61.817,5');
    expect(formatNumber(61817.5, { numberFormat: 'fr-FR' }).replace(/\s/g, ' ')).toBe('61 817,5');
    expect(formatPercent(0.018, { numberFormat: 'de-DE' }).replace(/\s/g, ' ')).toBe('1,8 %');
  });

  it('says how long ago', () => {
    const now = Date.parse(at);
    expect(formatRelative(now - 10_000, now)).toBe('Now');
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3 hours ago');
    expect(formatRelative(now - 86_400_000, now)).toBe('1 day ago');
  });
});
