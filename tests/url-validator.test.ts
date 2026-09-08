// @constraint S6 — SSRF guard: scheme allowlist + private-range rejection
// @constraint RT-8.1 — validator rejects local, loopback, link-local, CGNAT
// @constraint RT-8.3 — external $ref handled by OpenAPI importer (separate test)

import { describe, expect, it } from "bun:test";
import {
  UrlValidationError,
  isPrivateHost,
  validateUpstreamUrl,
  validateUpstreamUrlResolved,
} from "../src/features/url-validator.ts";

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

describe("validateUpstreamUrlResolved (S6 — DNS-resolution SSRF guard, F1)", () => {
  // Inject a fake resolver so tests are deterministic and offline.
  const resolvesTo = (...addrs: string[]) => ({
    lookup: async () => addrs,
  });

  it("accepts a public hostname that resolves to a public IP", async () => {
    await expect(
      validateUpstreamUrlResolved("https://api.example.com/v1", resolvesTo("93.184.216.34")),
    ).resolves.toBeInstanceOf(URL);
  });

  it("rejects a public hostname that resolves to cloud-metadata 169.254.169.254 (the F1 bypass)", async () => {
    await expect(
      validateUpstreamUrlResolved("https://evil.example.com/", resolvesTo("169.254.169.254")),
    ).rejects.toThrow(UrlValidationError);
  });

  it("rejects a public hostname that resolves to loopback 127.0.0.1", async () => {
    await expect(
      validateUpstreamUrlResolved("https://rebind.example.com/", resolvesTo("127.0.0.1")),
    ).rejects.toThrow(/private|loopback/);
  });

  it("rejects when ANY resolved address is private (multi-record A/AAAA)", async () => {
    await expect(
      validateUpstreamUrlResolved("https://mixed.example.com/", resolvesTo("8.8.8.8", "10.0.0.5")),
    ).rejects.toThrow(UrlValidationError);
  });

  it("rejects an IPv6 private resolution (ULA fd00::)", async () => {
    await expect(
      validateUpstreamUrlResolved("https://v6.example.com/", resolvesTo("fd00::1")),
    ).rejects.toThrow(UrlValidationError);
  });

  it("fails closed when DNS resolution throws", async () => {
    await expect(
      validateUpstreamUrlResolved("https://nxdomain.example.com/", {
        lookup: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toThrow(UrlValidationError);
  });

  it("fails closed when DNS returns no addresses", async () => {
    await expect(validateUpstreamUrlResolved("https://empty.example.com/", resolvesTo())).rejects.toThrow(
      UrlValidationError,
    );
  });

  it("skips DNS resolution when allowPrivateUpstreams is opted in", async () => {
    let called = false;
    await expect(
      validateUpstreamUrlResolved("https://anything.example.com/", {
        allowPrivateUpstreams: true,
        lookup: async () => {
          called = true;
          return ["10.0.0.1"];
        },
      }),
    ).resolves.toBeInstanceOf(URL);
    expect(called).toBe(false);
  });

  it("does not perform a DNS lookup for IP-literal hosts (already checked by the string guard)", async () => {
    let called = false;
    await validateUpstreamUrlResolved("https://93.184.216.34/", {
      lookup: async () => {
        called = true;
        return ["93.184.216.34"];
      },
    });
    expect(called).toBe(false);
  });

  it("still enforces the string-level guard (scheme/IP-literal) before resolving", async () => {
    // http rejected by scheme allowlist before any DNS work
    await expect(
      validateUpstreamUrlResolved("http://api.example.com/", resolvesTo("8.8.8.8")),
    ).rejects.toThrow(/scheme/);
    // private IP literal rejected by the synchronous guard
    await expect(validateUpstreamUrlResolved("https://127.0.0.1/", resolvesTo("8.8.8.8"))).rejects.toThrow(
      /private/,
    );
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

  // #36 — regression coverage in both directions: the ULA (fc00::/7) and
  // link-local (fe80::/10) checks must apply only to genuine IPv6 literals
  // (not hostnames that merely start with "fc"/"fd"/"fe80"), and the
  // unspecified address ("::" and its expanded/embedded-IPv4 forms) must be
  // rejected as a loopback-guard bypass.
  describe("#36 regression: over/under-blocking table", () => {
    it.each([
      // --- must be ALLOWED (ordinary public hostnames, not IP literals) ---
      ["fcm.googleapis.com", false],
      ["fdn.example.com", false],
      ["api.stripe.com", false],
      ["hooks.slack.com", false],
      ["2001:4860:4860::8888", false], // plain public IPv6 literal (Google DNS)
      // --- must be REJECTED ---
      ["::", true], // unspecified address — dual-stack loopback bypass
      ["::0.0.0.0", true], // unspecified, IPv4-embedded form
      ["::1", true], // loopback
      ["127.0.0.1", true], // loopback (IPv4)
      ["169.254.169.254", true], // link-local / cloud metadata (IPv4)
      ["10.0.0.1", true], // private (IPv4)
      ["192.168.1.1", true], // private (IPv4)
      ["fc00::1", true], // genuine ULA literal
      ["fd00::1", true], // genuine ULA literal
      ["feb0::1", true], // fe80::/10, but NOT "fe80:"-prefixed
    ])("isPrivateHost(%s) = %s", (host, expected) => {
      expect(isPrivateHost(host)).toBe(expected);
    });
  });
});
