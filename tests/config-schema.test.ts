// @constraint T7 — Zod-validated config with fail-fast boot
// @constraint G8 — config schema test coverage

import { describe, expect, it } from "bun:test";
import { MatchPredicate, MockEntry, ServerConfig, TenantConfig } from "../src/core/config/schema.ts";

describe("MockEntry schema (T7)", () => {
  it("accepts a minimal valid static entry", () => {
    const parsed = MockEntry.parse({
      id: "e1",
      match: { method: "GET", path: "/users" },
      response: { kind: "static", status: 200, body: "ok" },
    });
    expect(parsed.id).toBe("e1");
    expect(parsed.match.priority).toBe(0); // default applied
  });

  it("rejects an entry with missing id", () => {
    expect(() =>
      MockEntry.parse({
        match: { method: "GET", path: "/users" },
        response: { kind: "static" },
      }),
    ).toThrow();
  });

  it("rejects a passthrough with invalid upstream URL", () => {
    expect(() =>
      MockEntry.parse({
        id: "bad",
        match: { method: "GET", path: "/foo" },
        response: { kind: "passthrough", upstream: "not-a-url" },
      }),
    ).toThrow();
  });

  it("rejects an unknown response kind", () => {
    expect(() =>
      MockEntry.parse({
        id: "bad",
        match: { method: "GET", path: "/foo" },
        response: { kind: "something-else", status: 200 },
      }),
    ).toThrow();
  });

  it("rejects an entry with extra unknown fields (strict mode)", () => {
    expect(() =>
      MockEntry.parse({
        id: "e1",
        match: { method: "GET", path: "/users", unknownField: true },
        response: { kind: "static", status: 200 },
      }),
    ).toThrow();
  });
});

describe("MatchPredicate (T2)", () => {
  it("defaults method to wildcard", () => {
    const p = MatchPredicate.parse({ path: "/foo" });
    expect(p.method).toBe("*");
  });

  it("parses body partial predicate", () => {
    const p = MatchPredicate.parse({
      path: "/orders",
      body: { partial: { currency: "INR" } },
    });
    expect(p.body?.partial).toEqual({ currency: "INR" });
  });
});

describe("TenantConfig (S5)", () => {
  it("applies default limits", () => {
    const parsed = TenantConfig.parse({ name: "acme", mocks: [] });
    expect(parsed.limits.maxBodyBytes).toBe(1_048_576);
    expect(parsed.limits.journalSize).toBe(1000);
  });

  it("rejects tenant names with invalid characters", () => {
    expect(() => TenantConfig.parse({ name: "bad tenant!", mocks: [] })).toThrow();
  });

  it("rejects adminToken shorter than 16 chars", () => {
    expect(() => TenantConfig.parse({ name: "acme", adminToken: "short", mocks: [] })).toThrow();
  });
});

describe("ServerConfig (S4, S3)", () => {
  it("defaults to localhost bind (S4)", () => {
    const parsed = ServerConfig.parse({});
    expect(parsed.host).toBe("127.0.0.1");
  });

  it("defaults admin disabled (S3)", () => {
    const parsed = ServerConfig.parse({});
    expect(parsed.adminEnabled).toBe(false);
  });
});
