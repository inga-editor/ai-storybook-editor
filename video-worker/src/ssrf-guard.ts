// video-worker/src/ssrf-guard.ts
// SSRF guard for bgm.url — the only external-URL surface this worker fetches.
// Ports the logic of ai-storybook-python-api/src/services/ssrf_guard.py::validate_public_url
// to Node (no npm deps — uses built-in `dns.promises.lookup`).
//
// Blocks:
//   - Non-http/https schemes
//   - Known bad hostnames (localhost, metadata.google.internal)
//   - IPs that resolve to loopback, private, link-local, multicast or reserved ranges

import dns from "node:dns/promises";

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
]);

/** CIDR ranges blocked by SSRF policy (IPv4 only — IPv6 loopback covered below). */
const BLOCKED_CIDRS: Array<{ base: number; mask: number; label: string }> = [
  // Loopback 127.0.0.0/8
  { base: ip4(127, 0, 0, 0), mask: 0xff000000, label: "loopback" },
  // RFC-1918 private: 10.0.0.0/8
  { base: ip4(10, 0, 0, 0), mask: 0xff000000, label: "private" },
  // RFC-1918 private: 172.16.0.0/12
  { base: ip4(172, 16, 0, 0), mask: 0xfff00000, label: "private" },
  // RFC-1918 private: 192.168.0.0/16
  { base: ip4(192, 168, 0, 0), mask: 0xffff0000, label: "private" },
  // Link-local / AWS/GCP metadata: 169.254.0.0/16
  { base: ip4(169, 254, 0, 0), mask: 0xffff0000, label: "link-local/metadata" },
  // Multicast: 224.0.0.0/4
  { base: ip4(224, 0, 0, 0), mask: 0xf0000000, label: "multicast" },
  // Reserved broadcast: 240.0.0.0/4
  { base: ip4(240, 0, 0, 0), mask: 0xf0000000, label: "reserved" },
];

function ip4(a: number, b: number, c: number, d: number): number {
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function parseIpv4(addr: string): number | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ip4(nums[0], nums[1], nums[2], nums[3]);
}

function isBlockedIpv4(addr: string): boolean {
  const n = parseIpv4(addr);
  if (n === null) return false;
  return BLOCKED_CIDRS.some((r) => (n & r.mask) >>> 0 === r.base);
}

function isBlockedIpv6(addr: string): boolean {
  // Block ::1 (loopback), fe80::/10 (link-local), fc00::/7 (unique-local),
  // :: (unspecified), and IPv4-mapped ::ffff:a.b.c.d (re-check embedded IPv4).
  const lower = addr.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true; // unspecified
  if (lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // IPv4-mapped: ::ffff:a.b.c.d — extract the embedded IPv4 and apply v4 deny list.
  const ipv4MappedMatch = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    ?? lower.match(/^0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4MappedMatch) {
    return isBlockedIpv4(ipv4MappedMatch[1]);
  }
  // Also handle hex-encoded IPv4-mapped form ::ffff:ac10:0001 etc.
  const hexMappedMatch = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMappedMatch) {
    const hi = parseInt(hexMappedMatch[1], 16);
    const lo = parseInt(hexMappedMatch[2], 16);
    const embedded = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isBlockedIpv4(embedded);
  }
  return false;
}

/** Thrown when the URL fails the SSRF check. Caller should degrade, not propagate to client. */
export class SsrfBlockedError extends Error {
  constructor(reason: string) {
    super(`SSRF_BLOCKED: ${reason}`);
    this.name = "SsrfBlockedError";
  }
}

/**
 * Validate that `url` resolves to a public IP. Returns the validated addresses on success.
 * Throws `SsrfBlockedError` on any violation.
 *
 * The returned addresses should be passed to the subsequent fetch to pin the connection
 * (DNS-rebinding defence). DNS resolution is performed for every call — no caching.
 */
export async function assertSsrfSafe(url: string): Promise<{ addresses: string[]; parsed: URL }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError(`unparseable URL: ${url}`);
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new SsrfBlockedError(`disallowed scheme: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    throw new SsrfBlockedError("missing hostname");
  }

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new SsrfBlockedError(`blocked hostname: ${hostname}`);
  }

  // Resolve all addresses and check each one.
  let addresses: string[];
  try {
    const results = await dns.lookup(hostname, { all: true });
    addresses = results.map((r) => r.address);
  } catch (err) {
    throw new SsrfBlockedError(`DNS resolution failed for ${hostname}: ${String(err)}`);
  }

  if (addresses.length === 0) {
    throw new SsrfBlockedError(`no addresses resolved for ${hostname}`);
  }

  for (const addr of addresses) {
    if (isBlockedIpv4(addr)) {
      throw new SsrfBlockedError(`${hostname} resolves to blocked IPv4: ${addr}`);
    }
    if (isBlockedIpv6(addr)) {
      throw new SsrfBlockedError(`${hostname} resolves to blocked IPv6: ${addr}`);
    }
  }

  return { addresses, parsed };
}
