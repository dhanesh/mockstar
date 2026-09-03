// Satisfies: S1 (HMAC-SHA256 signing, opt-in per webhook), S3 (secret-source guard)
// Satisfies: RT-2 (node:crypto HMAC + timing-safe compare in Bun)
// Satisfies: B3 (industry contract — Stripe/GitHub/Slack/Svix shape)

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  DEFAULT_SIGNATURE_TEMPLATE,
  DEFAULT_SIGNED_PAYLOAD,
  type SigningScheme,
  renderSignedPayload,
} from "./scheme.ts";

/**
 * The pre-#30 wire format: Stripe's signed payload, GitHub's header prefix, hex digest.
 * Used when a caller supplies no scheme, so library embedders calling signPayload/
 * verifySignature directly keep their v0.2.x behaviour.
 */
export const LEGACY_SCHEME: SigningScheme = Object.freeze({
  signedPayload: DEFAULT_SIGNED_PAYLOAD,
  signatureTemplate: DEFAULT_SIGNATURE_TEMPLATE,
  digestEncoding: "hex",
  algorithm: "sha256",
});

/**
 * Sign a webhook payload under `scheme`.
 *
 * The signed string is `scheme.signedPayload` with {body}/{timestamp}/{timestampSeconds}
 * substituted; the digest is encoded per `scheme.digestEncoding`. Receivers verify by
 * reconstructing the same string and comparing constant-time.
 *
 * Replay-window enforcement is the receiver's responsibility — but we emit the timestamp
 * (in the unit the scheme uses, see timestampUnitFor) so they CAN enforce it.
 */
export function signPayload(
  rawBody: string,
  secret: string,
  timestampMs: number,
  scheme: SigningScheme = LEGACY_SCHEME,
): string {
  const stringToSign = renderSignedPayload(scheme.signedPayload, { body: rawBody, timestampMs });
  return createHmac(scheme.algorithm, secret).update(stringToSign, "utf8").digest(scheme.digestEncoding);
}

/**
 * Verify a signature constant-time under the SAME scheme it was produced with. Used by
 * tests; receivers will implement equivalent logic in their own language. Exposed so tests
 * against this module can verify what we sent matches what we documented (S1 + RT-2 evidence).
 *
 * Returns false on length mismatch, encoding mismatch, or timing-safe-compare miss. Never throws.
 */
export function verifySignature(
  rawBody: string,
  secret: string,
  timestampMs: number,
  signature: string,
  scheme: SigningScheme = LEGACY_SCHEME,
): boolean {
  const expected = signPayload(rawBody, secret, timestampMs, scheme);
  // timingSafeEqual requires equal-length buffers — different lengths means immediate mismatch.
  if (expected.length !== signature.length) return false;
  try {
    const a = Buffer.from(expected, scheme.digestEncoding);
    const b = Buffer.from(signature, scheme.digestEncoding);
    // Buffer.from is lenient with malformed input and can shorten silently; re-check.
    if (a.length !== b.length || a.length === 0) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Replay-window check helper — returns false if `timestampMs` is outside `[now - windowMs, now + skewMs]`. */
export function withinReplayWindow(
  timestampMs: number,
  windowMs: number,
  nowMs: number = Date.now(),
  futureSkewMs = 60_000,
): boolean {
  const delta = nowMs - timestampMs;
  return delta <= windowMs && delta >= -futureSkewMs;
}

/**
 * Resolve a `secretRef` string to the actual secret material.
 *
 * Accepted forms (S3 — strict):
 *   - `{{ env.NAME }}` — read process.env.NAME at delivery time (not config-load)
 *   - `file:/absolute/path` — read file content (trimmed) at delivery time
 *
 * Inline strings are REJECTED at config validation time (Zod refine, see schema.ts).
 * This function should never see an inline string in practice; if it does, it
 * throws so the failure is loud rather than silently signing with the literal.
 */
export function resolveSecret(secretRef: string): string {
  const envMatch = secretRef.match(/^\{\{\s*env\.([A-Z_][A-Z0-9_]*)\s*\}\}$/);
  if (envMatch) {
    const name = envMatch[1];
    if (!name) throw new Error(`webhook signing: malformed env secret ref: ${secretRef}`);
    const val = process.env[name];
    if (!val) throw new Error(`webhook signing: env var '${name}' is unset; signing cannot proceed`);
    return val;
  }
  if (secretRef.startsWith("file:")) {
    // Synchronous file read at delivery time — the secret rarely changes; reading once
    // per delivery is acceptable and avoids stale-cache hazards.
    const path = secretRef.slice("file:".length);
    // biome-ignore lint/correctness/noNodejsModules: node:fs is intentional for secret-from-file pattern
    const { readFileSync } = require("node:fs");
    const content = (readFileSync(path, "utf8") as string).trim();
    if (!content) throw new Error(`webhook signing: secret file '${path}' is empty`);
    return content;
  }
  throw new Error(
    `webhook signing: secretRef must be '{{ env.NAME }}' or 'file:/path', got literal value (S3 violation)`,
  );
}
