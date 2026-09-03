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

/** Legacy default — Stripe's signed-payload construction. Unchanged from v0.2.x. */
export const DEFAULT_SIGNED_PAYLOAD = "{timestamp}.{body}";
/** Legacy default — GitHub's prefixed header value. Unchanged from v0.2.x. */
export const DEFAULT_SIGNATURE_TEMPLATE = "{algorithm}={signature}";

export const SIGNED_PAYLOAD_PLACEHOLDERS = ["body", "timestamp", "timestampSeconds"] as const;
export const SIGNATURE_TEMPLATE_PLACEHOLDERS = [
  "signature",
  "algorithm",
  "timestamp",
  "timestampSeconds",
] as const;

const PLACEHOLDER_RE = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/** Names appearing in `template` that are not in `allowed`, de-duplicated, first-seen order. */
export function unknownPlaceholders(template: string, allowed: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const name = match[1];
    if (!name || allowed.includes(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
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
