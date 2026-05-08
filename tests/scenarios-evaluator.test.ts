// Validates: RT-5 (scenario predicate evaluator — first-match-wins, attribute extractor)
// Validates: T2 (first-match-wins evaluation order)
// Validates: T3 (attribute surface: params, query, headers, body dot-path)
// Validates: T6 (StringMatch vocabulary: exact, equals, regex, startsWith, contains)
// Validates: U1 (no-match is silent — returns null, no error)
// Validates: O1 (missReason for absent attribute keys)

import { describe, it, expect } from "bun:test";
import {
  compileScenarioRules,
  evaluateScenarios,
  type ScenarioAttrs,
} from "../src/core/scenarios/evaluator.ts";
import type { ScenarioRuleT } from "../src/core/config/schema.ts";

function makeAttrs(overrides?: Partial<ScenarioAttrs>): ScenarioAttrs {
  return {
    params: {},
    query: new Map(),
    headers: new Map(),
    body: null,
    ...overrides,
  };
}

function rule(
  id: string,
  when: ScenarioRuleT["when"],
  response: ScenarioRuleT["response"] = { status: 404 },
): ScenarioRuleT {
  return { id, when, response };
}

// -- U1: no-match silent --

describe("no-match behaviour (U1)", () => {
  it("returns null when no scenarios defined", () => {
    const { match } = evaluateScenarios([], makeAttrs());
    expect(match).toBeNull();
  });

  it("returns null when no rule matches", () => {
    const compiled = compileScenarioRules([rule("r1", { params: { lastName: "Test" } })]);
    const { match } = evaluateScenarios(compiled, makeAttrs({ params: { lastName: "Smith" } }));
    expect(match).toBeNull();
  });
});

// -- T2: first-match-wins --

describe("first-match-wins (T2)", () => {
  it("returns the first matching rule", () => {
    const compiled = compileScenarioRules([
      rule("r1", { params: { lastName: "Test" } }, { status: 404 }),
      rule("r2", { params: { lastName: "Test" } }, { status: 500 }),
    ]);
    const { match } = evaluateScenarios(compiled, makeAttrs({ params: { lastName: "Test" } }));
    expect(match?.id).toBe("r1");
  });

  it("returns the second rule when first does not match", () => {
    const compiled = compileScenarioRules([
      rule("r1", { params: { lastName: "Carpenter" } }),
      rule("r2", { params: { lastName: "Test" } }),
    ]);
    const { match } = evaluateScenarios(compiled, makeAttrs({ params: { lastName: "Test" } }));
    expect(match?.id).toBe("r2");
  });
});

// -- T3: attribute surface --

describe("params attribute (T3)", () => {
  it("matches exact param value", () => {
    const compiled = compileScenarioRules([rule("r", { params: { id: "locked" } })]);
    const { match } = evaluateScenarios(compiled, makeAttrs({ params: { id: "locked" } }));
    expect(match?.id).toBe("r");
  });

  it("misses when param absent", () => {
    const compiled = compileScenarioRules([rule("r", { params: { id: "x" } })]);
    const { match } = evaluateScenarios(compiled, makeAttrs({ params: {} }));
    expect(match).toBeNull();
  });
});

describe("query attribute (T3)", () => {
  it("matches query string value", () => {
    const compiled = compileScenarioRules([rule("r", { query: { fail: "true" } })]);
    const q = new Map([["fail", "true"]]);
    const { match } = evaluateScenarios(compiled, makeAttrs({ query: q }));
    expect(match?.id).toBe("r");
  });
});

describe("headers attribute (T3)", () => {
  it("matches header value (case-insensitive key)", () => {
    const compiled = compileScenarioRules([rule("r", { headers: { "x-test-mode": "error" } })]);
    const h = new Map([["x-test-mode", "error"]]);
    const { match } = evaluateScenarios(compiled, makeAttrs({ headers: h }));
    expect(match?.id).toBe("r");
  });
});

describe("body dot-path attribute (T3)", () => {
  it("matches top-level body field", () => {
    const compiled = compileScenarioRules([rule("r", { body: { role: "admin" } })]);
    const { match } = evaluateScenarios(compiled, makeAttrs({ body: { role: "admin" } }));
    expect(match?.id).toBe("r");
  });

  it("matches nested body field via dot-path", () => {
    const compiled = compileScenarioRules([rule("r", { body: { "user.lastName": "Test" } })]);
    const { match } = evaluateScenarios(compiled, makeAttrs({ body: { user: { lastName: "Test" } } }));
    expect(match?.id).toBe("r");
  });

  it("misses when nested path is absent", () => {
    const compiled = compileScenarioRules([rule("r", { body: { "user.lastName": "Test" } })]);
    const { match } = evaluateScenarios(compiled, makeAttrs({ body: { user: {} } }));
    expect(match).toBeNull();
  });
});

// -- T6: StringMatch vocabulary --

describe("StringMatch predicates (T6)", () => {
  it("equals object form", () => {
    const compiled = compileScenarioRules([rule("r", { params: { code: { equals: "ERR" } } })]);
    expect(evaluateScenarios(compiled, makeAttrs({ params: { code: "ERR" } })).match?.id).toBe("r");
    expect(evaluateScenarios(compiled, makeAttrs({ params: { code: "OK" } })).match).toBeNull();
  });

  it("startsWith predicate", () => {
    const compiled = compileScenarioRules([rule("r", { params: { code: { startsWith: "ERR_" } } })]);
    expect(evaluateScenarios(compiled, makeAttrs({ params: { code: "ERR_TIMEOUT" } })).match?.id).toBe("r");
    expect(evaluateScenarios(compiled, makeAttrs({ params: { code: "OK" } })).match).toBeNull();
  });

  it("contains predicate", () => {
    const compiled = compileScenarioRules([rule("r", { params: { msg: { contains: "fail" } } })]);
    expect(evaluateScenarios(compiled, makeAttrs({ params: { msg: "payment_fail_retry" } })).match?.id).toBe(
      "r",
    );
  });

  it("regex predicate", () => {
    const compiled = compileScenarioRules([rule("r", { params: { code: { regex: "^[A-Z]{3}$" } } })]);
    expect(evaluateScenarios(compiled, makeAttrs({ params: { code: "ERR" } })).match?.id).toBe("r");
    expect(evaluateScenarios(compiled, makeAttrs({ params: { code: "error" } })).match).toBeNull();
  });
});

// -- O1: missReason for absent attribute keys --

describe("O1: scenario miss reason", () => {
  it("returns missReason when predicate targets absent param", () => {
    const compiled = compileScenarioRules([rule("r", { params: { lastName: "Test" } })]);
    // Route has no :lastName — params is empty
    const { match, scenarioMissReason } = evaluateScenarios(compiled, makeAttrs({ params: {} }));
    expect(match).toBeNull();
    expect(scenarioMissReason).toBe("params.lastName");
  });

  it("returns missReason for absent body dot-path", () => {
    const compiled = compileScenarioRules([rule("r", { body: { "order.id": "x" } })]);
    const { scenarioMissReason } = evaluateScenarios(compiled, makeAttrs({ body: {} }));
    expect(scenarioMissReason).toBe("body.order.id");
  });

  it("returns no missReason when predicate attribute present but value does not match", () => {
    const compiled = compileScenarioRules([rule("r", { params: { lastName: "Test" } })]);
    const { match, scenarioMissReason } = evaluateScenarios(
      compiled,
      makeAttrs({ params: { lastName: "Smith" } }),
    );
    expect(match).toBeNull();
    // Attribute was present, just wrong value — no missing-attribute reason
    expect(scenarioMissReason).toBeUndefined();
  });
});

// -- Multi-dimension predicates --

describe("multi-dimension predicates", () => {
  it("all dimensions must match", () => {
    const compiled = compileScenarioRules([rule("r", { params: { id: "x" }, query: { fail: "true" } })]);
    // Only params match, query does not
    expect(
      evaluateScenarios(
        compiled,
        makeAttrs({
          params: { id: "x" },
          query: new Map([["fail", "false"]]),
        }),
      ).match,
    ).toBeNull();

    // Both match
    expect(
      evaluateScenarios(
        compiled,
        makeAttrs({
          params: { id: "x" },
          query: new Map([["fail", "true"]]),
        }),
      ).match?.id,
    ).toBe("r");
  });
});
