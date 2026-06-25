/**
 * Example of a *gated external* tool, hardened against SSRF.
 *
 * permission: 'ask' means the engine routes it through the approval policy
 * BEFORE the handler runs. On top of that, this handler refuses any URL that
 * resolves to a private, loopback, link-local, or cloud-metadata address — so
 * a prompt-injected agent can't use it to reach internal services. Use this
 * pattern for any tool that makes outbound requests.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Tool } from '../types.js';

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description: 'Fetch the textual content at a public URL via HTTP GET. Returns the first ~4000 characters.',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'A fully-qualified public http(s) URL.' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  async handler(args, _ctx) {
    const raw = String(args.url ?? '').trim();

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return 'Error: invalid URL.';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'Error: only http(s) URLs are allowed.';
    }

    // SSRF guard: resolve the host and reject non-public addresses.
    const blocked = await resolvesToBlockedAddress(url.hostname);
    if (blocked) return `Error: refusing to fetch a non-public address (${blocked}).`;

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        redirect: 'error', // don't follow redirects (they can re-target internal hosts)
      });
      const text = await res.text();
      return text.slice(0, 4000);
    } catch (err) {
      return `Fetch failed: ${(err as Error).message}`;
    }
  },
};

/** Returns the offending address string if the host is non-public, else null. */
async function resolvesToBlockedAddress(hostname: string): Promise<string | null> {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    return host;
  }

  // Resolve to IP(s) — covers DNS names that point at internal ranges.
  const ips: string[] = [];
  if (isIP(host)) {
    ips.push(host);
  } else {
    try {
      const records = await lookup(host, { all: true });
      ips.push(...records.map((r) => r.address));
    } catch {
      return host; // unresolvable — treat as blocked
    }
  }
  return ips.find(isPrivateAddress) ?? null;
}

/** Loopback, private, link-local (incl. 169.254.169.254 metadata), and v6 equivalents. */
function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v6 = ip.toLowerCase();
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — validate the embedded IPv4.
    if (v6.startsWith('::ffff:') && v6.includes('.')) {
      return isPrivateAddress(v6.slice('::ffff:'.length));
    }
    return (
      v6 === '::1' || // loopback
      v6.startsWith('fc') || // unique local fc00::/7
      v6.startsWith('fd') ||
      v6.startsWith('fe80') // link-local
    );
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) || // link-local + cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a >= 224 // multicast / reserved
  );
}
