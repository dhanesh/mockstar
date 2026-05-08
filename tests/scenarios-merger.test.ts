// Validates: RT-6 (response merger — static partial override, non-static self-contained)
// Validates: U2 (partial response override — absent scenario fields inherit from default)
// Validates: TN1 (static inherits; dynamic/passthrough self-contained)
// Validates: T1 (merged result description — correctness of field merging before walker pass)

import { describe, it, expect } from "bun:test";
import { mergeStaticResponse, scenarioResponseForNonStatic } from "../src/core/scenarios/merger.ts";
import { compileScenarioRules } from "../src/core/scenarios/evaluator.ts";
import type { ScenarioRuleT } from "../src/core/config/schema.ts";
import type { CompiledResponse } from "../src/core/templating/compiler.ts";
import { compileTemplate } from "../src/core/templating/compiler.ts";
import type { Entry } from "../src/core/config/schema.ts";

function makeStaticEntry(
  overrides?: Partial<Entry["response"] & { id?: string }>,
): Parameters<typeof mergeStaticResponse>[0] {
  return {
    id: overrides?.id ?? "test-entry",
    match: { method: "GET" as const, path: "/test", priority: 0 },
    response: {
      kind: "static",
      status: 200,
      headers: { "content-type": "application/json" },
      body: { default: true },
    },
  } as Parameters<typeof mergeStaticResponse>[0];
}

function makeDefaultCompiled(): CompiledResponse {
  return {
    bodyTemplate: null,
    bodyJson: null,
    headers: new Map([["content-type", compileTemplate("application/json")]]),
  };
}

function makeCompiledScenario(rule: ScenarioRuleT) {
  return compileScenarioRules([rule])[0]!;
}

// -- U2: partial override --

describe("mergeStaticResponse (U2 partial override)", () => {
  it("uses scenario status, inherits default body", () => {
    // @constraint U2
    const scenario = makeCompiledScenario({
      id: "override-status",
      when: { params: { id: "x" } },
      response: { status: 404 },
    });
    const merged = mergeStaticResponse(makeStaticEntry(), makeDefaultCompiled(), scenario);
    expect(merged.status).toBe(404);
    // body not provided by scenario → inherits from default compiled (null template + null json)
    expect(merged.bodyTemplate).toBeNull();
    expect(merged.bodyJson).toBeNull();
  });

  it("uses scenario body, inherits default status", () => {
    // @constraint U2
    const scenario = makeCompiledScenario({
      id: "override-body",
      when: { params: { id: "x" } },
      response: { body: { error: "not_found" } },
    });
    const merged = mergeStaticResponse(makeStaticEntry(), makeDefaultCompiled(), scenario);
    // Status inherited from default (200)
    expect(merged.status).toBe(200);
    // Body from scenario
    expect(merged.bodyJson).not.toBeNull();
  });

  it("merges headers: scenario headers overlay default headers", () => {
    const defaultCompiled: CompiledResponse = {
      bodyTemplate: null,
      bodyJson: null,
      headers: new Map([
        ["content-type", compileTemplate("application/json")],
        ["x-default", compileTemplate("yes")],
      ]),
    };
    const scenario = makeCompiledScenario({
      id: "override-headers",
      when: { params: { id: "x" } },
      response: { status: 404, headers: { "content-type": "application/problem+json" } },
    });
    const merged = mergeStaticResponse(makeStaticEntry(), defaultCompiled, scenario);
    // content-type overridden by scenario
    expect(merged.headers.has("content-type")).toBe(true);
    // x-default inherited from default
    expect(merged.headers.has("x-default")).toBe(true);
  });

  it("uses scenario delay, falls back to default delay when absent", () => {
    const entryWithDelay = {
      ...makeStaticEntry(),
      response: {
        kind: "static" as const,
        status: 200,
        delay: 100,
      },
    };
    const scenarioNoDelay = makeCompiledScenario({
      id: "no-delay",
      when: { params: { id: "x" } },
      response: { status: 404 },
    });
    const merged = mergeStaticResponse(entryWithDelay, makeDefaultCompiled(), scenarioNoDelay);
    expect(merged.delay).toBe(100);

    const scenarioWithDelay = makeCompiledScenario({
      id: "with-delay",
      when: { params: { id: "x" } },
      response: { status: 404, delay: { min: 50, max: 200 } },
    });
    const mergedWithDelay = mergeStaticResponse(makeStaticEntry(), makeDefaultCompiled(), scenarioWithDelay);
    expect(mergedWithDelay.delay).toEqual({ min: 50, max: 200 });
  });
});

// -- TN1: non-static self-contained --

describe("scenarioResponseForNonStatic (TN1)", () => {
  it("uses all fields from scenario response directly", () => {
    // @constraint TN1
    const scenario = makeCompiledScenario({
      id: "self-contained",
      when: { params: { id: "bad" } },
      response: {
        status: 500,
        headers: { "content-type": "application/json" },
        body: { error: "internal" },
      },
    });
    const result = scenarioResponseForNonStatic(scenario);
    expect(result.status).toBe(500);
    expect(result.headers.size).toBe(1);
    expect(result.bodyJson).not.toBeNull();
    expect(result.bodyTemplate).toBeNull();
  });
});
