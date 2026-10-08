/**
 * Server-side render of the host editor: the page frame (breadcrumb, the
 * linkable section list, the bar), each section with its labelled fields, a
 * new host's name field in Routing, and raw Caddy JSON read-only for users
 * who are not administrators.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/proxy-hosts/7/edit',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(dashboard)/proxy-hosts/editor-actions', () => ({
  saveProxyHostEditorAction: vi.fn(),
  previewProxyHostEditorAction: vi.fn(),
}));

import type { ProxyHost } from '@/src/lib/models/proxy-hosts';
import type { HostEditorData } from '@/src/components/proxy-hosts/editor/types';
import { HostEditor } from '@/src/components/proxy-hosts/editor/HostEditor';
import { EditorProvider, type EditorContextValue } from '@/src/components/proxy-hosts/editor/fields';
import { hostToForm } from '@/src/components/proxy-hosts/editor/model';
import { SecuritySection } from '@/src/components/proxy-hosts/editor/SecuritySection';
import { AccessSection } from '@/src/components/proxy-hosts/editor/AccessSection';
import { AdvancedSection, CertificateSection, HeadersSection } from '@/src/components/proxy-hosts/editor/OtherSections';
import { RoutingSection } from '@/src/components/proxy-hosts/editor/RoutingSection';
import { ReviewPanel, type PreviewState } from '@/src/components/proxy-hosts/editor/ReviewPanel';

const host: ProxyHost = {
  id: 7,
  name: 'App',
  domains: ['app.example.com'],
  upstreams: ['http://10.0.0.5:8080'],
  certificateId: null,
  accessListId: null,
  sslForced: true,
  hstsEnabled: true,
  hstsSubdomains: true,
  allowWebsocket: true,
  preserveHostHeader: true,
  skipHttpsHostnameValidation: false,
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  customReverseProxyJson: '{"headers":{}}',
  customPreHandlersJson: null,
  authentik: null,
  loadBalancer: null,
  dnsResolver: null,
  upstreamDnsResolution: null,
  geoblock: null,
  geoblockMode: 'merge',
  waf: { enabled: true, mode: 'On', waf_mode: 'merge', excluded_rule_ids: [942430] },
  mtls: null,
  ingressiForwardAuth: null,
  forwardAuth: null,
  redirects: [],
  rewrite: null,
  locationRules: [],
  pathAllows: [],
  pathBlocks: [],
  pathRewrites: [],
  errorPages: [],
  rateLimit: null,
  tags: ['prod'],
};

function data(overrides: Partial<HostEditorData> = {}): HostEditorData {
  return {
    mode: 'edit',
    host,
    template: null,
    initialDomain: null,
    forwardAuthAccess: { userIds: [], groupIds: [] },
    certificates: [{ id: 2, name: 'Wildcard', type: 'imported', domains: ['*.example.com'], expiresAt: '2027-01-01T00:00:00.000Z', issuer: 'Example CA' }],
    servedCertificate: null,
    accessLists: [{ id: 3, name: 'Office', description: null, rules: 2, members: 0, defaultAction: 'deny', otherHosts: 1 }],
    blockedSourcesActive: true,
    caCertificates: [],
    mtlsRoles: [],
    clientCertificates: [],
    users: [],
    groups: [],
    canChooseTrust: true,
    canChooseUsers: true,
    canChooseGroups: true,
    canChooseAccessLists: true,
    isAdmin: true,
    authentikDefaults: null,
    forwardAuthDefaults: null,
    scopeTags: [],
    approval: { policies: [], canEmergency: false },
    wafGlobal: { appliesToAll: true, mode: 'On', loadOwaspCrs: true, paranoiaLevel: 1, inboundThreshold: 5 },
    wafExclusions: [
      { id: 1, ruleId: 942430, wholeHost: true, path: null, pathMatch: null, variable: null, reason: 'Search box', createdBy: 'admin', createdAt: '2026-09-12T00:00:00.000Z' },
      { id: 2, ruleId: 920420, wholeHost: false, path: '/upload', pathMatch: 'prefix', variable: null, reason: 'Uploads', createdBy: null, createdAt: '2026-07-02T00:00:00.000Z' },
    ],
    wafRuleMessages: { 942430: 'Restricted SQL Character Anomaly Detection (args)' },
    canReadWaf: true,
    rateLimitDefaults: null,
    geoblockGlobal: null,
    dnsProviderConfigured: false,
    lastSaved: { at: '2026-01-02T00:00:00.000Z', by: 'admin' },
    historyHref: '/audit-log?search=App',
    ...overrides,
  };
}

function inEditor(element: ReactElement, editorData: HostEditorData = data()): string {
  const form = hostToForm(editorData.host!);
  const value: EditorContextValue = {
    form,
    saved: form,
    data: editorData,
    lookup: {
      certificate: String,
      accessList: String,
      user: String,
      group: String,
      role: String,
      clientCertificate: String,
      globalWafMode: 'blocking',
    },
    update: () => {},
    errors: {},
    touch: () => {},
    wasOf: () => null,
  };
  return renderToStaticMarkup(createElement(EditorProvider, { value, children: element }));
}

describe('host editor page', () => {
  it('on a host\'s page: one tab bar with Overview, the sections and History, opening on the overview without a bar', () => {
    const workspace = {
      header: (tabs: unknown) => createElement('header', { 'data-testid': 'page-header' }, tabs as never),
      overview: createElement('p', null, 'The overview'),
      history: createElement('p', null, 'The history'),
      historyCount: 4,
    };
    const html = renderToStaticMarkup(createElement(HostEditor, { data: data(), workspace }));
    expect(html).toContain('data-testid="page-header"');
    expect(html).toContain('aria-label="Host sections"');
    for (const tab of ['overview', 'routing', 'security', 'access', 'certificate', 'headers', 'advanced', 'history']) {
      expect(html).toContain(`href="#${tab}"`);
    }
    expect(html).toMatch(/<a href="#overview" role="tab" aria-selected="true"/);
    expect(html).toContain('The overview');
    expect(html).not.toContain('The history');
    // Nothing changed: no bar, and no editor-only header (the page has its own).
    expect(html).not.toContain('data-testid="host-editor-bar"');
    expect(html).not.toContain('Edit App');
  });

  it('asks for a new host’s name in Routing and starts from ?domain=', () => {
    const html = renderToStaticMarkup(createElement(HostEditor, { data: data({ mode: 'create', host: null, initialDomain: 'new.example.com', lastSaved: null }) }));
    expect(html).toContain('New proxy host');
    expect(html).toContain('<label for="f-name"');
    expect(html).toContain('new.example.com');
    expect(html).toContain('>Create host<');
    // The same tab bar, without Overview and History, and the bar from the start.
    expect(html).toContain('aria-label="Host settings"');
    expect(html).toMatch(/<a href="#routing" role="tab" aria-selected="true"/);
    expect(html).not.toContain('href="#overview"');
    expect(html).toContain('data-testid="host-editor-bar"');
  });
});

describe('host editor sections', () => {
  it('Routing: domains, upstreams, load balancing and protocols', () => {
    const html = inEditor(createElement(RoutingSection));
    expect(html).toContain('Add domains');
    expect(html).toContain('aria-label="Domains"');
    expect(html).toContain('placeholder="10.0.0.5:8080"');
    expect(html).toContain('aria-label="Upstream 1 scheme"');
    expect(html).toContain('Custom load balancing');
    expect(html).toContain('Path-based routes');
    // Edit mode keeps the name in Advanced.
    expect(html).not.toContain('<label for="f-name"');
  });

  it('Security: the WAF mode, the host’s exclusions and rate limiting', () => {
    const html = inEditor(createElement(SecuritySection));
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*?Block/s);
    // Global mode names the mode the WAF settings give it today.
    expect(html).toContain('Currently blocking.');
    expect(html).toContain('Restricted SQL Character Anomaly Detection (args)');
    expect(html).toContain('aria-label="Remove exclusion of rule 942430"');
    expect(html).toContain('paths under /upload');
    expect(html).toContain('Rate limiting');
    // Rate limiting off still applies the global defaults: the card says so when there are any.
    expect(html).not.toContain('global default rules apply');
    expect(inEditor(createElement(SecuritySection), data({ rateLimitDefaults: { enabled: true, rules: 2 } }))).toContain('Off: the 2 global default rules apply.');
  });

  it('Access: access list, geo blocking, sign-in, mTLS and blocked paths', () => {
    const html = inEditor(createElement(AccessSection));
    expect(html).toContain('<label for="f-access-list"');
    expect(html).toContain('Blocked sources');
    expect(html).toContain('aria-label="Provider"');
    expect(html).toContain('Require client certificates');
    expect(html).toContain('Blocked paths');
  });

  it('Certificate and Headers', () => {
    const certificate = inEditor(createElement(CertificateSection));
    expect(certificate).toContain('Managed by Caddy (automatic)');
    expect(certificate).toContain('Wildcard · imported');
    expect(certificate).toContain('Redirect HTTP to HTTPS');
    const headers = inEditor(createElement(HeadersSection));
    expect(headers).toContain('Send the HSTS header');
    expect(headers).toContain('Include subdomains');
  });

  it('Advanced: raw Caddy JSON is read-only for users who are not administrators', () => {
    const admin = inEditor(createElement(AdvancedSection));
    expect(admin).toContain('<label for="f-name"');
    expect(admin).not.toMatch(/<textarea[^>]*id="f-reverse-proxy"[^>]*disabled/);
    const user = inEditor(createElement(AdvancedSection), data({ isAdmin: false }));
    expect(user).toContain('Only administrators can change custom Caddy JSON.');
    expect(user).toMatch(/<textarea[^>]*disabled=""[^>]*id="f-reverse-proxy"|<textarea[^>]*id="f-reverse-proxy"[^>]*disabled=""/);
  });
});

describe('host editor review', () => {
  const window = { restricted: false, open: true, nextOpenAt: null, description: null };
  function review(required: boolean, policiesExist: boolean): string {
    const preview = {
      status: 'ready',
      preview: {
        approval: { required, policies: required ? [{ id: 1, name: 'Production' }] : [], requiredApprovals: 1, operations: ['update'], window, emergencyAllowed: false, minEmergencyReasonLength: 10 },
        changes: [],
        impact: { lines: [{ key: 'reload', text: 'Reloads its configuration on this node.' }] },
        warning: null,
      },
    } as unknown as PreviewState;
    const noop = () => {};
    return renderToStaticMarkup(
      createElement(ReviewPanel, {
        title: 'Review 1 change to App', changes: [], creating: false, preview, note: '', onNote: noop, emergency: false, onEmergency: noop,
        emergencyReason: '', onEmergencyReason: noop, submitError: null, submitting: false, submitLabel: required ? 'Submit for approval' : 'Save changes',
        onSubmit: noop, onClose: noop, onShow: noop, onUndo: noop, hostLabel: 'App', policiesExist,
      })
    );
  }

  it('says no approval is needed only where approval policies exist', () => {
    expect(review(false, true)).toContain('No approval needed.');
    expect(review(false, false)).not.toContain('No approval needed.');
    expect(review(false, false)).toContain('Reloads its configuration on this node.');
  });

  it('says which policy covers a change and what it needs', () => {
    const html = review(true, true);
    expect(html).toContain('This change needs approval');
    expect(html).toContain('App is covered by &quot;Production&quot;.');
    expect(html).toContain('needs 1 approval from someone other than you, and is applied as soon as it is approved.');
  });
});
