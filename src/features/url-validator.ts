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

  // IPv6 loopback and link-local
  if (
    lowered === "::1" ||
    lowered.startsWith("fe80:") ||
    lowered.startsWith("fc") ||
    lowered.startsWith("fd")
  ) {
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
  _b: number,
  _c: number,
  _d: number,
  ra: number,
  _rb: number,
  _rc: number,
  mask: number,
): boolean {
  // Simple first-octet check for /8 networks; expand as needed.
  if (mask === 8) return a === ra;
  if (mask === 16) return a === ra && _b === _rb;
  if (mask === 12) return a === ra && (_b & 0xf0) === (_rb & 0xf0);
  if (mask === 10) return a === ra && (_b & 0xc0) === (_rb & 0xc0);
  return false;
}
