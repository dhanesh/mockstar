// Satisfies: T2 (rich request matching — query, headers, JSON body + JSONPath)
// Priority: binding — on hot path; predicates must be cheap and early-exit.

import { JSONPath } from "jsonpath-plus";
import type { Predicate } from "../config/schema.ts";

export type StringMatch =
  | string
  | { equals: string }
  | { regex: string }
  | { startsWith: string }
  | { contains: string };

export interface RequestView {
  query: ReadonlyMap<string, string>;
  headers: ReadonlyMap<string, string>;
  body: unknown; // parsed JSON or null
}

export interface PredicateFailure {
  kind: "query" | "headers" | "body";
  field: string;
  expected: string;
  got: string | undefined;
}

/**
 * Evaluate discriminator predicates (query, headers, body) for a request.
 * Returns null on match, otherwise the first failing predicate — enough
 * context for diagnostic 404 (RT-9).
 */
export function evaluateDiscriminators(pred: Predicate, req: RequestView): PredicateFailure | null {
  if (pred.query) {
    for (const [field, expected] of Object.entries(pred.query)) {
      const got = req.query.get(field);
      if (!stringMatchOk(expected as StringMatch, got)) {
        return { kind: "query", field, expected: describe(expected as StringMatch), got };
      }
    }
  }
  if (pred.headers) {
    for (const [field, expected] of Object.entries(pred.headers)) {
      const got = req.headers.get(field.toLowerCase());
      if (!stringMatchOk(expected as StringMatch, got)) {
        return { kind: "headers", field, expected: describe(expected as StringMatch), got };
      }
    }
  }
  if (pred.body) {
    const b = req.body;
    if (pred.body.equals !== undefined) {
      if (!deepEquals(pred.body.equals, b)) {
        return { kind: "body", field: "$", expected: "equals", got: typeof b };
      }
    }
    if (pred.body.partial) {
      if (!partialMatch(pred.body.partial, b)) {
        return { kind: "body", field: "$", expected: "partial", got: typeof b };
      }
    }
    if (pred.body.jsonpath) {
      const result = JSONPath({ path: pred.body.jsonpath, json: b ?? {} });
      if (!Array.isArray(result) || result.length === 0) {
        return { kind: "body", field: pred.body.jsonpath, expected: "jsonpath match", got: "no matches" };
      }
    }
  }
  return null;
}

export function stringMatchOk(spec: StringMatch, got: string | undefined): boolean {
  if (typeof spec === "string") return got === spec;
  if ("equals" in spec) return got === spec.equals;
  if (got === undefined) return false;
  if ("regex" in spec) return new RegExp(spec.regex).test(got);
  if ("startsWith" in spec) return got.startsWith(spec.startsWith);
  if ("contains" in spec) return got.includes(spec.contains);
  return false;
}

function describe(spec: StringMatch): string {
  if (typeof spec === "string") return `=${spec}`;
  if ("equals" in spec) return `=${spec.equals}`;
  if ("regex" in spec) return `~/${spec.regex}/`;
  if ("startsWith" in spec) return `^${spec.startsWith}`;
  if ("contains" in spec) return `*${spec.contains}*`;
  return "?";
}

// -- Precompiled discriminators (#41: regexes compiled once at MatchIndex build time, not
// per request — mirrors src/core/scenarios/evaluator.ts's CompiledMatcher/compileMatcher shape). --

export type CompiledMatcher =
  | { kind: "exact"; value: string }
  | { kind: "regex"; re: RegExp }
  | { kind: "startsWith"; value: string }
  | { kind: "contains"; value: string };

export interface CompiledPredicate {
  query?: ReadonlyMap<string, CompiledMatcher>;
  headers?: ReadonlyMap<string, CompiledMatcher>;
  body?: Predicate["body"];
}

function compileMatcher(spec: StringMatch): CompiledMatcher {
  if (typeof spec === "string") return { kind: "exact", value: spec };
  if ("equals" in spec) return { kind: "exact", value: spec.equals };
  if ("regex" in spec) return { kind: "regex", re: new RegExp(spec.regex) };
  if ("startsWith" in spec) return { kind: "startsWith", value: spec.startsWith };
  return { kind: "contains", value: spec.contains };
}

function compileDim(record: Record<string, StringMatch>): ReadonlyMap<string, CompiledMatcher> {
  return new Map(Object.entries(record).map(([k, v]) => [k, compileMatcher(v)]));
}

/** Compile a match predicate's regex-bearing dimensions once. Called at MatchIndex build time. */
export function compilePredicate(pred: Predicate): CompiledPredicate {
  return {
    ...(pred.query && { query: compileDim(pred.query as Record<string, StringMatch>) }),
    ...(pred.headers && { headers: compileDim(pred.headers as Record<string, StringMatch>) }),
    ...(pred.body && { body: pred.body }),
  };
}

function compiledMatchOk(compiled: CompiledMatcher, got: string | undefined): boolean {
  if (compiled.kind === "exact") return got === compiled.value;
  if (got === undefined) return false;
  if (compiled.kind === "regex") return compiled.re.test(got);
  if (compiled.kind === "startsWith") return got.startsWith(compiled.value);
  return got.includes(compiled.value);
}

function describeCompiled(m: CompiledMatcher): string {
  switch (m.kind) {
    case "exact":
      return `=${m.value}`;
    case "regex":
      return `~/${m.re.source}/`;
    case "startsWith":
      return `^${m.value}`;
    case "contains":
      return `*${m.value}*`;
  }
}

/**
 * Same semantics as evaluateDiscriminators, but reads from a precompiled predicate — no
 * `new RegExp` on this path. Used by MatchIndex.match/nearestMatch on the request hot path.
 */
export function evaluateCompiledDiscriminators(
  pred: CompiledPredicate,
  req: RequestView,
): PredicateFailure | null {
  if (pred.query) {
    for (const [field, expected] of pred.query) {
      const got = req.query.get(field);
      if (!compiledMatchOk(expected, got)) {
        return { kind: "query", field, expected: describeCompiled(expected), got };
      }
    }
  }
  if (pred.headers) {
    for (const [field, expected] of pred.headers) {
      const got = req.headers.get(field.toLowerCase());
      if (!compiledMatchOk(expected, got)) {
        return { kind: "headers", field, expected: describeCompiled(expected), got };
      }
    }
  }
  if (pred.body) {
    const b = req.body;
    if (pred.body.equals !== undefined) {
      if (!deepEquals(pred.body.equals, b)) {
        return { kind: "body", field: "$", expected: "equals", got: typeof b };
      }
    }
    if (pred.body.partial) {
      if (!partialMatch(pred.body.partial, b)) {
        return { kind: "body", field: "$", expected: "partial", got: typeof b };
      }
    }
    if (pred.body.jsonpath) {
      const result = JSONPath({ path: pred.body.jsonpath, json: b ?? {} });
      if (!Array.isArray(result) || result.length === 0) {
        return { kind: "body", field: pred.body.jsonpath, expected: "jsonpath match", got: "no matches" };
      }
    }
  }
  return null;
}

function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    const key = ka[i];
    if (key === undefined) return false;
    if (!deepEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

function partialMatch(template: Record<string, unknown>, value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  for (const [k, v] of Object.entries(template)) {
    const vv = (value as Record<string, unknown>)[k];
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      if (!partialMatch(v as Record<string, unknown>, vv)) return false;
    } else if (!deepEquals(v, vv)) {
      return false;
    }
  }
  return true;
}
