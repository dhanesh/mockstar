// @constraint T2 — rich request matching (query, headers, JSON body + JSONPath)
// Exercises evaluateDiscriminators + stringMatchOk public surface, success & failure paths.

import { describe, expect, it } from "bun:test";
import type { Predicate } from "../src/core/config/schema.ts";
import {
  type RequestView,
  type StringMatch,
  evaluateDiscriminators,
  stringMatchOk,
} from "../src/core/matching/discriminators.ts";

function view(opts: {
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}): RequestView {
  return {
    query: new Map(Object.entries(opts.query ?? {})),
    headers: new Map(Object.entries(opts.headers ?? {})),
    body: opts.body ?? null,
  };
}

// Build a minimal Predicate-shaped object. The function only reads query/headers/body,
// so a partial cast is enough and keeps the tests focused on discriminator logic.
function pred(p: Partial<Predicate>): Predicate {
  return p as Predicate;
}

describe("stringMatchOk", () => {
  it("bare string is exact equality", () => {
    expect(stringMatchOk("foo", "foo")).toBe(true);
    expect(stringMatchOk("foo", "bar")).toBe(false);
    expect(stringMatchOk("foo", undefined)).toBe(false);
  });

  it("{equals} matches exactly and tolerates undefined", () => {
    expect(stringMatchOk({ equals: "x" }, "x")).toBe(true);
    expect(stringMatchOk({ equals: "x" }, "y")).toBe(false);
    // {equals} is checked before the undefined guard, so undefined !== "x" is false (no throw).
    expect(stringMatchOk({ equals: "x" }, undefined)).toBe(false);
  });

  it("{regex} tests the pattern", () => {
    expect(stringMatchOk({ regex: "^v[0-9]+$" }, "v12")).toBe(true);
    expect(stringMatchOk({ regex: "^v[0-9]+$" }, "vX")).toBe(false);
  });

  it("{startsWith} and {contains}", () => {
    expect(stringMatchOk({ startsWith: "Bearer " }, "Bearer abc")).toBe(true);
    expect(stringMatchOk({ startsWith: "Bearer " }, "Basic abc")).toBe(false);
    expect(stringMatchOk({ contains: "json" }, "application/json")).toBe(true);
    expect(stringMatchOk({ contains: "json" }, "text/plain")).toBe(false);
  });

  it("non-string matchers short-circuit to false on undefined value", () => {
    for (const spec of [{ regex: ".*" }, { startsWith: "" }, { contains: "" }] as StringMatch[]) {
      expect(stringMatchOk(spec, undefined)).toBe(false);
    }
  });
});

describe("evaluateDiscriminators — query", () => {
  it("returns null when every query predicate matches", () => {
    const fail = evaluateDiscriminators(
      pred({ query: { v: "2", debug: { contains: "tru" } } }),
      view({ query: { v: "2", debug: "true" } }),
    );
    expect(fail).toBeNull();
  });

  it("reports the first failing query field with describe() context", () => {
    const fail = evaluateDiscriminators(pred({ query: { v: "2" } }), view({ query: { v: "3" } }));
    expect(fail).toEqual({ kind: "query", field: "v", expected: "=2", got: "3" });
  });

  it("reports got=undefined when query param is absent", () => {
    const fail = evaluateDiscriminators(pred({ query: { v: { startsWith: "x" } } }), view({ query: {} }));
    expect(fail).toMatchObject({ kind: "query", field: "v", expected: "^x", got: undefined });
  });
});

describe("evaluateDiscriminators — headers", () => {
  it("looks up header names case-insensitively (lower-cased)", () => {
    // RequestView headers are expected to be pre-lowercased keys; predicate name is lower-cased before lookup.
    const ok = evaluateDiscriminators(
      pred({ headers: { "Content-Type": { contains: "json" } } }),
      view({ headers: { "content-type": "application/json" } }),
    );
    expect(ok).toBeNull();
  });

  it("reports header failures with describe() of the matcher", () => {
    const fail = evaluateDiscriminators(
      pred({ headers: { authorization: { startsWith: "Bearer " } } }),
      view({ headers: { authorization: "Basic xyz" } }),
    );
    expect(fail).toEqual({
      kind: "headers",
      field: "authorization",
      expected: "^Bearer ",
      got: "Basic xyz",
    });
  });
});

describe("evaluateDiscriminators — body.equals", () => {
  it("passes on a deep-equal object regardless of key order", () => {
    const ok = evaluateDiscriminators(
      pred({ body: { equals: { a: 1, b: { c: 2 } } } }),
      view({ body: { b: { c: 2 }, a: 1 } }),
    );
    expect(ok).toBeNull();
  });

  it("fails when bodies differ structurally", () => {
    const fail = evaluateDiscriminators(pred({ body: { equals: { a: 1 } } }), view({ body: { a: 2 } }));
    expect(fail).toEqual({ kind: "body", field: "$", expected: "equals", got: "object" });
  });

  it("treats arrays and objects as non-equal", () => {
    const fail = evaluateDiscriminators(pred({ body: { equals: [1, 2] } }), view({ body: { 0: 1, 1: 2 } }));
    expect(fail).not.toBeNull();
  });

  it("matches primitive equality (numbers)", () => {
    expect(evaluateDiscriminators(pred({ body: { equals: 5 } }), view({ body: 5 }))).toBeNull();
    expect(evaluateDiscriminators(pred({ body: { equals: 5 } }), view({ body: 6 }))).not.toBeNull();
  });

  it("null body equals null", () => {
    expect(evaluateDiscriminators(pred({ body: { equals: null } }), view({ body: null }))).toBeNull();
  });
});

describe("evaluateDiscriminators — body.partial", () => {
  it("matches a subset of top-level keys", () => {
    const ok = evaluateDiscriminators(
      pred({ body: { partial: { type: "order" } } }),
      view({ body: { type: "order", id: 99, extra: true } }),
    );
    expect(ok).toBeNull();
  });

  it("recurses into nested objects", () => {
    const ok = evaluateDiscriminators(
      pred({ body: { partial: { meta: { region: "eu" } } } }),
      view({ body: { meta: { region: "eu", zone: "a" }, other: 1 } }),
    );
    expect(ok).toBeNull();
  });

  it("fails when a nested expected value is missing", () => {
    const fail = evaluateDiscriminators(
      pred({ body: { partial: { meta: { region: "eu" } } } }),
      view({ body: { meta: { region: "us" } } }),
    );
    expect(fail).toEqual({ kind: "body", field: "$", expected: "partial", got: "object" });
  });

  it("fails when body is not an object", () => {
    const fail = evaluateDiscriminators(pred({ body: { partial: { a: 1 } } }), view({ body: null }));
    expect(fail).not.toBeNull();
  });

  it("array-valued template leaf uses deepEquals (exact array match)", () => {
    expect(
      evaluateDiscriminators(
        pred({ body: { partial: { tags: ["a", "b"] } } }),
        view({ body: { tags: ["a", "b"], x: 1 } }),
      ),
    ).toBeNull();
    expect(
      evaluateDiscriminators(
        pred({ body: { partial: { tags: ["a", "b"] } } }),
        view({ body: { tags: ["a"] } }),
      ),
    ).not.toBeNull();
  });
});

describe("evaluateDiscriminators — body.jsonpath", () => {
  it("passes when the JSONPath yields at least one match", () => {
    const ok = evaluateDiscriminators(
      pred({ body: { jsonpath: "$.items[?(@.qty > 0)]" } }),
      view({ body: { items: [{ qty: 3 }, { qty: 0 }] } }),
    );
    expect(ok).toBeNull();
  });

  it("fails when the JSONPath yields no matches", () => {
    const fail = evaluateDiscriminators(
      pred({ body: { jsonpath: "$.items[?(@.qty > 99)]" } }),
      view({ body: { items: [{ qty: 1 }] } }),
    );
    expect(fail).toEqual({
      kind: "body",
      field: "$.items[?(@.qty > 99)]",
      expected: "jsonpath match",
      got: "no matches",
    });
  });

  it("defaults a null body to {} so JSONPath does not throw", () => {
    const fail = evaluateDiscriminators(pred({ body: { jsonpath: "$.anything" } }), view({ body: null }));
    expect(fail).not.toBeNull();
    expect(fail?.got).toBe("no matches");
  });
});

describe("evaluateDiscriminators — composition & ordering", () => {
  it("returns null when no predicates are specified", () => {
    expect(evaluateDiscriminators(pred({}), view({}))).toBeNull();
  });

  it("query is evaluated before headers (first failure wins)", () => {
    const fail = evaluateDiscriminators(
      pred({ query: { v: "2" }, headers: { x: "y" } }),
      view({ query: { v: "BAD" }, headers: { x: "WRONG" } }),
    );
    expect(fail?.kind).toBe("query");
  });

  it("all three dimensions passing returns null", () => {
    const ok = evaluateDiscriminators(
      pred({
        query: { v: "2" },
        headers: { authorization: { startsWith: "Bearer " } },
        body: { partial: { ok: true } },
      }),
      view({
        query: { v: "2" },
        headers: { authorization: "Bearer t" },
        body: { ok: true, n: 1 },
      }),
    );
    expect(ok).toBeNull();
  });
});
