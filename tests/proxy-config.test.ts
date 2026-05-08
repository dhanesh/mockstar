// @constraint T8 — Config file Zod-validated
// @constraint RT-3 — SNI allowlist exclusive
// @constraint S2 — listenHost constrained to 127.0.0.1 in recommended path

import { describe, it, expect } from "bun:test";
import { parseConfig, ProxyConfigSchema } from "../src/features/proxy/config.ts";

describe("ProxyConfigSchema", () => {
  it("parses a minimal valid config with defaults", () => {
    const cfg = parseConfig({ hosts: [{ host: "api.razorpay.com", tenant: "razorpay" }] });
    expect(cfg.hosts).toHaveLength(1);
    expect(cfg.mockstarUrl).toBe("http://127.0.0.1:3000");
    expect(cfg.listenHost).toBe("127.0.0.1");
    expect(cfg.listenPort).toBe(443);
    expect(cfg.leafTtlHours).toBe(24);
    expect(cfg.dnsMode).toBe("dnsmasq");
  });

  it("rejects empty hosts list", () => {
    expect(() => parseConfig({ hosts: [] })).toThrow();
  });

  it("rejects invalid hostname", () => {
    expect(() => parseConfig({ hosts: [{ host: "not a host!!", tenant: "t" }] })).toThrow();
  });

  it("rejects invalid tenant name", () => {
    expect(() => parseConfig({ hosts: [{ host: "api.example.com", tenant: "bad tenant!" }] })).toThrow();
  });

  it("rejects unknown top-level fields (strict mode)", () => {
    expect(() =>
      parseConfig({
        hosts: [{ host: "api.example.com", tenant: "t" }],
        unknownField: true,
      } as unknown),
    ).toThrow();
  });

  it("caps leafTtlHours at 720 (30 days)", () => {
    expect(() =>
      parseConfig({
        hosts: [{ host: "api.example.com", tenant: "t" }],
        leafTtlHours: 1000,
      }),
    ).toThrow();
  });

  it("accepts hosts-fallback dnsMode", () => {
    const cfg = parseConfig({
      hosts: [{ host: "api.example.com", tenant: "t" }],
      dnsMode: "hosts-fallback",
    });
    expect(cfg.dnsMode).toBe("hosts-fallback");
  });
});
