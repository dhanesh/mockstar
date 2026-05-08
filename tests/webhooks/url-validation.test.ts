// Validates: T6 (HTTPS-only default), S2 (URL re-validation per attempt), TN4 (granular flags)
// @constraint T6 - HTTPS-only by default
// @constraint S2 - private/loopback blocked by default; opt-in flags relax independently

import { describe, expect, test } from "bun:test";
import { isPrivateHost, validateUpstreamUrl } from "../../src/features/url-validator.ts";

describe("webhook URL validation reuses validateUpstreamUrl (RT-5, T6, S2, TN4)", () => {
  test("default config rejects http:// (HTTPS-only)", () => {
    expect(() => validateUpstreamUrl("http://example.com/hook")).toThrow(/scheme/);
  });

  test("default config accepts https:// public host", () => {
    expect(() => validateUpstreamUrl("https://api.example.com/hook")).not.toThrow();
  });

  test("default config rejects https://127.0.0.1 (private/loopback)", () => {
    expect(() => validateUpstreamUrl("https://127.0.0.1:9000/hook")).toThrow(/private/);
  });

  test("default config rejects link-local 169.254.x.x (cloud metadata)", () => {
    expect(() => validateUpstreamUrl("https://169.254.169.254/latest/meta-data")).toThrow(/private/);
  });

  test("default config rejects RFC1918 10.x", () => {
    expect(() => validateUpstreamUrl("https://10.0.0.1/hook")).toThrow(/private/);
  });

  test('allowedSchemes:["http","https"] permits http:// (allowHttp)', () => {
    expect(() =>
      validateUpstreamUrl("http://api.example.com/hook", { allowedSchemes: ["http", "https"] }),
    ).not.toThrow();
  });

  test("allowPrivateUpstreams:true permits localhost — SDET path (B4)", () => {
    expect(() =>
      validateUpstreamUrl("https://127.0.0.1:9000/hook", { allowPrivateUpstreams: true }),
    ).not.toThrow();
  });

  test("flags are independent — allowHttp:true alone does NOT permit private (TN4)", () => {
    expect(() => validateUpstreamUrl("http://10.0.0.1/hook", { allowedSchemes: ["http", "https"] })).toThrow(
      /private/,
    );
  });

  test("SDET full opt-in: both flags permit http://localhost", () => {
    expect(() =>
      validateUpstreamUrl("http://localhost:9000/hook", {
        allowedSchemes: ["http", "https"],
        allowPrivateUpstreams: true,
      }),
    ).not.toThrow();
  });

  test("file:// always rejected even if allowlist tries to permit it", () => {
    expect(() => validateUpstreamUrl("file:///etc/passwd", { allowedSchemes: ["file"] })).toThrow(/file/);
  });

  test("IPv4-mapped-IPv6 loopback rejected (covers ::ffff:127.0.0.1 form)", () => {
    expect(isPrivateHost("::ffff:127.0.0.1")).toBe(true);
  });
});
