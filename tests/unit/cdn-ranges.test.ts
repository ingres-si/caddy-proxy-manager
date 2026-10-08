/** Telling a CDN's edge server from a client: Cloudflare's published ranges. */
import { describe, expect, it } from 'vitest';
import { cdnAddresses, cdnOfAddress } from '@/src/lib/cdn-ranges';

describe('cdnOfAddress', () => {
  it("names Cloudflare's IPv4 and IPv6 addresses", () => {
    for (const ip of ['172.70.216.130', '172.69.68.128', '188.114.102.106', '104.16.0.1', '2606:4700::1111']) expect(cdnOfAddress(ip), ip).toBe('Cloudflare');
  });

  it('leaves other addresses and non-addresses alone', () => {
    for (const ip of ['203.0.113.7', '172.72.0.1', '2001:db8::1', 'not an address', '']) expect(cdnOfAddress(ip), ip).toBeNull();
  });

  it('lists the CDN addresses among some', () => {
    expect(cdnAddresses(['203.0.113.7', '172.70.216.130'])).toEqual({ '172.70.216.130': 'Cloudflare' });
  });
});
