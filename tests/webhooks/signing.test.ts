// Validates: S1 (HMAC-SHA256 signing opt-in), S3 (secret-source guard), RT-2 (timing-safe HMAC)
// @constraint S1 - HMAC signing opt-in per webhook
// @constraint S3 - Secrets sourced from env or file:// only; inline rejected
// @constraint RT-2 - node:crypto HMAC works in Bun

import { describe, expect, test } from "bun:test";
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
