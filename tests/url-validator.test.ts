// @constraint S6 — SSRF guard: scheme allowlist + private-range rejection
// @constraint RT-8.1 — validator rejects local, loopback, link-local, CGNAT
// @constraint RT-8.3 — external $ref handled by OpenAPI importer (separate test)

import { describe, expect, it } from "bun:test";
import { UrlValidationError, isPrivateHost, validateUpstreamUrl } from "../src/features/url-validator.ts";

describe("validateUpstreamUrl", () => {
  it("accepts https public URLs by default", () => {
    expect(() => validateUpstreamUrl("https://api.example.com/v1")).not.toThrow();
  });

  it("rejects http by default (scheme allowlist)", () => {
    expect(() => validateUpstreamUrl("http://api.example.com")).toThrow(UrlValidationError);
  });

  it("allows http when explicitly opted in", () => {
    expect(() =>
      validateUpstreamUrl("http://api.example.com", { allowedSchemes: ["https", "http"] }),
    ).not.toThrow();
  });

  it("always rejects file://", () => {
    expect(() => validateUpstreamUrl("file:///etc/passwd", { allowedSchemes: ["file"] })).toThrow(
      UrlValidationError,
    );
  });

  it("rejects private ranges by default (169.254.169.254 cloud metadata)", () => {
    expect(() => validateUpstreamUrl("https://169.254.169.254/latest/meta-data/")).toThrow(
      UrlValidationError,
    );
  });

  it("rejects localhost / loopback by default", () => {
    expect(() => validateUpstreamUrl("https://localhost/")).toThrow(UrlValidationError);
    expect(() => validateUpstreamUrl("https://127.0.0.1/")).toThrow(UrlValidationError);
  });

  it("rejects IPv4-mapped IPv6 loopback", () => {
    expect(() => validateUpstreamUrl("https://[::ffff:127.0.0.1]/")).toThrow(UrlValidationError);
  });

  it("allows private ranges when explicitly opted in", () => {
    expect(() =>
      validateUpstreamUrl("https://127.0.0.1:8080/", { allowPrivateUpstreams: true }),
    ).not.toThrow();
  });
});

describe("isPrivateHost", () => {
  it.each([
    ["localhost", true],
    ["127.0.0.1", true],
    ["10.0.0.5", true],
    ["192.168.1.1", true],
    ["172.16.0.1", true],
    ["169.254.169.254", true],
    ["100.64.0.1", true],
    ["::1", true],
    ["fe80::1", true],
    ["api.example.com", false],
    ["8.8.8.8", false],
  ])("isPrivateHost(%s) = %s", (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });
});
