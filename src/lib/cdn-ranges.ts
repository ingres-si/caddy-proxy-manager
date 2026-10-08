/**
 * The address ranges of CDNs that sit in front of hosts, to tell when the
 * "client" of a request is really the CDN's edge server: Caddy then sees the
 * CDN's address unless the CDN is a trusted proxy (Host defaults → Trusted
 * proxies), and blocking that address would block every visitor the edge
 * server forwards. Cloudflare publishes its ranges at
 * https://www.cloudflare.com/ips/ (they rarely change).
 */
import { BlockList, isIP } from "node:net";

export const CLOUDFLARE_RANGES = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
] as const;

let cloudflare: BlockList | null = null;

function cloudflareList(): BlockList {
  if (cloudflare) return cloudflare;
  const list = new BlockList();
  for (const range of CLOUDFLARE_RANGES) {
    const [address, prefix] = range.split("/");
    list.addSubnet(address, Number(prefix), isIP(address) === 6 ? "ipv6" : "ipv4");
  }
  cloudflare = list;
  return list;
}

/** The CDN an address belongs to ("Cloudflare"), or null. */
export function cdnOfAddress(ip: string): string | null {
  const family = isIP(ip);
  if (family === 0) return null;
  return cloudflareList().check(ip, family === 6 ? "ipv6" : "ipv4") ? "Cloudflare" : null;
}

/** The addresses among `ips` that belong to a CDN, with its name. */
export function cdnAddresses(ips: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ip of ips) {
    const cdn = cdnOfAddress(ip);
    if (cdn) out[ip] = cdn;
  }
  return out;
}
