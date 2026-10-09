/**
 * The error a failed OpenAI-compatible call reports: the status, and for a
 * 403 the usual cause, without anything about this install's configuration.
 */
import { describe, expect, it } from 'vitest';
import { providerHttpError } from '@/ee/ai/explain';

describe('providerHttpError', () => {
  it('names a firewall as the usual cause of a 403', () => {
    expect(providerHttpError(403)).toBe('The provider answered with HTTP 403. If a web application firewall protects the provider, it may have refused the prompt.');
  });

  it('says only the status otherwise', () => {
    expect(providerHttpError(401)).toBe('The provider answered with HTTP 401');
    expect(providerHttpError(500)).toBe('The provider answered with HTTP 500');
  });
});
