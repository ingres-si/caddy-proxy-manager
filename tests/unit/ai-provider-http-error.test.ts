/**
 * The error a failed OpenAI-compatible call reports: a 403 from a provider
 * that this install proxies itself names the likely cause (its own WAF or
 * access rules) and the provider's own address to use instead.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/src/lib/models/proxy-hosts', () => ({
  listProxyHosts: async () => [{ id: 68, name: 'LiteLLM', domains: ['llm.example.com'], upstreams: ['http://192.168.6.17:4000'] }],
}));

import { providerHttpError } from '@/ee/ai/explain';

describe('providerHttpError', () => {
  it('points at this install’s WAF and the upstream when it proxies the provider', async () => {
    expect(await providerHttpError('https://llm.example.com/v1', 403)).toBe(
      'The provider answered with HTTP 403. llm.example.com is a proxy host of this install, so its WAF or access rules may have refused the prompt ' +
        "(see Security events). Set the provider's own address in AI settings, such as http://192.168.6.17:4000/v1, so the request does not pass through them."
    );
  });

  it('says only the status otherwise', async () => {
    expect(await providerHttpError('https://api.example.net/v1', 403)).toBe('The provider answered with HTTP 403');
    expect(await providerHttpError('https://llm.example.com/v1', 401)).toBe('The provider answered with HTTP 401');
    expect(await providerHttpError(null, 403)).toBe('The provider answered with HTTP 403');
  });
});
