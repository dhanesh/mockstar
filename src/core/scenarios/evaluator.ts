// Satisfies: RT-2 (request attribute extractor — params, query, headers, body dot-path)
// Satisfies: RT-5 (scenario predicate evaluator — first-match-wins, reuses StringMatch semantics)
// Satisfies: T2 (first-match-wins evaluation order)
// Satisfies: T3 (attribute surface: params, query, headers, body dot-path)
// Satisfies: T6 (StringMatch predicate vocabulary reused)
// Satisfies: S1 (RegExp pre-compiled at snapshot build; no per-request new RegExp)
// Satisfies: O1 (missReason returned for unresolved attribute keys — journal field)
// Satisfies: O3 (CompiledScenario regex ownership scoped to snapshot via compileScenarioRules caller)

import type { ScenarioRuleT } from "../config/schema.ts";
import type { StringMatch } from "../matching/discriminators.ts";
import type { CompiledJsonValue, CompiledTemplate } from "../templating/compiler.ts";
import { compileJsonValue, compileTemplate } from "../templating/compiler.ts";

// -- Compiled predicate types (pre-processed at snapshot build) --

type CompiledMatcher =
  | { kind: "exact"; value: string }
  | { kind: "regex"; re: RegExp }
  | { kind: "startsWith"; value: string }
  | { kind: "contains"; value: string };

export interface CompiledScenarioPredicate {
  params?: ReadonlyMap<string, CompiledMatcher>;
  query?: ReadonlyMap<string, CompiledMatcher>;
  headers?: ReadonlyMap<string, CompiledMatcher>;
  body?: ReadonlyMap<string, CompiledMatcher>;
}

export interface CompiledScenarioResponse {
  status?: number;
  headers?: ReadonlyMap<string, CompiledTemplate>;
  bodyTemplate?: CompiledTemplate | null;
  bodyJson?: CompiledJsonValue | null;
  delay?: ScenarioRuleT["response"]["delay"];
}

export interface CompiledScenario {
  readonly id: string;
  readonly predicate: CompiledScenarioPredicate;
  readonly response: CompiledScenarioResponse;
}

export interface ScenarioAttrs {
  readonly params: Record<string, string>;
  readonly query: ReadonlyMap<string, string>;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: unknown;
}

// -- Compilation --

function compileMatcher(spec: StringMatch): CompiledMatcher {
  if (typeof spec === "string") return { kind: "exact", value: spec };
  if ("equals" in spec) return { kind: "exact", value: spec.equals };
  if ("regex" in spec) return { kind: "regex", re: new RegExp(spec.regex) };
  if ("startsWith" in spec) return { kind: "startsWith", value: spec.startsWith };
  return { kind: "contains", value: (spec as { contains: string }).contains };
}

function compileDim(record: Record<string, unknown>): ReadonlyMap<string, CompiledMatcher> {
  return new Map(Object.entries(record).map(([k, v]) => [k, compileMatcher(v as StringMatch)]));
}

function compilePredicate(pred: ScenarioRuleT["when"]): CompiledScenarioPredicate {
  return {
    ...(pred.params && { params: compileDim(pred.params) }),
    ...(pred.query && { query: compileDim(pred.query) }),
    ...(pred.headers && { headers: compileDim(pred.headers) }),
    ...(pred.body && { body: compileDim(pred.body) }),
  };
}

function compileResponse(resp: ScenarioRuleT["response"]): CompiledScenarioResponse {
  const out: CompiledScenarioResponse = {};
  if (resp.status !== undefined) out.status = resp.status;
  if (resp.delay !== undefined) out.delay = resp.delay;
  if (resp.headers) {
    out.headers = new Map(Object.entries(resp.headers).map(([k, v]) => [k, compileTemplate(v)]));
  }
  if (resp.body !== undefined) {
    if (typeof resp.body === "string") {
      out.bodyTemplate = compileTemplate(resp.body);
      out.bodyJson = null;
    } else if (resp.body !== null) {
      out.bodyTemplate = null;
      out.bodyJson = compileJsonValue(resp.body);
    } else {
      out.bodyTemplate = null;
      out.bodyJson = null;
    }
  }
  return out;
}

/** Compile all scenario rules for one mock entry. Called once per snapshot build. */
export function compileScenarioRules(rules: readonly ScenarioRuleT[]): readonly CompiledScenario[] {
  return rules.map((rule) => ({
    id: rule.id,
    predicate: compilePredicate(rule.when),
    response: compileResponse(rule.response),
  }));
}

// -- Evaluation --

function matcherOk(compiled: CompiledMatcher, got: string | undefined): boolean {
  if (got === undefined) return false;
  switch (compiled.kind) {
    case "exact":
      return got === compiled.value;
    case "regex":
      return compiled.re.test(got);
    case "startsWith":
      return got.startsWith(compiled.value);
    case "contains":
      return got.includes(compiled.value);
  }
}

// Navigate a dot-path into a JSON value. Returns undefined if any segment is absent.
function dotGet(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

// Extract the string value of a single predicate attribute from the request.
// Missing attributes return undefined (not an error — U1 silent no-match).
function extractAttribute(
  attrs: ScenarioAttrs,
  ns: "params" | "query" | "headers" | "body",
  key: string,
): string | undefined {
  switch (ns) {
    case "params": {
      const v = attrs.params[key];
      return v !== undefined ? String(v) : undefined;
    }
    case "query":
      return attrs.query.get(key);
    case "headers":
      return attrs.headers.get(key.toLowerCase());
    case "body": {
      const v = dotGet(attrs.body, key);
      return v !== undefined && v !== null ? String(v) : undefined;
    }
  }
}

// Check one predicate dimension. Returns matched=false with a missReason if any attribute
// key is absent from the request (O1 — journal records the unresolved attribute key).
function evalDim(
  dim: ReadonlyMap<string, CompiledMatcher>,
  attrs: ScenarioAttrs,
  ns: "params" | "query" | "headers" | "body",
): { matched: boolean; missReason?: string } {
  for (const [key, matcher] of dim) {
    const got = extractAttribute(attrs, ns, key);
    if (got === undefined) return { matched: false, missReason: `${ns}.${key}` };
    if (!matcherOk(matcher, got)) return { matched: false };
  }
  return { matched: true };
}

// S2 security invariant: evaluateScenarios is data-driven only.
// Every code path that touches request data calls one of: === (exact), RegExp.test, String.startsWith,
// String.includes, or dotGet (property traversal). No eval, new Function, or dynamic dispatch exists.
// If you add a new CompiledMatcher kind, it MUST appear in this list.

/**
 * Evaluate scenario rules in declaration order (T2 first-match-wins).
 * Returns the first matching scenario and the miss reason for the last
 * attribute-absent miss (for O1 journal diagnostics).
 */
export function evaluateScenarios(
  scenarios: readonly CompiledScenario[],
  attrs: ScenarioAttrs,
): { match: CompiledScenario | null; scenarioMissReason?: string } {
  let lastMissReason: string | undefined;
  for (const scenario of scenarios) {
    const pred = scenario.predicate;
    let allMatched = true;
    let missReason: string | undefined;
    for (const ns of ["params", "query", "headers", "body"] as const) {
      const dim = pred[ns];
      if (!dim) continue;
      const result = evalDim(dim, attrs, ns);
      if (!result.matched) {
        allMatched = false;
        if (result.missReason) missReason = result.missReason;
        break;
      }
    }
    if (allMatched) return { match: scenario };
    if (missReason) lastMissReason = missReason;
  }
  return { match: null, scenarioMissReason: lastMissReason };
}
