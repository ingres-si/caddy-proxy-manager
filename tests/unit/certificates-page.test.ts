/**
 * The certificates page's labels (app/(dashboard)/certificates/format.ts),
 * which hosts rely on a CA or an mTLS role (trust.ts), and the search,
 * filters and sort of the client certificate list (client-list.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  daysLeftText,
  formatDate,
  obtainedView,
  renewalView,
  rowSearchText,
  timeLeftText,
  usedBySummary,
  userHref,
} from '@/app/(dashboard)/certificates/format';
import { trustAnchorUsage } from '@/app/(dashboard)/certificates/trust';
import {
  clientCertSortFromPreference,
  clientCertStatus,
  clientCertStatusCounts,
  filterClientCerts,
  matchesClientCertQuery,
  sortClientCerts,
} from '@/app/(dashboard)/certificates/client-list';
import type { IssuedClientCertificateView } from '@/app/(dashboard)/certificates/page';
import type { CertificateOverviewRow } from '@/src/lib/certificate-overview';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 3, 12);

function row(overrides: Partial<CertificateOverviewRow>): CertificateOverviewRow {
  return {
    id: 'acme:1',
    kind: 'acme',
    certificateId: null,
    hostId: 1,
    name: 'Auth',
    domains: ['auth.example.com'],
    active: true,
    issuer: "Let's Encrypt",
    issuerFromCertificate: true,
    keyType: 'ECDSA P-256',
    validFrom: null,
    validTo: null,
    expirySource: null,
    daysLeft: null,
    obtainedBy: { method: 'acme', challenge: 'http-01', dnsProvider: null, directory: null },
    renewal: { state: 'unknown', renewFrom: null },
    usedBy: [{ kind: 'proxy_host', id: 1, name: 'Auth', domains: ['auth.example.com'] }],
    ...overrides,
  };
}

describe('certificate labels', () => {
  it('formats dates in UTC and time left in sensible units', () => {
    expect(formatDate('2026-11-03T23:30:00Z')).toBe('3 Nov 2026');
    expect(daysLeftText(31)).toBe('31 days');
    expect(daysLeftText(1)).toBe('1 day');
    expect(daysLeftText(0)).toBe('today');
    expect(daysLeftText(-3)).toBe('expired 3 days ago');
    expect(timeLeftText(new Date(NOW + 43 * DAY).toISOString(), NOW)).toBe('43 days');
    expect(timeLeftText(new Date(NOW + 3300 * DAY).toISOString(), NOW)).toBe('9 years');
  });

  it('describes each renewal state', () => {
    expect(renewalView(row({ renewal: { state: 'scheduled', renewFrom: '2026-11-28T00:00:00Z' } }), NOW)).toEqual({
      tone: 'ok',
      label: 'Automatic',
      detail: 'From 28 Nov',
    });
    expect(renewalView(row({ renewal: { state: 'due', renewFrom: '2026-10-01T00:00:00Z' } }), NOW)).toMatchObject({
      tone: 'warn',
      label: 'Due now',
      detail: 'Caddy is renewing it',
    });
    expect(renewalView(row({ renewal: { state: 'overdue', renewFrom: null } }), NOW).tone).toBe('bad');
    expect(renewalView(row({ kind: 'imported', renewal: { state: 'expired', renewFrom: null } }), NOW).detail).toBe(
      'Import a renewed certificate'
    );
    expect(renewalView(row({ renewal: { state: 'inactive', renewFrom: null } }), NOW)).toMatchObject({
      tone: 'off',
      detail: 'The host is disabled',
    });
    // Not read yet: the Expires column says so, the renewal column does not repeat it.
    expect(renewalView(row({}), NOW)).toEqual({ tone: 'off', label: 'Automatic', detail: '' });
  });

  it('says how a certificate is obtained', () => {
    expect(obtainedView({ method: 'acme', challenge: 'dns-01', dnsProvider: 'Cloudflare', directory: null })).toEqual({
      label: 'DNS-01',
      detail: 'Cloudflare',
    });
    expect(obtainedView({ method: 'acme', challenge: 'http-01', dnsProvider: null, directory: null })).toEqual({ label: 'HTTP-01', detail: '' });
    expect(obtainedView({ method: 'imported' })).toEqual({ label: 'Imported', detail: '' });
  });

  it('summarises and links the hosts using a certificate', () => {
    const proxy = { kind: 'proxy_host' as const, id: 1, name: 'DNS', domains: ['dns.example.com'] };
    const l4 = { kind: 'l4_host' as const, id: 2, name: 'DNS over TLS', domains: ['dns.example.com'] };
    expect(usedBySummary([proxy])).toBe('DNS');
    expect(usedBySummary([proxy, l4])).toBe('1 proxy host, and DNS over TLS (L4)');
    expect(userHref(proxy)).toBe('/proxy-hosts?search=dns.example.com');
    expect(userHref(l4)).toBe('/l4-proxy-hosts?search=DNS%20over%20TLS');
  });

  it('searches domains, names and the hosts using it', () => {
    const text = rowSearchText(row({ usedBy: [{ kind: 'l4_host', id: 2, name: 'MQTT', domains: ['iot.example.com'] }] }));
    expect(text).toContain('auth.example.com');
    expect(text).toContain('mqtt');
    expect(text).toContain('iot.example.com');
  });
});

describe('trustAnchorUsage', () => {
  const host = (id: number, mtls: Record<string, unknown> | null) => ({
    id,
    name: `Host ${id}`,
    domains: [`h${id}.example.com`],
    mtls: mtls as never,
  });

  it('finds hosts trusting a CA directly, through its certificates or through a role', () => {
    const issued = [
      { id: 10, caCertificateId: 1, revokedAt: null },
      { id: 11, caCertificateId: 2, revokedAt: null },
    ];
    const roles = new Map([[5, new Set([11])]]);
    const { caTrustedBy, roleRequiredBy } = trustAnchorUsage(
      [
        host(1, { enabled: true, ca_certificate_ids: [1] }),
        host(2, { enabled: true, trusted_client_cert_ids: [10] }),
        host(3, { enabled: true, trusted_role_ids: [5] }),
        host(4, { enabled: false, trusted_role_ids: [5] }),
        host(5, null),
      ],
      issued,
      roles
    );
    expect(caTrustedBy.get(1)?.map((h) => h.id)).toEqual([1, 2]);
    expect(caTrustedBy.get(2)?.map((h) => h.id)).toEqual([3]);
    expect(roleRequiredBy.get(5)).toEqual([{ id: 3, name: 'Host 3', domain: 'h3.example.com' }]);
  });
});

describe('client certificate list', () => {
  it('uses the saved default sort when one is configured', () => {
    expect(clientCertSortFromPreference('default')).toEqual({ key: 'expires', dir: 'asc' });
    expect(clientCertSortFromPreference('name:desc')).toEqual({ key: 'name', dir: 'desc' });
  });

  const at = (days: number) => new Date(NOW + days * DAY).toISOString();
  function cert(id: number, overrides: Partial<IssuedClientCertificateView> = {}): IssuedClientCertificateView {
    return {
      id,
      caCertificateId: 1,
      commonName: `device-${id}`,
      serialNumber: `19A4B2C3D${id}`,
      fingerprintSha256: 'AA:BB',
      validFrom: at(-30),
      validTo: at(300),
      revokedAt: null,
      createdAt: at(-30 + id),
      updatedAt: at(-30 + id),
      caName: 'Staff CA',
      roles: [],
      ...overrides,
    };
  }

  const certs = [
    cert(1, { commonName: 'alice', roles: ['staff'] }),
    cert(2, { commonName: 'bob', validTo: at(12) }),
    cert(3, { commonName: 'carol', validTo: at(-2) }),
    cert(4, { commonName: 'dave', revokedAt: at(-1), validTo: at(1) }),
    cert(5, { commonName: 'erin', caCertificateId: 2, caName: 'Contractors CA', serialNumber: 'C0FFEE01' }),
  ];

  it('tells active, expiring, expired and revoked certificates apart', () => {
    expect(certs.map((c) => clientCertStatus(c, NOW))).toEqual(['active', 'expiring', 'expired', 'revoked', 'active']);
  });

  it('searches common names, roles, CAs and serial numbers', () => {
    expect(matchesClientCertQuery(certs[0], 'ALI')).toBe(true);
    expect(matchesClientCertQuery({ ...certs[0], caName: null }, 'staff')).toBe(true);
    expect(matchesClientCertQuery(certs[4], 'contractors')).toBe(true);
    expect(matchesClientCertQuery(certs[4], 'c0:ff:ee')).toBe(true);
    // Short queries do not match inside hex serial numbers.
    expect(matchesClientCertQuery(certs[4], 'ff')).toBe(false);
    expect(matchesClientCertQuery(certs[0], 'zzz')).toBe(false);
  });

  it('filters by CA and status; active includes the expiring ones', () => {
    const ids = (filters: Parameters<typeof filterClientCerts>[1]) => filterClientCerts(certs, filters, NOW).map((c) => c.id);
    expect(ids({ query: '', caId: null, status: 'active' })).toEqual([1, 2, 5]);
    expect(ids({ query: '', caId: null, status: 'expiring' })).toEqual([2]);
    expect(ids({ query: '', caId: 2, status: 'all' })).toEqual([5]);
    expect(ids({ query: 'bo', caId: 1, status: 'revoked' })).toEqual([]);
    expect(clientCertStatusCounts(certs, { query: '', caId: 1 }, NOW)).toEqual({
      all: 4,
      active: 2,
      expiring: 1,
      expired: 1,
      revoked: 1,
    });
  });

  it('sorts by expiry with revoked certificates last, or by name, CA and issue date', () => {
    expect(sortClientCerts(certs, { key: 'expires', dir: 'asc' }).map((c) => c.id)).toEqual([3, 2, 1, 5, 4]);
    expect(sortClientCerts(certs, { key: 'expires', dir: 'desc' }).map((c) => c.id)).toEqual([1, 5, 2, 3, 4]);
    expect(sortClientCerts(certs, { key: 'name', dir: 'desc' }).map((c) => c.commonName)).toEqual(['erin', 'dave', 'carol', 'bob', 'alice']);
    expect(sortClientCerts(certs, { key: 'ca', dir: 'asc' })[0].id).toBe(5);
    expect(sortClientCerts(certs, { key: 'issued', dir: 'desc' })[0].id).toBe(5);
  });
});
