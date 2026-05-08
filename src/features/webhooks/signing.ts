// Satisfies: S1 (HMAC-SHA256 signing, opt-in per webhook), S3 (secret-source guard)
// Satisfies: RT-2 (node:crypto HMAC + timing-safe compare in Bun)
// Satisfies: B3 (industry contract — Stripe/GitHub/Slack/Svix shape)

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Sign a webhook payload.
 *
 * The signed string is `${timestamp}.${rawBody}` (Stripe's pattern). Receivers
 * verify by reconstructing this string with the timestamp from the header,
 * computing HMAC-SHA256 with the shared secret, and comparing constant-time.
 *
 * Replay-window enforcement is the receiver's responsibility — but we emit the
 * timestamp so they CAN enforce it. Our default replay window in WebhookSigningSpec
 * is 300_000ms (5 minutes), matching industry default.
 */
export function signPayload(rawBody: string, secret: string, timestampMs: number): string {
  const stringToSign = `${timestampMs}.${rawBody}`;
  return createHmac("sha256", secret).update(stringToSign, "utf8").digest("hex");
}

/**
 * Verify a signature constant-time. Used by tests; receivers will implement
 * equivalent logic in their own language. Exposed so tests against this module
 * can verify what we sent matches what we documented (S1 + RT-2 evidence).
 *
 * Returns false on length mismatch or timing-safe-compare miss. Never throws.
 */
export function verifySignature(
  rawBody: string,
  secret: string,
  timestampMs: number,
  signatureHex: string,
): boolean {
  const expected = signPayload(rawBody, secret, timestampMs);
  // timingSafeEqual requires equal-length buffers — different lengths means immediate mismatch.
  if (expected.length !== signatureHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signatureHex, "hex"));
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
