/**
 * The L4 hosts page's query, filtering, counting, sorting, paging and
 * descriptions (app/(dashboard)/l4-proxy-hosts/list.ts) and the port helpers
 * of the pending-ports banner.
 */
import { describe, expect, it } from 'vitest';
import type { L4ProxyHost } from '@/src/lib/models/l4-proxy-hosts';
import {
  buildL4ListView,
  l4DetailGroups,
  listenPort,
  matchesL4Search,
  matcherText,
  parseL4ListQuery,
  serverNameSummary,
  sortL4Hosts,
} from '@/app/(dashboard)/l4-proxy-hosts/list';
import { portLabel, portMappingFor } from '@/src/components/l4-proxy-hosts/L4PortsApplyBanner';

function host(overrides: Partial<L4ProxyHost>): L4ProxyHost {
  return {
    id: 1,
    name: 'Git over SSH',
    protocol: 'tcp',
    listenAddress: ':2222',
    upstreams: ['forgejo:22'],
    matcherType: 'none',
    matcherValue: [],
    tlsTermination: false,
    proxyProtocolVersion: null,
    proxyProtocolReceive: false,
    enabled: true,
    meta: null,
    loadBalancer: null,
    dnsResolver: null,
    upstreamDnsResolution: null,
    geoblock: null,
    geoblockMode: 'merge',
    tags: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('L4 hosts list', () => {
  it('searches name, port, upstreams, server names and tags', () => {
    const h = host({ matcherType: 'tls_sni', matcherValue: ['git.example.com'], tags: ['dev'] });
    for (const q of ['git over', '2222', 'FORGEJO', 'git.example.com', 'dev']) expect(matchesL4Search(h, q)).toBe(true);
    expect(matchesL4Search(h, 'wireguard')).toBe(false);
  });

  it('sorts listen addresses by port number', () => {
    const hosts = [host({ id: 1, listenAddress: ':2222' }), host({ id: 2, listenAddress: '0.0.0.0:853' }), host({ id: 3, listenAddress: ':25' })];
    expect(sortL4Hosts(hosts, 'listenAddress', 'asc').map((h) => h.listenAddress)).toEqual([':25', '0.0.0.0:853', ':2222']);
    expect(sortL4Hosts(hosts, 'listenAddress', 'desc').map((h) => h.id)).toEqual([1, 2, 3]);
    expect([listenPort('[::]:853'), listenPort(':53'), listenPort('bad')]).toEqual([853, 53, null]);
  });

  it('sorts enabled hosts first by status, then by name', () => {
    const hosts = [
      host({ id: 1, name: 'Bravo', enabled: false }),
      host({ id: 2, name: 'Charlie' }),
      host({ id: 3, name: 'Alpha' }),
    ];
    expect(sortL4Hosts(hosts, 'enabled', 'asc').map((h) => h.name)).toEqual(['Alpha', 'Charlie', 'Bravo']);
    expect(sortL4Hosts(hosts, 'enabled', 'desc').map((h) => h.name)).toEqual(['Bravo', 'Charlie', 'Alpha']);
  });

  it('reads the query from the URL, with defaults for anything unknown', () => {
    expect(parseL4ListQuery({})).toEqual({ search: '', protocol: 'all', status: 'all', sortBy: 'createdAt', sortDir: 'desc', page: 1 });
    expect(parseL4ListQuery({ search: '  ssh ', protocol: 'udp', status: 'disabled', sortBy: 'name', page: '3' })).toEqual({
      search: 'ssh',
      protocol: 'udp',
      status: 'disabled',
      sortBy: 'name',
      sortDir: 'asc',
      page: 3,
    });
    expect(parseL4ListQuery({ protocol: 'sctp', status: 'broken', sortBy: 'id; drop', sortDir: 'up', page: '-2' })).toMatchObject({
      protocol: 'all',
      status: 'all',
      sortBy: 'createdAt',
      sortDir: 'desc',
      page: 1,
    });
    expect(parseL4ListQuery({ sortBy: ['listenAddress', 'name'], sortDir: 'desc' })).toMatchObject({ sortBy: 'listenAddress', sortDir: 'desc' });
  });

  it('uses a saved default sort only when the URL does not specify one', () => {
    expect(parseL4ListQuery({}, { key: 'name', dir: 'desc' })).toMatchObject({ sortBy: 'name', sortDir: 'desc' });
    expect(parseL4ListQuery({ sortBy: 'listenAddress' }, { key: 'name', dir: 'desc' })).toMatchObject({
      sortBy: 'listenAddress',
      sortDir: 'asc',
    });
    expect(parseL4ListQuery({ sortDir: 'asc' }, { key: 'name', dir: 'desc' })).toMatchObject({
      sortBy: 'createdAt',
      sortDir: 'asc',
    });
  });

  it('filters, counts and pages the hosts', () => {
    const hosts = Array.from({ length: 60 }, (_, i) =>
      host({
        id: i + 1,
        name: `Host ${String(i + 1).padStart(2, '0')}`,
        listenAddress: `:${41000 + i}`,
        protocol: i % 3 === 0 ? 'udp' : 'tcp',
        enabled: i % 4 !== 0,
      })
    );
    const query = parseL4ListQuery({ sortBy: 'name' });
    const view = buildL4ListView(hosts, query);
    expect(view.page).toMatchObject({ page: 1, pageCount: 3, total: 60, from: 1, to: 25 });
    expect(view.page.items[0].name).toBe('Host 01');
    expect(view.protocolCounts).toEqual({ all: 60, tcp: 40, udp: 20 });
    expect(view.statusCounts).toEqual({ all: 60, enabled: 45, disabled: 15 });

    // The last page, and a page past the end clamped to it.
    expect(buildL4ListView(hosts, { ...query, page: 3 }).page).toMatchObject({ page: 3, from: 51, to: 60 });
    expect(buildL4ListView(hosts, { ...query, page: 99 }).page.items.map((h) => h.name)).toHaveLength(10);

    // Each filter's counts follow the search and the other filter.
    const udp = buildL4ListView(hosts, { ...query, protocol: 'udp' });
    expect(udp.page.total).toBe(20);
    expect(udp.statusCounts).toEqual({ all: 20, enabled: 15, disabled: 5 });
    expect(udp.protocolCounts).toEqual({ all: 60, tcp: 40, udp: 20 });
    const disabledUdp = buildL4ListView(hosts, { ...query, protocol: 'udp', status: 'disabled' });
    expect(disabledUdp.page.items.every((h) => h.protocol === 'udp' && !h.enabled)).toBe(true);
    expect(disabledUdp.protocolCounts).toEqual({ all: 15, tcp: 10, udp: 5 });

    const searched = buildL4ListView(hosts, { ...query, search: '4101' });
    expect(searched.page.items.map((h) => h.listenAddress)).toEqual([':41010', ':41011', ':41012', ':41013', ':41014', ':41015', ':41016', ':41017', ':41018', ':41019']);
    expect(searched.protocolCounts.all).toBe(10);
  });

  it('summarises server names for the list row', () => {
    expect(serverNameSummary(host({ matcherType: 'tls_sni', matcherValue: ['mail.example.com', 'smtp.example.com'] }))).toEqual({
      first: 'mail.example.com',
      more: 1,
    });
    expect(serverNameSummary(host({ matcherType: 'http_host', matcherValue: ['app.example.com'] }))).toEqual({ first: 'app.example.com', more: 0 });
    expect(serverNameSummary(host({ matcherType: 'proxy_protocol' }))).toBeNull();
    expect(matcherText(host({ protocol: 'udp' }))).toBe('None, every datagram');
  });

  it('summarises the host settings per editor tab, from the host settings only', () => {
    const groups = l4DetailGroups(
      host({
        upstreams: ['a:22', 'b:22'],
        loadBalancer: {
          enabled: true,
          policy: 'round_robin',
          tryDuration: null,
          tryInterval: null,
          activeHealthCheck: { enabled: true, port: 22, interval: '30s', timeout: null },
          passiveHealthCheck: null,
        },
        geoblock: {
          enabled: true,
          block_countries: [],
          block_continents: [],
          block_asns: [],
          block_cidrs: [],
          block_ips: [],
          allow_countries: [],
          allow_continents: [],
          allow_asns: [],
          allow_cidrs: ['203.0.113.0/26'],
          allow_ips: [],
        },
        geoblockMode: 'override',
        upstreamDnsResolution: { enabled: true, family: 'ipv4' },
      })
    );
    const values = Object.fromEntries(groups.flatMap((g) => g.items.map((item) => [item.label, item.value])));
    expect(values).toMatchObject({
      Protocol: 'TCP',
      Upstreams: 'a:22, b:22',
      'Load balancing': 'Round robin',
      'Health check': 'Connect to port 22 every 30s',
      'TLS termination': 'Off',
      'Geo blocking': 'Own rules only: allow 203.0.113.0/26',
      'Upstream DNS pinning': 'On, IPv4',
      'DNS resolver': 'Global resolvers',
      Tags: 'None',
    });
    // No traffic figures: the product has no source for L4 connection or byte counts.
    expect(JSON.stringify(groups)).not.toMatch(/connections now|transferred|bytes/i);
  });
});

describe('L4 port helpers', () => {
  it('maps a host to its published port and labels it', () => {
    expect(portMappingFor({ listenAddress: ':8883', protocol: 'tcp' })).toBe('8883:8883');
    expect(portMappingFor({ listenAddress: '0.0.0.0:51820', protocol: 'udp' })).toBe('51820:51820/udp');
    expect(portMappingFor({ listenAddress: 'bad', protocol: 'tcp' })).toBeNull();
    expect(portLabel('8883:8883')).toBe('8883/tcp');
    expect(portLabel('51820:51820/udp')).toBe('51820/udp');
  });
});
