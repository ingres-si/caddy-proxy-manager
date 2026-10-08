/**
 * Server-side render of the compliance views: the page and its actions,
 * report documents and the print view (values rendered as text, the
 * statement and SHA-256 shown), and incident drafts with their AI label.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/compliance',
  useSearchParams: () => new URLSearchParams(),
}));

import ComplianceClient from '@/ee/compliance/ui/ComplianceClient';
import ReportDocumentView from '@/ee/compliance/ui/ReportDocumentView';
import PrintShell from '@/ee/compliance/ui/PrintShell';
import IncidentDocumentView from '@/ee/compliance/ui/IncidentDocumentView';
import IncidentEditor from '@/ee/compliance/ui/IncidentEditor';
import { COMPLIANCE_STATEMENT, controlsFor, describeControlMapping } from '@/ee/compliance/controls';
import { emptyAssessment } from '@/ee/compliance/incident-register';
import { INCIDENT_STAGES, emptyStage } from '@/ee/compliance/incident-stages';
import type { ComplianceReportDocument, IncidentSummaryView, IncidentView, StoredReportSummary } from '@/ee/compliance/types';
import type { ControlStatusView } from '@/ee/compliance/control-status';
import type { ReportScheduleView } from '@/ee/compliance/schedules';

const stamp = '2026-09-30T12:00:00.000Z';

const document: ComplianceReportDocument = {
  format: 'compliance-report',
  formatVersion: 1,
  reportId: '00000000-0000-4000-8000-000000000001',
  type: 'access_review',
  title: 'Access review',
  period: { from: '2026-09-01T00:00:00.000Z', to: stamp },
  generatedAt: stamp,
  generatedBy: { userId: 1, name: 'Alice Admin', email: 'admin@example.com' },
  product: { name: 'Ingressi', version: '1.2.3' },
  instanceMode: 'standalone',
  statement: COMPLIANCE_STATEMENT,
  controls: controlsFor('access_review'),
  summary: [{ key: 'users', label: 'Dashboard users', value: 2 }],
  findings: [{ severity: 'high', code: 'admin_without_mfa', subject: 'user:2', message: 'Administrator Bob has no second factor (MFA) set up.' }],
  sections: [
    {
      key: 'users',
      title: 'Users',
      description: null,
      columns: [{ key: 'email', label: 'E-mail' }, { key: 'name', label: 'Name' }, { key: 'permissions', label: 'Permissions' }, { key: 'administrator', label: 'Administrator' }],
      rows: [{ email: 'bob@example.com', name: '<img src=x onerror=alert(1)>', permissions: ['all'], administrator: true }],
      truncated: { shown: 1, total: 3 },
    },
  ],
  notes: ['A note.'],
};

const stages = INCIDENT_STAGES.map((definition) => ({
  ...emptyStage(definition.key),
  key: definition.key,
  label: definition.label,
  legalBasis: definition.legalBasis,
  deadline: stamp,
  deadlineRule: definition.deadlineRule,
  status: 'open' as const,
}));
stages[0] = { ...stages[0], fields: { ...stages[0].fields, summary: 'Login attempts.' }, ai: { generatedAt: stamp, provider: 'anthropic', model: 'claude-opus-5' }, editedAt: null };

const incident: IncidentView = {
  id: 7,
  title: 'Credential stuffing',
  status: 'open',
  language: 'en',
  detectedAt: stamp,
  period: { from: '2026-09-29T12:00:00.000Z', to: stamp },
  alertEventId: null,
  proxyHosts: [],
  facts: null,
  factsCollectedAt: stamp,
  stages,
  createdAt: stamp,
  createdBy: { userId: 1, name: 'Alice Admin' },
  updatedAt: stamp,
  startedAt: null,
  endedAt: null,
  classification: 'undetermined',
  classifiedAt: null,
  classifiedBy: null,
  assessment: emptyAssessment(),
  suggestedClassification: 'undetermined',
  cause: null,
  timeline: [],
  closedAt: null,
  notification: 'undetermined',
};

const controls: ControlStatusView = {
  checkedAt: '2026-10-03T09:36:00.000Z',
  counts: { met: 1, attention: 1, not_met: 0, unknown: 0 },
  statement: COMPLIANCE_STATEMENT,
  controls: [
    {
      key: 'tls',
      title: 'TLS on every host',
      status: 'met',
      statusLabel: 'Met',
      checked: 'All 3 enabled hosts redirect HTTP to HTTPS.',
      evidence: [{ label: 'Protection coverage, Sep 2026', route: '/compliance/reports/4', kind: 'report' }],
      references: { nis2: { ref: 'Art. 21(2)(h)', title: 'Cryptography' }, iso27001: { ref: 'A.8.24', title: 'Use of cryptography' } },
      facts: {},
    },
    {
      key: 'backup_restore',
      title: 'Backups restored in a test',
      status: 'attention',
      statusLabel: 'Overdue',
      checked: 'The last test restore was 93 days ago.',
      evidence: [
        { label: 'Backup runs', route: '/history', kind: 'page' },
        { label: 'Test restore, 2026-07-02', route: '/compliance', kind: 'record' },
      ],
      references: { nis2: { ref: 'Art. 21(2)(c)', title: 'Business continuity' }, iso27001: { ref: 'A.8.13', title: 'Information backup' } },
      facts: {},
    },
  ],
};

const schedule: ReportScheduleView = {
  id: 2,
  name: 'Monthly evidence',
  enabled: true,
  frequency: 'monthly',
  weekday: null,
  dayOfMonth: 1,
  time: '06:00',
  timeZone: 'Europe/Rome',
  reportTypes: ['access_review', 'change_log'],
  questions: [],
  channelIds: [5],
  nextRunAt: '2026-11-01T05:00:00.000Z',
  nextPeriod: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' },
  lastRunAt: '2026-10-01T04:00:00.000Z',
  lastStatus: 'success',
  lastError: null,
  lastPackId: 'pack-1',
  lastDeliveries: [{ channelId: 5, channelName: 'Ops mail', ok: false, error: 'SMTP error' }],
  lastReports: [],
  createdAt: stamp,
  updatedAt: stamp,
};

const report: StoredReportSummary = {
  id: 12,
  reportId: '00000000-0000-4000-8000-000000000012',
  type: 'access_review',
  title: 'Access review',
  period: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T23:59:59.999Z' },
  generatedAt: '2026-10-01T04:00:00.000Z',
  generatedBy: { userId: null, name: 'Schedule "Monthly evidence"' },
  sha256: 'ab'.repeat(32),
  findings: { high: 0, medium: 1, low: 2, info: 0 },
  sizeBytes: 2048,
  scheduleId: 2,
  packId: 'pack-1',
};

const summary: IncidentSummaryView = {
  id: 7,
  title: 'Credential stuffing',
  status: 'open',
  detectedAt: stamp,
  nextDeadline: { stage: 'early_warning', label: 'Early warning', at: '2026-10-01T12:00:00.000Z', overdue: false },
  submittedStages: 0,
  createdAt: stamp,
  createdBy: { userId: 1, name: 'Alice Admin' },
  startedAt: '2026-09-30T09:00:00.000Z',
  endedAt: null,
  proxyHostCount: 0,
  classification: 'significant',
  notification: 'required',
  closedAt: null,
};

type ClientProps = Parameters<typeof ComplianceClient>[0];

function renderPage(overrides: Partial<ClientProps> = {}) {
  return renderToStaticMarkup(
    createElement(ComplianceClient, {
      initialTab: 'overview',
      initialFramework: 'nis2',
      reports: { reports: [report], total: 1, page: 1, perPage: 25 },
      incidents: { incidents: [summary], total: 1, page: 1, perPage: 25 },
      controls,
      schedules: [schedule],
      restoreTests: {
        tests: [{ id: 3, testedAt: '2026-07-02T10:00:00.000Z', source: 'backup', backupDestination: { id: 1, name: 'Offsite' }, backupObjectKey: 'prod/config.json', outcome: 'success', notes: 'Every host answered.', recordedBy: { userId: 1, name: 'Alice Admin' }, createdAt: stamp }],
        total: 1,
        page: 1,
        perPage: 20,
      },
      lastReport: { kind: 'pack', scheduleId: 2, generatedAt: report.generatedAt, reports: [{ ...report, integrity: { tone: 'ok', text: 'Intact, matches its audit event' } }] },
      channels: [{ id: 5, name: 'Ops mail', type: 'email' }],
      destinations: [],
      sources: { alertEvents: [], proxyHosts: [] },
      mapping: describeControlMapping(),
      canWrite: true,
      ...overrides,
    })
  );
}

describe('compliance page', () => {
  it('pages the incident register, the test restores and the reports with the shared pager', () => {
    const html = renderPage({
      incidents: { incidents: [summary], total: 60, page: 2, perPage: 25 },
      restoreTests: { tests: [], total: 30, page: 1, perPage: 25 },
    });
    expect(html).toContain('aria-label="Pages of incidents"');
    expect(html).toMatch(/<span class="num">26<\/span>–<span class="num">50<\/span> of <span class="num">60<\/span> incidents/);
    expect(html).toContain('href="/compliance?incidentPage=3"');
    expect(html).toContain('aria-label="Pages of test restores"');
    expect(html).toContain('href="/compliance?restorePage=2"');
    const reports = renderPage({ initialTab: 'reports', reports: { reports: [report], total: 40, page: 1, perPage: 25 } });
    expect(reports).toContain('aria-label="Pages of reports"');
    expect(reports).toContain('href="/compliance?tab=reports&amp;page=2"');
  });

  it('offers generating a report and recording an incident to writers', () => {
    const html = renderPage();
    for (const label of ['Generate report', 'Record an incident']) {
      const button = html.match(new RegExp(`<button([^>]*)>(?:(?!</button>).)*${label}`, 's'));
      expect(button, label).not.toBeNull();
      expect(button![1]).not.toContain('disabled=""');
    }
    const reader = renderPage({ canWrite: false });
    expect(reader).not.toContain('Generate report');
    expect(reader).not.toContain('Record an incident');
  });

  it('shows the next schedule, the last evidence pack, the controls, test restores and the register', () => {
    const html = renderPage();
    expect(html).toContain('Monthly evidence');
    expect(html).toContain('Covers 1 to 31 Oct 2026');
    expect(html).toContain('Monthly on day 1 at 06:00 (Europe/Rome)');
    expect(html).toContain('Intact, matches its audit event');
    expect(html).toContain('href="/print/compliance/reports/12"');
    expect(html).toContain('href="/api/v1/compliance/reports/12/export?format=json"');
    expect(html).toContain('TLS on every host');
    expect(html).toContain('Art. 21(2)(h)');
    expect(html).not.toContain('A.8.24');
    // Evidence on this page and the backup runs point at their sections.
    expect(html).toContain('href="#restore-tests"');
    expect(html).toContain('href="/backups"');
    expect(html).toContain('prod/config.json');
    expect(html).toContain('Credential stuffing');
    expect(html).toContain('Significant');
    expect(html).toContain('Early warning');
    expect(html).toContain('does not by itself show compliance');
  });

  it('shows the ISO/IEC 27001 references when that framework is chosen', () => {
    const html = renderPage({ initialFramework: 'iso27001' });
    expect(html).toContain('ISO/IEC 27001 control');
    expect(html).toContain('A.8.24');
    expect(html).toContain('ISO/IEC 27001:2022, Annex A');
  });

  it('lists reports and schedules with their last run on the reports tab', () => {
    const html = renderPage({ initialTab: 'reports' });
    expect(html).toContain('href="/compliance/reports/12"');
    expect(html).toContain('Schedule “Monthly evidence”');
    expect(html).toContain('Report schedules');
    expect(html).toContain('notice failed to Ops mail');
    expect(html).toMatch(/aria-label="Run Monthly evidence now"/);
  });

  it('keeps the control mapping with its statement', () => {
    const html = renderPage({ initialTab: 'mapping' });
    expect(html).toContain('does not by itself show compliance');
    expect(html).toContain('A.5.15');
  });

  it('hides every change for a read-only role', () => {
    const html = renderPage({ canWrite: false });
    expect(html).not.toContain('Generate report');
    expect(html).not.toContain('Record an incident');
    expect(html).not.toContain('Record a test restore');
  });
});

describe('report document', () => {
  it('renders values as text with the statement, controls, findings and hash', () => {
    const html = renderToStaticMarkup(createElement(ReportDocumentView, { document, sha256: 'ab'.repeat(32) }));
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).toContain('does not by itself show compliance');
    expect(html).toContain('A.5.15');
    expect(html).toContain('ab'.repeat(32));
    expect(html).toContain('Shows the first 1 of 3 rows');
    expect(html).toContain('>yes<');
  });

  it('prints black on white without the dashboard navigation', () => {
    const html = renderToStaticMarkup(
      createElement(PrintShell, { backHref: '/compliance/reports/1', children: createElement(ReportDocumentView, { document, sha256: 'cd'.repeat(32) }) })
    );
    expect(html).toContain('@page { size: A4 landscape');
    // The light theme's tokens, whatever theme the dashboard uses.
    expect(html).toMatch(/<div class="light [^"]*bg-white/);
    expect(html).toContain('Print / PDF');
    expect(html).not.toContain('Proxy hosts');
  });
});

describe('incident drafts', () => {
  it('labels AI-generated text in the print view and the editor', () => {
    const printed = renderToStaticMarkup(createElement(IncidentDocumentView, { incident, productName: 'Ingressi' }));
    expect(printed).toContain('AI-generated first draft (anthropic, claude-opus-5');
    expect(printed).toContain('it has not been sent to anyone');
    expect(printed).toContain('NIS2 Art. 23(4)(a)');
    // The register entry comes first: classification and the Art. 23(3) questions.
    expect(printed).toContain('Register entry');
    expect(printed).toContain('Not assessed yet');
    expect(printed).toContain('NIS2 Art. 23(3)(a)');
    const editor = renderToStaticMarkup(
      createElement(IncidentEditor, { initial: incident, proxyHosts: [], canWrite: true, aiConfigured: false })
    );
    expect(editor).toContain('AI-generated first draft');
    expect(editor).toContain('Nothing is sent from here');
    expect(editor).toMatch(/<button[^>]*disabled=""[^>]*title="Configure an AI provider under AI settings first"/);
  });
});
