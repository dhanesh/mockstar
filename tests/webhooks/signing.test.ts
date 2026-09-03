// Validates: S1 (HMAC-SHA256 signing opt-in), S3 (secret-source guard), RT-2 (timing-safe HMAC)
// @constraint S1 - HMAC signing opt-in per webhook
// @constraint S3 - Secrets sourced from env or file:// only; inline rejected
// @constraint RT-2 - node:crypto HMAC works in Bun

import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  DEFAULT_SIGNATURE_TEMPLATE,
  DEFAULT_SIGNED_PAYLOAD,
  type SigningScheme,
} from "../../src/features/webhooks/scheme.ts";
import {
  resolveSecret,
  signPayload,
  verifySignature,
  withinReplayWindow,
} from "../../src/features/webhooks/signing.ts";

describe("signing — HMAC-SHA256 (S1, RT-2)", () => {
  test("signature is deterministic for fixed inputs", () => {
    const sig1 = signPayload('{"x":1}', "secret-A", 1700000000000);
    const sig2 = signPayload('{"x":1}', "secret-A", 1700000000000);
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^[0-9a-f]{64}$/); // sha256 -> 64 hex chars
  });

  test("different secrets produce different signatures", () => {
    const sig1 = signPayload('{"x":1}', "secret-A", 1700000000000);
    const sig2 = signPayload('{"x":1}', "secret-B", 1700000000000);
    expect(sig1).not.toBe(sig2);
  });

  test("different timestamps produce different signatures (replay-resistance)", () => {
    const sig1 = signPayload('{"x":1}', "secret", 1700000000000);
    const sig2 = signPayload('{"x":1}', "secret", 1700000060000);
    expect(sig1).not.toBe(sig2);
  });

  test("verifySignature accepts the signature signPayload produced", () => {
    const ts = 1700000000000;
    const sig = signPayload('{"x":1}', "secret", ts);
    expect(verifySignature('{"x":1}', "secret", ts, sig)).toBe(true);
  });

  test("verifySignature rejects modified body (constant-time path)", () => {
    const ts = 1700000000000;
    const sig = signPayload('{"x":1}', "secret", ts);
    expect(verifySignature('{"x":2}', "secret", ts, sig)).toBe(false);
  });

  test("verifySignature rejects mismatched-length input without throwing", () => {
    expect(verifySignature('{"x":1}', "secret", 1, "short")).toBe(false);
    expect(verifySignature('{"x":1}', "secret", 1, "")).toBe(false);
  });

  test("verifySignature handles malformed hex gracefully", () => {
    // 'zz' would throw inside Buffer.from('hex') if we didn't catch
    expect(verifySignature("{}", "secret", 1, "z".repeat(64))).toBe(false);
  });
});

describe("replay window", () => {
  test("within window returns true", () => {
    const now = 1700000000000;
    expect(withinReplayWindow(now - 100, 1000, now)).toBe(true);
  });
  test("past window returns false", () => {
    const now = 1700000000000;
    expect(withinReplayWindow(now - 10_000, 1000, now)).toBe(false);
  });
  test("rejects far-future timestamps beyond skew (default 60s)", () => {
    const now = 1700000000000;
    expect(withinReplayWindow(now + 5 * 60_000, 1_000, now)).toBe(false);
  });
});

describe("resolveSecret — S3 secret-source guard", () => {
  test("resolves env-namespace ref at call time", () => {
    process.env.MOCKSTAR_TEST_SECRET = "super-secret";
    expect(resolveSecret("{{ env.MOCKSTAR_TEST_SECRET }}")).toBe("super-secret");
    delete process.env.MOCKSTAR_TEST_SECRET;
  });

  test("throws on unset env ref (loud failure beats silent empty-secret signing)", () => {
    delete process.env.MOCKSTAR_UNSET_SECRET;
    expect(() => resolveSecret("{{ env.MOCKSTAR_UNSET_SECRET }}")).toThrow(/env var.*unset/);
  });

  test("rejects literal string (S3 violation)", () => {
    expect(() => resolveSecret("inline-secret-foo")).toThrow(/secretRef must be/);
  });

  test("rejects malformed env ref shape", () => {
    expect(() => resolveSecret("{{ env.lowercase }}")).toThrow(/secretRef must be/);
  });
});

describe("scheme-aware signing (#30)", () => {
  const TS = 1_700_000_000_500;

  const scheme = (over: Partial<SigningScheme> = {}): SigningScheme => ({
    signedPayload: DEFAULT_SIGNED_PAYLOAD,
    signatureTemplate: DEFAULT_SIGNATURE_TEMPLATE,
    digestEncoding: "hex",
    algorithm: "sha256",
    ...over,
  });

  test("omitting the scheme reproduces the pre-#30 signature exactly", () => {
    const legacy = createHmac("sha256", "s").update(`${TS}.{"x":1}`, "utf8").digest("hex");
    expect(signPayload('{"x":1}', "s", TS)).toBe(legacy);
  });

  test("{body} signs the raw body — matches a GitHub-style verifier", () => {
    const expected = createHmac("sha256", "s").update('{"x":1}', "utf8").digest("hex");
    expect(signPayload('{"x":1}', "s", TS, scheme({ signedPayload: "{body}" }))).toBe(expected);
  });

  test("Slack's v0 construction is reproducible", () => {
    const expected = createHmac("sha256", "s").update('v0:1700000000:{"x":1}', "utf8").digest("hex");
    expect(signPayload('{"x":1}', "s", TS, scheme({ signedPayload: "v0:{timestampSeconds}:{body}" }))).toBe(
      expected,
    );
  });

  test("base64 encoding matches a Shopify-style verifier", () => {
    const expected = createHmac("sha256", "s").update('{"x":1}', "utf8").digest("base64");
    expect(
      signPayload('{"x":1}', "s", TS, scheme({ signedPayload: "{body}", digestEncoding: "base64" })),
    ).toBe(expected);
  });

  test("verifySignature round-trips under a non-default scheme", () => {
    const s = scheme({ signedPayload: "{body}", digestEncoding: "base64" });
    const sig = signPayload('{"x":1}', "s", TS, s);
    expect(verifySignature('{"x":1}', "s", TS, sig, s)).toBe(true);
    expect(verifySignature('{"x":2}', "s", TS, sig, s)).toBe(false);
  });

  test("verifySignature rejects a signature produced under a DIFFERENT scheme", () => {
    // This is bug #30 in miniature: right secret, right body, wrong construction.
    const sig = signPayload('{"x":1}', "s", TS, scheme({ signedPayload: "{body}" }));
    expect(verifySignature('{"x":1}', "s", TS, sig, scheme())).toBe(false);
  });

  test("verifySignature handles malformed base64 without throwing", () => {
    expect(verifySignature("{}", "s", TS, "!!!!", scheme({ digestEncoding: "base64" }))).toBe(false);
  });
});
