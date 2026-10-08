/**
 * The L4 host editor (src/components/l4-proxy-hosts/editor): the form model
 * (from a host, a copy or nothing; validation; unsaved changes per tab; the
 * form data the L4 host actions read) and a server-side render of the editor
 * and of an L4 host's page.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/l4-proxy-hosts/3',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(dashboard)/l4-proxy-hosts/actions', () => ({
  createL4ProxyHostAction: vi.fn(),
  updateL4ProxyHostAction: vi.fn(),
  deleteL4ProxyHostAction: vi.fn(),
  toggleL4ProxyHostAction: vi.fn(),
}));

import type { L4ProxyHost } from '@/src/lib/models/l4-proxy-hosts';
import {
  copyL4Form,
  l4FieldOfServerError,
  l4FormChanges,
  l4FormData,
  l4HostToForm,
  newL4Form,
  validateL4Form,
} from '@/src/components/l4-proxy-hosts/editor/model';
import { L4HostEditor } from '@/src/components/l4-proxy-hosts/editor/L4HostEditor';
import L4HostPageClient from '@/app/(dashboard)/l4-proxy-hosts/[id]/L4HostPageClient';

const host: L4ProxyHost = {
  id: 3,
  name: 'DNS over TLS',
  protocol: 'tcp',
  listenAddress: ':853',
  upstreams: ['10.0.0.53:853'],
  matcherType: 'tls_sni',
  matcherValue: ['dns.example.com'],
  tlsTermination: true,
  proxyProtocolVersion: null,
  proxyProtocolReceive: false,
  enabled: true,
  meta: null,
  loadBalancer: null,
  dnsResolver: null,
  upstreamDnsResolution: null,
  geoblock: null,
  geoblockMode: 'merge',
  tags: ['dns'],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

describe('L4 host editor model', () => {
  it('builds the form from a host, a copy and nothing', () => {
    const form = l4HostToForm(host);
    expect(form).toMatchObject({ name: 'DNS over TLS', listenAddress: ':853', upstreams: ['10.0.0.53:853'], matcherValue: ['dns.example.com'], tlsTermination: true, proxyProtocolVersion: '' });
    expect(copyL4Form(host).name).toBe('DNS over TLS (copy)');
    // A scoped role's copy keeps only the role's tags, or gets its first one.
    expect(copyL4Form(host, ['team-a']).tags).toEqual(['team-a']);
    expect(newL4Form(['team-a', 'team-b'])).toMatchObject({ tags: ['team-a'], enabled: true, protocol: 'tcp', upstreams: [''] });
  });

  it('checks the form before saving, with the name where the tab bar shows it', () => {
    const blank = newL4Form();
    expect(Object.keys(validateL4Form(blank, 'routing')).sort()).toEqual(['l4-listen', 'l4-name', 'l4-up-0']);
    expect(validateL4Form(blank, 'advanced')['l4-name'].section).toBe('advanced');

    const form = { ...l4HostToForm(host), listenAddress: ':443', upstreams: ['10.0.0.53'], matcherValue: [] };
    const errors = validateL4Form(form, 'advanced');
    expect(errors['l4-listen'].message).toMatch(/443 is Caddy's own/);
    expect(errors['l4-up-0'].message).toMatch(/host:port/);
    expect(errors['l4-matcher-value'].section).toBe('routing');
    expect(validateL4Form({ ...l4HostToForm(host), listenAddress: 'db' }, 'advanced')['l4-listen'].message).toMatch(/:PORT/);
    expect(validateL4Form(l4HostToForm(host), 'advanced')).toEqual({});
  });

  it('counts unsaved changes per tab, ignoring blank rows, spaces and tag order', () => {
    const saved = { ...l4HostToForm(host), tags: ['b', 'a'] };
    expect(l4FormChanges(saved, { ...saved, upstreams: [...saved.upstreams, ''], name: ' DNS over TLS ', tags: ['a', 'b'] }, 'advanced')).toEqual([]);
    const changed = {
      ...saved,
      name: 'DoT',
      listenAddress: ':8853',
      lb: { ...saved.lb, enabled: true },
      geo: { ...saved.geo, blockCountries: ['CN'] },
      pinning: { mode: 'enabled' as const, family: 'inherit' as const },
    };
    expect(l4FormChanges(saved, changed, 'advanced')).toEqual([
      { section: 'advanced', label: 'Name' },
      { section: 'routing', label: 'Listen address' },
      { section: 'load-balancing', label: 'Load balancing' },
      { section: 'security', label: 'Geo blocking' },
      { section: 'advanced', label: 'Upstream DNS pinning' },
    ]);
    // TLS termination is off for UDP whatever the switch says.
    expect(l4FormChanges(saved, { ...saved, protocol: 'udp' }, 'advanced').map((change) => change.label)).toEqual(['Protocol', 'TLS termination']);
  });

  it('writes the form data the L4 host actions read', () => {
    const form = { ...l4HostToForm(host), upstreams: ['10.0.0.53:853', ' ', '10.0.0.54:853'], geo: { ...newL4Form().geo, enabled: true, blockAsns: ['AS64500', '64501'] } };
    const data = l4FormData(form);
    expect(data.get('upstreams')).toBe('10.0.0.53:853\n10.0.0.54:853');
    expect(data.get('matcherValue')).toBe('dns.example.com');
    expect(data.get('tlsTermination')).toBe('on');
    expect(data.get('enabledPresent')).toBe('1');
    expect(data.get('geoblockBlockAsns')).toBe('64500, 64501');
    expect(data.get('lbPresent')).toBe('1');
    expect(data.has('lbEnabled')).toBe(false);
    expect(data.has('proxyProtocolVersion')).toBe(false);
    // An existing host's on/off state is the page header's.
    expect(l4FormData(form, { enabled: false }).has('enabledPresent')).toBe(false);
    // No TLS termination over UDP.
    expect(l4FormData({ ...form, protocol: 'udp' }).has('tlsTermination')).toBe(false);
  });

  it('places a server error on its field', () => {
    expect(l4FieldOfServerError("Port 443 is reserved for Ingressi's own Caddy listeners", 'advanced')).toEqual({ id: 'l4-listen', section: 'routing' });
    expect(l4FieldOfServerError("Upstream 'db' must be in 'host:port' format", 'advanced')?.id).toBe('l4-up-0');
    expect(l4FieldOfServerError('The host needs at least one of your role\'s tags: team-a', 'advanced')).toEqual({ id: 'l4-tags', section: 'advanced' });
    expect(l4FieldOfServerError('Something else went wrong', 'advanced')).toBeNull();
  });
});

describe('L4 host editor render', () => {
  const data = { host: null, template: null, scopeTags: [], approval: null };

  it('renders a new host with its tabs, the name in Routing and the bar', () => {
    const html = renderToStaticMarkup(createElement(L4HostEditor, { data }));
    expect(html).toContain('New L4 host');
    for (const tab of ['Routing', 'Load balancing', 'Security', 'Advanced']) expect(html).toContain(`href="#${tab.toLowerCase().replace(' ', '-')}"`);
    expect(html).not.toContain('href="#overview"');
    expect(html).toContain('Name and tags');
    expect(html).toMatch(/<label[^>]*for="l4-listen"[^>]*>Listen address/);
    expect(html).toContain("Ports 80, 443 and 2019 are Caddy&#x27;s own.");
    expect(html).toContain('aria-label="Upstream 1"');
    expect(html).toContain('data-testid="host-editor-bar"');
    expect(html).toContain('Create host');
  });

  it('renders a copy with its banner', () => {
    const html = renderToStaticMarkup(createElement(L4HostEditor, { data: { ...data, template: host } }));
    expect(html).toContain('Copy of DNS over TLS');
    expect(html).toContain('A copy of DNS over TLS.');
  });

  it("renders an L4 host's page on its overview, without the bar until something changes", () => {
    const html = renderToStaticMarkup(
      createElement(L4HostPageClient, { host, canWrite: true, changes: { total: 2, entries: [] }, editor: { host, template: null, scopeTags: [], approval: null } })
    );
    expect(html).toMatch(/<h1[^>]*>.*DNS over TLS/);
    expect(html).toContain('href="#overview"');
    expect(html).toContain('href="#history"');
    expect(html).toContain('Configuration');
    expect(html).toContain('TLS SNI: dns.example.com');
    expect(html).toContain('aria-label="Edit routing"');
    expect(html).toContain('href="/l4-proxy-hosts/new?from=3"');
    expect(html).toContain('>Disable<');
    expect(html).not.toContain('data-testid="host-editor-bar"');
  });

  it('renders the page for a reader with Overview and History only', () => {
    const html = renderToStaticMarkup(createElement(L4HostPageClient, { host, canWrite: false, changes: null, editor: null }));
    expect(html).toContain('href="#overview"');
    expect(html).not.toContain('href="#routing"');
    expect(html).not.toContain('href="#history"');
    expect(html).not.toContain('Duplicate');
    expect(html).not.toContain('aria-label="Edit routing"');
  });
});
