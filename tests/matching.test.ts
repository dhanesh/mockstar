// @constraint T2 — rich request matching (method/path/query/headers/body)
// @constraint U1 — diagnostic 404 builds on nearest-match
// @constraint RT-6.1 — match index is O(log n)

import { describe, it, expect } from "bun:test";
import { MockEntry } from "../src/core/config/schema.ts";
import { buildMatchIndex } from "../src/core/matching/index.ts";

function view(opts: { query?: Record<string, string>; headers?: Record<string, string>; body?: unknown }): {
  query: Map<string, string>;
  headers: Map<string, string>;
  body: unknown;
} {
  return {
    query: new Map(Object.entries(opts.query ?? {})),
    headers: new Map(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    body: opts.body ?? null,
  };
}

describe("match index", () => {
  const entries = [
    MockEntry.parse({
      id: "e1",
      match: { method: "GET", path: "/users/:id", priority: 0 },
      response: { kind: "static", status: 200, body: "ok" },
    }),
    MockEntry.parse({
      id: "e2",
      match: { method: "GET", path: "/users/:id", query: { tier: "premium" }, priority: 10 },
      response: { kind: "static", status: 200, body: "premium" },
    }),
    MockEntry.parse({
      id: "e3",
      match: { method: "POST", path: "/orders", body: { partial: { currency: "INR" } } },
      response: { kind: "static", status: 201, body: "{}" },
    }),
  ];
  const index = buildMatchIndex(entries);

  it("matches method + path with param extraction", () => {
    const hit = index.match("GET", "/users/42", view({}));
    expect(hit?.entry.id).toBe("e1");
    expect(hit?.params).toEqual({ id: "42" });
  });

  it("prefers higher-priority entries with matching discriminators", () => {
    const hit = index.match("GET", "/users/42", view({ query: { tier: "premium" } }));
    expect(hit?.entry.id).toBe("e2"); // priority 10 > 0
  });

  it("matches body partial JSON", () => {
    const hit = index.match("POST", "/orders", view({ body: { currency: "INR", amount: 100 } }));
    expect(hit?.entry.id).toBe("e3");
  });

  it("returns null on no match", () => {
    const hit = index.match("DELETE", "/users/42", view({}));
    expect(hit).toBeNull();
  });

  it("nearestMatch returns candidates that matched method+path but failed discriminators", () => {
    const near = index.nearestMatch("GET", "/users/42", view({ query: { tier: "gold" } }));
    // e2 matched path but query predicate failed; e1 has no discriminators and would match normally.
    // We only return failures, so we expect e2 in the list.
    const ids = near.map((n) => n.entry.id);
    expect(ids).toContain("e2");
  });
});
