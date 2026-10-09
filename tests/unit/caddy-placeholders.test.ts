import { describe, expect, it } from 'vitest';
import { stripPlaceholders } from '@/src/lib/caddy-placeholders';

describe('stripPlaceholders', () => {
  it.each([
    ['/api/{http.request.uri}/*', '/api//*'],
    ['{http.request.host}', ''],
    ['/plain/path', '/plain/path'],
    ['/open{brace', '/open{brace'],
    ['close}brace', 'close}brace'],
    ['{{nested}}', '}'],
    ['a{b}c{d}e', 'ace'],
    ['', ''],
  ])('%j becomes %j', (value, expected) => {
    expect(stripPlaceholders(value)).toBe(expected);
  });

  it('agrees with the regular expression it replaces', () => {
    const alphabet = ['{', '}', 'a', '/'];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let round = 0; round < 2000; round++) {
      const value = Array.from({ length: next() % 24 }, () => alphabet[next() % alphabet.length]).join('');
      expect(stripPlaceholders(value)).toBe(value.replace(/\{[^}]*\}/g, ''));
    }
  });

  it('is linear on a long run of opening braces', () => {
    const value = '{'.repeat(200_000);
    const started = performance.now();
    expect(stripPlaceholders(value)).toBe(value);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
