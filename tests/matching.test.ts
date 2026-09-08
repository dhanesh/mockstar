// @constraint T2 — rich request matching (method/path/query/headers/body)
// @constraint U1 — diagnostic 404 builds on nearest-match
// @constraint RT-6.1 — match index is O(log n)

import { describe, expect, it } from "bun:test";
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

// #41: discriminator regexes must be compiled once at buildMatchIndex time, not per request.
// We monkeypatch the global RegExp constructor to count instantiations — buildMatchIndex should
// account for exactly the regex-bearing predicates, and repeated match() calls afterward must not
// add to that count. This fails at pre-fix HEAD, where discriminators.ts did `new RegExp(...)`
// inside stringMatchOk on every evaluated candidate.
describe("match index — regex precompilation (#41)", () => {
  it("compiles discriminator regexes once at build time, not per match() call", () => {
    const OriginalRegExp = RegExp;
    let constructedCount = 0;
    class CountingRegExp extends OriginalRegExp {
      constructor(pattern: string | RegExp, flags?: string) {
        constructedCount++;
        super(pattern, flags);
      }
    }
    // @ts-expect-error — intentional global monkeypatch for instrumentation, restored below.
    globalThis.RegExp = CountingRegExp;

    try {
      const regexEntries = [
        MockEntry.parse({
          id: "r1",
          match: { method: "GET", path: "/search", query: { q: { regex: "^[a-z]+$" } } },
          response: { kind: "static", status: 200, body: "ok" },
        }),
        MockEntry.parse({
          id: "r2",
          match: { method: "GET", path: "/search2", headers: { "x-trace": { regex: "^v[0-9]+$" } } },
          response: { kind: "static", status: 200, body: "ok" },
        }),
      ];

      const before = constructedCount;
      const regexIndex = buildMatchIndex(regexEntries);
      const afterBuild = constructedCount;
      expect(afterBuild).toBeGreaterThan(before); // compiled at build time...

      for (let i = 0; i < 20; i++) {
        regexIndex.match("GET", "/search", view({ query: { q: "abc" } }));
        regexIndex.match("GET", "/search", view({ query: { q: "ABC" } })); // mismatch path too
        regexIndex.match("GET", "/search2", view({ headers: { "x-trace": "v12" } }));
      }

      // ...and evaluating 60 requests against the compiled regexes must not construct any more.
      expect(constructedCount).toBe(afterBuild);
    } finally {
      globalThis.RegExp = OriginalRegExp;
    }
  });
});
