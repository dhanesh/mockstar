// Satisfies: RT-8 (shared hardened URL validator used by pass-through and OpenAPI import)
// Satisfies: S6 (SSRF guard — scheme allowlist + private-range rejection)
// Addresses: mcp-from-openapi CVE-2026-39885 class of attacks

export interface UrlValidationOptions {
  /** Allowed schemes. Default: ['https']. */
  allowedSchemes?: readonly string[];
  /** Allow local/private network targets when explicitly opted in. Default: false. */
  allowPrivateUpstreams?: boolean;
}

/**
 * Resolve a hostname to its IP addresses (A + AAAA). Returns address strings.
 * Injectable so the DNS-resolution guard can be tested offline/deterministically.
 */
export type DnsLookup = (hostname: string) => Promise<string[]>;

export interface ResolvedValidationOptions extends UrlValidationOptions {
  /** Override DNS resolution (tests). Default: node:dns/promises lookup, A + AAAA. */
  lookup?: DnsLookup;
}

export class UrlValidationError extends Error {
  constructor(
    public readonly url: string,
    public readonly reason: string,
  ) {
    super(`URL validation failed for '${url}': ${reason}`);
    this.name = "UrlValidationError";
  }
}

const PRIVATE_IPV4_RANGES: Array<[number, number, number, number]> = [
  [10, 0, 0, 8], // 10.0.0.0/8
  [172, 16, 0, 12], // 172.16.0.0/12
  [192, 168, 0, 16], // 192.168.0.0/16
  [127, 0, 0, 8], // 127.0.0.0/8 (loopback)
  [169, 254, 0, 16], // 169.254.0.0/16 (link-local / cloud metadata)
  [100, 64, 0, 10], // 100.64.0.0/10 (CGNAT)
  [0, 0, 0, 8], // 0.0.0.0/8
  [192, 0, 0, 24], // 192.0.0.0/24 (IETF protocol assignments, incl. NAT64/DNS64 well-known prefix)
  [198, 18, 0, 15], // 198.18.0.0/15 (benchmarking)
  [224, 0, 0, 4], // 224.0.0.0/4 (multicast)
  [240, 0, 0, 4], // 240.0.0.0/4 (reserved/future use, incl. 255.255.255.255 broadcast)
];

/**
 * Validate an URL for use as a pass-through upstream or OpenAPI `servers.url`.
 * Enforces S6's scheme allowlist + private-range rejection by default.
 *
 * Throws `UrlValidationError` on failure. Returns the parsed URL on success.
 */
export function validateUpstreamUrl(raw: string, opts: UrlValidationOptions = {}): URL {
  const allowedSchemes = opts.allowedSchemes ?? ["https"];

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UrlValidationError(raw, "not a valid URL");
  }

  const scheme = parsed.protocol.replace(/:$/, "");
  if (!allowedSchemes.includes(scheme)) {
    throw new UrlValidationError(raw, `scheme '${scheme}' not in allowlist (${allowedSchemes.join(", ")})`);
  }

  // file:// is always rejected even if someone monkeys with the allowlist.
  if (scheme === "file") {
    throw new UrlValidationError(raw, "scheme 'file' is never allowed");
  }

  if (!opts.allowPrivateUpstreams) {
    if (isPrivateHost(parsed.hostname)) {
      throw new UrlValidationError(
        raw,
        `host '${parsed.hostname}' is in a private/loopback/link-local range`,
      );
    }
  }

  return parsed;
}

/** Default resolver: node:dns/promises lookup, both A and AAAA records. */
async function defaultLookup(hostname: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises");
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
}

/** Is this hostname a bare IP literal (already covered by the synchronous string guard)? */
function isIpLiteral(hostname: string): boolean {
  const stripped = hostname.replace(/^\[/, "").replace(/\]$/, "");
  return stripped.includes(":") || /^(\d{1,3}\.){3}\d{1,3}$/.test(stripped);
}

/**
 * Close the DNS-resolution SSRF gap (F1): a public hostname can have an A/AAAA
 * record pointing at a private/loopback/link-local/metadata IP, which the
 * synchronous string-level guard cannot see. Resolve the hostname and reject if
 * ANY resolved address is private. Fails closed on resolution errors.
 *
 * Note: resolution happens microseconds before the caller's fetch, so a narrow
 * DNS-rebinding (TOCTOU) window remains — the resolver here and the kernel
 * resolver used by fetch() are queried separately. For an OSS dev tool with
 * operator-authored upstreams this residual window is accepted; full closure
 * would require pinning the validated IP into the socket connect.
 */
export async function assertResolvedHostPublic(
  parsed: URL,
  opts: { allowPrivateUpstreams?: boolean; lookup?: DnsLookup } = {},
): Promise<void> {
  if (opts.allowPrivateUpstreams) return;

  const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  // IP literals were already validated by validateUpstreamUrl's isPrivateHost check;
  // resolving them would be a needless (and on some systems, failing) DNS round-trip.
  if (isIpLiteral(hostname)) return;

  const lookup = opts.lookup ?? defaultLookup;
  let addresses: string[];
  try {
    addresses = await lookup(hostname);
  } catch (err) {
    throw new UrlValidationError(
      parsed.href,
      `DNS resolution failed for '${hostname}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (addresses.length === 0) {
    throw new UrlValidationError(parsed.href, `DNS resolution returned no addresses for '${hostname}'`);
  }
  for (const addr of addresses) {
    if (isPrivateHost(addr)) {
      throw new UrlValidationError(
        parsed.href,
        `host '${hostname}' resolves to a private/loopback/link-local address '${addr}'`,
      );
    }
  }
}

/**
 * Full upstream validation for the request/delivery path: the synchronous
 * string-level checks (scheme allowlist + private IP-literal rejection) PLUS
 * DNS resolution of the hostname with private-range rejection of every resolved
 * address (F1). Use this at the point of fetch; use the synchronous
 * `validateUpstreamUrl` for config-load-time checks where DNS is undesirable.
 */
export async function validateUpstreamUrlResolved(
  raw: string,
  opts: ResolvedValidationOptions = {},
): Promise<URL> {
  const parsed = validateUpstreamUrl(raw, opts);
  await assertResolvedHostPublic(parsed, {
    allowPrivateUpstreams: opts.allowPrivateUpstreams,
    lookup: opts.lookup,
  });
  return parsed;
}

export function isPrivateHost(hostname: string): boolean {
  // Strip IPv6 brackets (some platforms keep them on URL.hostname for [::1] form).
  const stripped = hostname.replace(/^\[/, "").replace(/\]$/, "");
  const lowered = stripped.toLowerCase();
  if (lowered === "localhost" || lowered === "ip6-localhost" || lowered === "ip6-loopback") return true;

  // IPv6 loopback / unspecified / unique-local / link-local / NAT64. Gated behind
  // "this string is an IPv6 literal" (isIpLiteral) so a hostname that merely starts
  // with "fc"/"fd"/"fe80" (e.g. fcm.googleapis.com, fdn.example.com) is never treated
  // as an address — only reused notion of IP-literal-ness in this file.
  if (isIpLiteral(stripped) && isPrivateIpv6(lowered)) {
    return true;
  }

  // IPv4-mapped IPv6 in dotted form: ::ffff:a.b.c.d
  const ipv4MappedDotted = lowered.match(/^::ffff:([0-9.]+)$/);
  if (ipv4MappedDotted?.[1]) {
    return isPrivateIpv4(ipv4MappedDotted[1]);
  }
  // IPv4-mapped IPv6 in WHATWG-normalised hex form: ::ffff:HHHH:HHHH
  // e.g. `new URL('https://[::ffff:127.0.0.1]/').hostname` \u2192 "[::ffff:7f00:1]"
  const ipv4MappedHex = lowered.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (ipv4MappedHex?.[1] !== undefined && ipv4MappedHex[2] !== undefined) {
    const high = Number.parseInt(ipv4MappedHex[1], 16);
    const low = Number.parseInt(ipv4MappedHex[2], 16);
    if (!Number.isNaN(high) && !Number.isNaN(low)) {
      const octets = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
      return isPrivateIpv4(octets);
    }
  }

  // Plain IPv4
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(lowered)) {
    return isPrivateIpv4(lowered);
  }

  // Otherwise assume public hostname. DNS rebinding attacks are out of scope for
  // an OSS dev tool; document in SECURITY.md.
  return false;
}

/**
 * Expand a (possibly "::"-compressed, possibly IPv4-tailed) IPv6 address string
 * into its 8 16-bit groups. Returns null if the string isn't a parseable IPv6
 * address. This lets range checks (ULA, link-local, NAT64) test actual address
 * bits instead of string prefixes, which both over- and under-match.
 */
function expandIpv6(addr: string): number[] | null {
  const halves = addr.split("::");
  if (halves.length > 2) return null; // "::" may appear at most once

  const parseGroups = (segment: string): number[] | null => {
    if (segment === "") return [];
    const pieces = segment.split(":");
    const groups: number[] = [];
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i] ?? "";
      if (i === pieces.length - 1 && piece.includes(".")) {
        // Trailing embedded IPv4 (e.g. "64:ff9b::192.168.1.1" or "::ffff:127.0.0.1")
        const octets = piece.split(".").map((o) => Number.parseInt(o, 10));
        if (
          octets.length !== 4 ||
          octets.some((o) => Number.isNaN(o) || o < 0 || o > 255) ||
          piece.split(".").some((o) => !/^\d{1,3}$/.test(o))
        ) {
          return null;
        }
        const [a = 0, b = 0, c = 0, d = 0] = octets;
        groups.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (piece.length === 0 || piece.length > 4 || !/^[0-9a-f]+$/.test(piece)) return null;
      const value = Number.parseInt(piece, 16);
      if (Number.isNaN(value)) return null;
      groups.push(value);
    }
    return groups;
  };

  if (halves.length === 1) {
    const groups = parseGroups(halves[0] ?? "");
    return groups && groups.length === 8 ? groups : null;
  }

  const head = parseGroups(halves[0] ?? "");
  const tail = parseGroups(halves[1] ?? "");
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array(missing).fill(0), ...tail];
}

/** Does `groups` (8 x 16-bit) start with `prefixGroups`' top `prefixBits` bits? */
function ipv6PrefixMatch(groups: number[], prefixGroups: number[], prefixBits: number): boolean {
  let bitsLeft = prefixBits;
  for (let i = 0; i < prefixGroups.length && bitsLeft > 0; i++) {
    const bits = Math.min(16, bitsLeft);
    const mask = bits === 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
    if (((groups[i] ?? 0) & mask) !== ((prefixGroups[i] ?? 0) & mask)) return false;
    bitsLeft -= bits;
  }
  return true;
}

/**
 * Is `lowered` (already bracket-stripped, lowercased) a private/reserved IPv6
 * literal: unspecified (::), loopback (::1), unique-local (fc00::/7, RFC 4193),
 * link-local (fe80::/10), or NAT64 well-known prefix (64:ff9b::/96, RFC 6052)?
 * Bit-level range checks, not string prefixes — see #36.
 */
function isPrivateIpv6(lowered: string): boolean {
  const groups = expandIpv6(lowered);
  if (!groups) return false;

  if (groups.every((g) => g === 0)) return true; // :: — unspecified; reaches localhost on dual-stack
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1 — loopback
  if (ipv6PrefixMatch(groups, [0xfc00], 7)) return true; // fc00::/7 — unique-local
  if (ipv6PrefixMatch(groups, [0xfe80], 10)) return true; // fe80::/10 — link-local
  if (ipv6PrefixMatch(groups, [0x0064, 0xff9b, 0, 0, 0, 0], 96)) return true; // 64:ff9b::/96 — NAT64

  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a = 0, b = 0, c = 0, d = 0] = parts;
  for (const [ra, rb, rc, mask] of PRIVATE_IPV4_RANGES) {
    if (matchesIpv4(a, b, c, d, ra, rb, rc, mask)) return true;
  }
  return false;
}

function matchesIpv4(
  a: number,
  b: number,
  c: number,
  d: number,
  ra: number,
  rb: number,
  rc: number,
  mask: number,
): boolean {
  if (mask <= 0 || mask > 32) return false;
  // Full CIDR prefix match over the 32-bit address, not per-mask special cases —
  // supports arbitrary prefix lengths (/4, /7, /8, /10, /12, /15, /16, /24, ...).
  const value = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const rangeValue = ((ra << 24) | (rb << 16) | (rc << 8) | 0) >>> 0;
  const maskBits = mask === 32 ? 0xffffffff : (0xffffffff << (32 - mask)) >>> 0;
  return (value & maskBits) >>> 0 === (rangeValue & maskBits) >>> 0;
}
