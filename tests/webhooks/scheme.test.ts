// Validates: S1 (signing opt-in), B3 (industry contract — provider-shaped signatures)
// @constraint S1 - signature wire format is configuration, not code
// @constraint B3 - emitted bytes match a named provider's documented scheme

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SIGNATURE_TEMPLATE,
  DEFAULT_SIGNED_PAYLOAD,
  SIGNATURE_TEMPLATE_PLACEHOLDERS,
  SIGNED_PAYLOAD_PLACEHOLDERS,
  hasUnbalancedPlaceholder,
  renderSignatureHeader,
  renderSignedPayload,
  timestampUnitFor,
  unknownPlaceholders,
} from "../../src/features/webhooks/scheme.ts";

const TS = 1_700_000_000_500; // ms; 1700000000 seconds

describe("renderSignedPayload", () => {
  test("default template reproduces the legacy Stripe-style string", () => {
    expect(renderSignedPayload(DEFAULT_SIGNED_PAYLOAD, { body: '{"x":1}', timestampMs: TS })).toBe(
      '1700000000500.{"x":1}',
    );
  });

  test("{body} alone signs the raw body (GitHub / Shopify / Razorpay shape)", () => {
    expect(renderSignedPayload("{body}", { body: '{"x":1}', timestampMs: TS })).toBe('{"x":1}');
  });

  test("{timestampSeconds} truncates milliseconds (Slack / Stripe shape)", () => {
    expect(renderSignedPayload("v0:{timestampSeconds}:{body}", { body: "b", timestampMs: TS })).toBe(
      "v0:1700000000:b",
    );
  });

  test("substitution is single-pass — a placeholder INSIDE the body is not re-substituted", () => {
    // Regression guard: a naive .replace() chain would rewrite the body's own text
    // and produce a signature the receiver can never reproduce.
    expect(renderSignedPayload("{timestamp}.{body}", { body: "{timestamp}", timestampMs: TS })).toBe(
      "1700000000500.{timestamp}",
    );
  });

  test("a body containing $& is inserted literally (no regex replacement-pattern expansion)", () => {
    expect(renderSignedPayload("{body}", { body: "a$&b$'c", timestampMs: TS })).toBe("a$&b$'c");
  });

  test("an unknown placeholder is left untouched rather than blanked", () => {
    expect(renderSignedPayload("{nope}-{body}", { body: "b", timestampMs: TS })).toBe("{nope}-b");
  });
});

describe("renderSignatureHeader", () => {
  test("default template reproduces the legacy prefixed value", () => {
    expect(
      renderSignatureHeader(DEFAULT_SIGNATURE_TEMPLATE, {
        signature: "abc",
        algorithm: "sha256",
        timestampMs: TS,
      }),
    ).toBe("sha256=abc");
  });

  test("bare {signature} emits an unprefixed digest (Razorpay / Shopify shape)", () => {
    expect(
      renderSignatureHeader("{signature}", { signature: "abc", algorithm: "sha256", timestampMs: TS }),
    ).toBe("abc");
  });

  test("Stripe's comma-separated header is expressible", () => {
    expect(
      renderSignatureHeader("t={timestampSeconds},v1={signature}", {
        signature: "abc",
        algorithm: "sha256",
        timestampMs: TS,
      }),
    ).toBe("t=1700000000,v1=abc");
  });
});

describe("unknownPlaceholders", () => {
  test("returns [] when every placeholder is allowed", () => {
    expect(unknownPlaceholders("{timestamp}.{body}", SIGNED_PAYLOAD_PLACEHOLDERS)).toEqual([]);
  });

  test("names each unknown placeholder once, in order", () => {
    expect(unknownPlaceholders("{nonce}-{body}-{nonce}-{secret}", SIGNED_PAYLOAD_PLACEHOLDERS)).toEqual([
      "nonce",
      "secret",
    ]);
  });

  test("{signature} is not valid in a signed payload (would be circular)", () => {
    expect(unknownPlaceholders("{signature}", SIGNED_PAYLOAD_PLACEHOLDERS)).toEqual(["signature"]);
  });

  test("{body} is not valid in a signature header template", () => {
    expect(unknownPlaceholders("{body}", SIGNATURE_TEMPLATE_PLACEHOLDERS)).toEqual(["body"]);
  });

  test("returns [] when every placeholder is allowed (SIGNATURE_TEMPLATE_PLACEHOLDERS)", () => {
    expect(
      unknownPlaceholders("t={timestampSeconds},v1={signature}", SIGNATURE_TEMPLATE_PLACEHOLDERS),
    ).toEqual([]);
  });

  // Review round 2, item 6: the case above passes identically under the OLD narrow
  // implementation (PLACEHOLDER_RE-shaped scanning), so it doesn't actually exercise the wider
  // `/\{[^{}]*\}/g` scan documented on UNKNOWN_PLACEHOLDER_SCAN_RE. These two do: a JSON-envelope
  // payload only parses correctly under the wide scan (each `{...}` span is found independently,
  // not gated on the whole string looking like a single placeholder), and a spaced near-miss is
  // only caught because the wide scan sees " body " as a span at all.
  test("wide scan: a JSON-envelope signedPayload with independent {timestamp}/{body} spans returns []", () => {
    expect(unknownPlaceholders('{"t":{timestamp},"b":{body}}', SIGNED_PAYLOAD_PLACEHOLDERS)).toEqual([]);
  });

  test("wide scan: a spaced near-miss '{ body }' is caught as an unknown placeholder", () => {
    expect(unknownPlaceholders("{ body }", SIGNED_PAYLOAD_PLACEHOLDERS)).toEqual([" body "]);
  });

  // Review round 2, item 2: an empty `{}` span (e.g. inside a JSON-envelope payload like
  // `{"meta":{},"b":{body}}`) decodes to the name "" and must not be reported as unknown.
  test("a zero-length {} span is skipped, not reported as an unknown placeholder named ''", () => {
    expect(unknownPlaceholders('{"meta":{},"b":{body}}', SIGNED_PAYLOAD_PLACEHOLDERS)).toEqual([]);
  });
});

describe("hasUnbalancedPlaceholder", () => {
  test("a leftover { followed by a letter is flagged as an unterminated placeholder", () => {
    // Review round 2, item 3: stripping the one well-formed span ({body}) leaves residue
    // "{timestamp." — a leftover { immediately before the letter 't'.
    expect(hasUnbalancedPlaceholder("{timestamp.{body}")).toBe(true);
  });

  test("a JSON envelope's outer { (leftover { before a quote) is NOT flagged", () => {
    // Stripping {timestamp} and {body} leaves residue '{"t":,"b":}' — leftover { before '"'.
    expect(hasUnbalancedPlaceholder('{"t":{timestamp},"b":{body}}')).toBe(false);
  });

  test("a JSON envelope with an empty {} object is NOT flagged", () => {
    expect(hasUnbalancedPlaceholder('{"meta":{},"b":{body}}')).toBe(false);
  });

  test("a well-formed template with no leftover brace is NOT flagged", () => {
    expect(hasUnbalancedPlaceholder("{timestamp}.{body}")).toBe(false);
  });

  test("a { at the very end of the string is NOT flagged (no letter follows)", () => {
    expect(hasUnbalancedPlaceholder("{body}{")).toBe(false);
  });
});

describe("timestampUnitFor", () => {
  test("defaults imply a millisecond timestamp header", () => {
    expect(
      timestampUnitFor({
        signedPayload: DEFAULT_SIGNED_PAYLOAD,
        signatureTemplate: DEFAULT_SIGNATURE_TEMPLATE,
      }),
    ).toBe("ms");
  });

  test("a seconds-only scheme implies a seconds timestamp header", () => {
    expect(
      timestampUnitFor({
        signedPayload: "v0:{timestampSeconds}:{body}",
        signatureTemplate: "v0={signature}",
      }),
    ).toBe("s");
  });

  test("a scheme that never references a timestamp implies no header at all", () => {
    expect(timestampUnitFor({ signedPayload: "{body}", signatureTemplate: "{algorithm}={signature}" })).toBe(
      null,
    );
  });

  test("milliseconds win when both units appear", () => {
    expect(
      timestampUnitFor({
        signedPayload: "{timestamp}.{body}",
        signatureTemplate: "t={timestampSeconds},v1={signature}",
      }),
    ).toBe("ms");
  });
});
