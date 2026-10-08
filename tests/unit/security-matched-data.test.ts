/**
 * How the security event detail shows request data: control characters as
 * escapes, Coraza's "Matched Data" messages split into what matched where,
 * and the request log's runs of identical requests.
 */
import { describe, expect, it } from 'vitest';
import { splitMatchedData, visibleText } from '@/app/(dashboard)/security/security-view';
import { collapseRequestRuns } from '@/app/(dashboard)/analytics/present';

describe('visibleText', () => {
  it('shows control characters and undecodable bytes as escapes', () => {
    expect(visibleText('a\r\nb\u0000c�\u0085')).toBe('a\\r\\nb\\x00c\\ufffd\\x85');
    expect(visibleText('plain é ✓')).toBe('plain é ✓');
  });
});

describe('splitMatchedData', () => {
  it('keeps what matched exactly, even a bare CR/LF', () => {
    expect(splitMatchedData('Matched Data: \r\n found within ARGS_NAMES: id\r\n:x')).toEqual({ data: '\r\n', variable: 'ARGS_NAMES', value: 'id\r\n:x' });
    expect(splitMatchedData('Matched Data: /tmp/ found within ARGS:1: python3 -c')).toEqual({ data: '/tmp/', variable: 'ARGS:1', value: 'python3 -c' });
  });

  it('leaves other messages as they are', () => {
    expect(splitMatchedData('Inbound anomaly score exceeded')).toEqual({ data: 'Inbound anomaly score exceeded', variable: null, value: null });
  });
});

describe('collapseRequestRuns', () => {
  const row = (ts: number, patch: Record<string, unknown> = {}) => ({
    ts, outcome: 'served', method: 'GET', host: 'a.example.com', path: '/', status: 200, ip: '192.0.2.1', userAgent: 'curl', wafRuleId: 0, ...patch,
  });

  it('folds consecutive identical requests within a minute of each other', () => {
    const runs = collapseRequestRuns([row(100), row(99), row(60), row(50, { status: 500 }), row(49, { status: 500 }), row(-30, { status: 500 })]);
    expect(runs.map((run) => [run.row.ts, run.count, run.firstTs])).toEqual([
      [100, 3, 60],
      [50, 2, 49],
      [-30, 1, -30],
    ]);
  });

  it('keeps requests that differ in anything apart', () => {
    expect(collapseRequestRuns([row(3), row(2, { ip: '192.0.2.2' }), row(1)])).toHaveLength(3);
  });
});
