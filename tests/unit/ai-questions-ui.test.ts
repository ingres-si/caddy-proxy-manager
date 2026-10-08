/**
 * Server render of the Ask box and of an answer (ee/ai/questions/ui): why
 * the box is read-only, the query in words with its Analytics link, the
 * labelled summary, the result as a figure, chart or ranked list, and what
 * was sent; values from requests are escaped.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/analytics',
  useSearchParams: () => new URLSearchParams(),
}));

import { AskPanel } from '@/ee/ai/questions/ui/AskPanel';
import { AnswerView } from '@/ee/ai/questions/ui/AnswerView';
import type { QuestionAnswer, QuestionAvailability, QuestionResult } from '@/ee/ai/questions/types';

const READY: QuestionAvailability = {
  providerConfigured: true,
  enabled: true,
  analyticsEnabled: true,
  provider: { name: 'Anthropic', model: 'claude-opus-5' },
  settings: { enabled: true, aiSummaries: true, shareRequestDetails: false },
};

function panel(availability: Partial<QuestionAvailability>): string {
  return renderToStaticMarkup(createElement(AskPanel, { availability: { ...READY, ...availability }, isAdmin: false, canOpenAiSettings: true }));
}

const RESULT: QuestionResult = {
  status: 'ok',
  kind: 'breakdown',
  metric: 'mitigated',
  breakdown: 'path',
  unit: 'count',
  range: { start: 1790380800, end: 1790985600, step: 10800, buckets: 56 },
  previous: null,
  total: 100,
  previousTotal: null,
  change: null,
  rows: [{ value: '/<script>alert(1)</script>', label: null, count: 60, share: 0.6, previous: null, change: null }],
  distinct: 1,
  series: null,
  peak: null,
  scope: null,
  notes: ['A note.'],
};

const ANSWER: QuestionAnswer = {
  status: 'answered',
  question: 'Which paths were blocked most?',
  message: null,
  query: { metric: 'mitigated', breakdown: 'path', filters: [], hostTags: [], range: { preset: '7d' }, comparison: 'none', limit: 10 },
  interpretation: 'Mitigated requests by path (top 10), 27 Sep–4 Oct 2026',
  analyticsHref: '/analytics?range=7d&metric=mitigated',
  result: RESULT,
  summary: { text: 'Most blocked requests went to one path.', source: 'ai' },
  summaryError: null,
  privacy: { provider: 'anthropic', model: 'claude-opus-5', interpretation: true, summary: true, requestDetails: false, description: 'Sent to Anthropic (claude-opus-5): your question.' },
  askedAt: '2026-10-04T10:00:00.000Z',
};

describe('Ask box', () => {
  it('asks when everything is set up', () => {
    const html = panel({});
    expect(html).toContain('Ask about your traffic');
    expect(html).toContain('aria-label="Your question"');
    expect(html).toContain('Which countries were blocked most in the last 7 days?');
    expect(html.match(/<input[^>]*aria-label="Your question"[^>]*>/)?.[0]).not.toContain('disabled=""');
  });

  it('explains why it is read-only', () => {
    expect(panel({ providerConfigured: false, provider: null })).toContain('No AI provider is set up.');
    expect(panel({ providerConfigured: false })).toContain('href="/settings/ai"');
    expect(panel({ enabled: false })).toContain('Questions are turned off.');
    expect(panel({ analyticsEnabled: false })).toContain('Traffic analytics is off.');
    expect(panel({ enabled: false })).toMatch(/aria-label="Your question"[^>]*disabled=""|disabled=""[^>]*aria-label="Your question"/);
  });
});

describe('answer', () => {
  it('shows the query in words, the link, the labelled summary, the result and what was sent', () => {
    const html = renderToStaticMarkup(createElement(AnswerView, { answer: ANSWER }));
    expect(html).toContain('Read as: </span>Mitigated requests by path (top 10), 27 Sep–4 Oct 2026');
    expect(html).toContain('href="/analytics?range=7d&amp;metric=mitigated"');
    expect(html).toContain('AI-generated summary: ');
    expect(html).toContain('Mitigated requests by path');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('A note.');
    expect(html).toContain('Sent to Anthropic (claude-opus-5)');
  });

  it('shows a figure with its change, a chart over time, and questions back', () => {
    const total = renderToStaticMarkup(
      createElement(AnswerView, {
        answer: {
          ...ANSWER,
          summary: { text: '1,000 requests.', source: 'computed' },
          result: { ...RESULT, kind: 'series', metric: 'requests', breakdown: 'time', rows: [], total: 1000, previousTotal: 500, change: 1, previous: { start: 0, end: 1, available: true }, series: { values: [400, 600], previous: [200, 300] } },
        },
      })
    );
    expect(total).toContain('Summary: ');
    expect(total).not.toContain('AI-generated summary');
    expect(total).toContain('1,000');
    expect(total).toContain('▲ 100%');
    expect(total).toContain('Requests over time');

    const clarify = renderToStaticMarkup(createElement(AnswerView, { answer: { ...ANSWER, status: 'clarify', message: 'For which hosts?', result: null } }));
    expect(clarify).toContain('Which do you mean?');
    expect(clarify).toContain('For which hosts?');
  });
});
