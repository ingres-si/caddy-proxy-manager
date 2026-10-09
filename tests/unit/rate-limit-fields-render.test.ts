/**
 * Server-side render of the rate limiting form sections: the hidden fields
 * the server actions read, and that a stored configuration round-trips
 * unchanged (an override with no rules stays an opt-out).
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RateLimitFields, RateLimitSettingsFields } from '@/src/components/proxy-hosts/RateLimitFields';
import { decodeEntities } from '../helpers/text';

function hiddenValue(html: string, name: string): string {
  const match = new RegExp(`<input type="hidden" name="${name}" value="([^"]*)"`).exec(html);
  if (!match) throw new Error(`no hidden input ${name}`);
  return decodeEntities(match[1]);
}

describe('RateLimitFields', () => {
  it('posts nothing for a host that inherits the defaults', () => {
    const html = renderToStaticMarkup(createElement(RateLimitFields, { value: null }));
    expect(hiddenValue(html, 'rateLimitPresent')).toBe('1');
    expect(hiddenValue(html, 'rateLimitJson')).toBe('');
    expect(html).toContain('Rate Limiting');
  });

  it('posts a stored configuration back unchanged', () => {
    const value = {
      enabled: true,
      mode: 'merge' as const,
      rules: [
        { path: '/login', methods: ['POST'], key: 'client_ip' as const, events: 5, window: '30s' },
        { path: '*', methods: [], key: 'header' as const, header: 'X-Api-Key', events: 100, window: '1h' },
      ],
    };
    const html = renderToStaticMarkup(createElement(RateLimitFields, { value }));
    expect(JSON.parse(hiddenValue(html, 'rateLimitJson'))).toEqual(value);
  });

  it('keeps an override with no rules as an opt-out', () => {
    const value = { enabled: true, mode: 'override' as const, rules: [] };
    const html = renderToStaticMarkup(createElement(RateLimitFields, { value }));
    expect(JSON.parse(hiddenValue(html, 'rateLimitJson'))).toEqual(value);
  });
});

describe('RateLimitSettingsFields', () => {
  it('posts the global defaults as JSON', () => {
    const value = {
      enabled: true,
      rules: [{ path: '/api/*', methods: [], key: 'forward_auth_user' as const, events: 60, window: '1m' }],
      allowlist: ['192.0.2.10', 'private_ranges'],
      ipv6Prefix: 56,
    };
    const html = renderToStaticMarkup(createElement(RateLimitSettingsFields, { value }));
    expect(JSON.parse(hiddenValue(html, 'rateLimitSettingsJson'))).toEqual(value);
  });

  it('starts disabled with the default IPv6 grouping', () => {
    const html = renderToStaticMarkup(createElement(RateLimitSettingsFields, { value: null }));
    expect(JSON.parse(hiddenValue(html, 'rateLimitSettingsJson'))).toEqual({ enabled: false, rules: [], allowlist: [], ipv6Prefix: 64 });
  });
});
