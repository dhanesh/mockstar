// Satisfies: S1 (HMAC signing, opt-in per webhook), B3 (industry contract — provider-shaped signatures)
//
// Pure placeholder engine for webhook signature schemes. Two independent axes:
//   - signedPayload     — the bytes fed to HMAC
//   - signatureTemplate — the header VALUE wrapped around the resulting digest
//
// Placeholders are SINGLE-brace (`{body}`) on purpose. Webhook url/body/headers are
// already rendered by the mockstar `{{ }}` template engine before signing; using the
// same delimiters here would make that engine try to resolve signing placeholders.

/** Digest encodings receivers actually use. Shopify signs base64; everyone else here is hex. */
export type DigestEncoding = "hex" | "base64";

/** The resolved, validated wire format for one webhook's signature. */
export interface SigningScheme {
  readonly signedPayload: string;
  readonly signatureTemplate: string;
  readonly digestEncoding: DigestEncoding;
  readonly algorithm: "sha256";
}

// Legacy default — Stripe's signed-payload construction. Unchanged from v0.2.x.
export const DEFAULT_SIGNED_PAYLOAD = "{timestamp}.{body}";
// Legacy default — GitHub's prefixed header value. Unchanged from v0.2.x.
export const DEFAULT_SIGNATURE_TEMPLATE = "{algorithm}={signature}";

export const SIGNED_PAYLOAD_PLACEHOLDERS = ["body", "timestamp", "timestampSeconds"] as const;
export const SIGNATURE_TEMPLATE_PLACEHOLDERS = [
  "signature",
  "algorithm",
  "timestamp",
  "timestampSeconds",
] as const;

const PLACEHOLDER_RE = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

// #30 finding 1: detection is deliberately WIDER than substitution. PLACEHOLDER_RE above only
// ever matches an exact, well-formed `{name}` token — that's correct for `substitute()`, which
// must leave anything it doesn't recognise untouched (see the substitute() doc comment). But it
// means a near-miss like "{ body }" (a stray space — the habit an author brings from mockstar's
// own spaced `{{ }}` template syntax) or a typo like "{time_stamp}" never matches PLACEHOLDER_RE
// either, so if detection reused it, the near-miss would be invisible to validation, parse
// cleanly, and get signed as literal text — silently producing a signature that authenticates
// nothing recognisable. So detection scans for ANY `{...}` span (no name-shape restriction) and
// flags whatever is inside unless it is an allowed name exactly. Do NOT collapse this back to
// PLACEHOLDER_RE — that reintroduces the exact bug this comment is warning about.
const UNKNOWN_PLACEHOLDER_SCAN_RE = /\{[^{}]*\}/g;

/** Names appearing in `template` that are not in `allowed`, de-duplicated, first-seen order. */
export function unknownPlaceholders(template: string, allowed: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of template.matchAll(UNKNOWN_PLACEHOLDER_SCAN_RE)) {
    const name = match[0].slice(1, -1);
    // #30 finding 2 (review round 2): an empty `{}` span decodes to the name "" — not a
    // placeholder at all, just an empty JSON object landing inside a JSON-envelope payload
    // (e.g. `{"meta":{},"b":{body}}`). Flagging "" as an unknown placeholder would reject that
    // legitimate shape, so a zero-length span is skipped rather than reported.
    if (name === "") continue;
    if (allowed.includes(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * #30 finding 3 (review round 2): after stripping every well-formed `{...}` span the scanner
 * matched, a leftover `{` immediately followed by an ASCII letter looks like a placeholder the
 * author meant to close but didn't — e.g. `"{timestamp.{body}"` has its trailing `{body}`
 * stripped, leaving residue `"{timestamp."`, whose leftover `{` precedes `t`. That signedPayload
 * signs the literal text `{timestamp.` plus the body and references no `{timestamp}` placeholder
 * `timestampUnitFor()` can see, so the timestamp header is silently dropped from the delivery.
 *
 * A JSON envelope's outer brace is NOT this shape: stripping `{"t":{timestamp},"b":{body}}`'s
 * two placeholder spans leaves residue `{"t":,"b":}`, whose leftover `{` precedes `"` — not a
 * letter — so it passes. Only a leftover `{` directly followed by a letter is flagged; `{"`,
 * `{}` (already consumed above), and a trailing `{` are all legitimate JSON-envelope shapes.
 */
export function hasUnbalancedPlaceholder(template: string): boolean {
  const residue = template.replace(UNKNOWN_PLACEHOLDER_SCAN_RE, "");
  return /\{[A-Za-z]/.test(residue);
}

/**
 * Single-pass substitution. The callback form is load-bearing twice over:
 *   1. one pass means a placeholder occurring INSIDE a substituted value (e.g. a request
 *      body that literally contains `{timestamp}`) is never rewritten — otherwise the
 *      receiver could not reproduce our signature;
 *   2. a function replacement never interprets `$&`, `$'` etc. in the inserted value.
 * Unknown placeholders are passed through untouched; config-load validation is where
 * they are rejected, so runtime degrades visibly rather than silently blanking bytes.
 */
function substitute(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER_RE, (match, name: string) =>
    Object.hasOwn(values, name) ? (values[name] as string) : match,
  );
}

export function renderSignedPayload(template: string, v: { body: string; timestampMs: number }): string {
  return substitute(template, {
    body: v.body,
    timestamp: String(v.timestampMs),
    timestampSeconds: String(Math.floor(v.timestampMs / 1000)),
  });
}

export function renderSignatureHeader(
  template: string,
  v: { signature: string; algorithm: string; timestampMs: number },
): string {
  return substitute(template, {
    signature: v.signature,
    algorithm: v.algorithm,
    timestamp: String(v.timestampMs),
    timestampSeconds: String(Math.floor(v.timestampMs / 1000)),
  });
}

/**
 * Which unit the standalone timestamp header should carry — or `null` when the scheme
 * never references a timestamp, in which case no timestamp header is emitted at all.
 * Emitting milliseconds beside a seconds-based signature is exactly the class of
 * mismatch this feature exists to eliminate, so the unit follows the scheme.
 */
export function timestampUnitFor(
  scheme: Pick<SigningScheme, "signedPayload" | "signatureTemplate">,
): "ms" | "s" | null {
  const combined = `${scheme.signedPayload} ${scheme.signatureTemplate}`;
  if (combined.includes("{timestamp}")) return "ms";
  if (combined.includes("{timestampSeconds}")) return "s";
  return null;
}
