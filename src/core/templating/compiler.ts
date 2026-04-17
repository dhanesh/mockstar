// Satisfies: RT-6.2 (templating compiled at config-load to op sequence; no per-request parsing)
// Satisfies: U4 (response templating helpers)
// Satisfies: RT-1 (type-aware JSON walker — binding constraint for tier2-request-derived-responses)
// Satisfies: RT-1.2 (type-preserving substitution), RT-1.3 (max-depth), RT-1.5 (incremental size bound)
// Satisfies: RT-2 (factory-closure per placeholder — compile-time bound, per-request invoked)
// Satisfies: TN3 (dual context: JSON-body = type-preserving, header/URL/query = string-mode)
// Priority: binding — on hot path

import type { Entry } from '../config/schema.ts';
import type { FakerInstance } from './faker.ts';
import type { Clock } from './tier2/now.ts';
import type { IdHelpers } from './tier2/id.ts';
import {
  BASE62,
} from './tier2/id.ts';
import {
  RenderBudget,
  estimateJsonSize,
} from './tier2/walker.ts';

export interface TemplateContext {
  faker: FakerInstance;
  request: {
    method: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    body: unknown;
    params: Record<string, string>;
  };
  tenant: string;
  requestId: string;
  clock: Clock;
  idHelpers: IdHelpers;
}

export type TemplateOp =
  | { kind: 'literal'; value: string }
  | { kind: 'faker'; method: keyof FakerInstance; args: readonly unknown[] }
  | { kind: 'request'; path: readonly string[] }
  | { kind: 'var'; name: 'tenant' | 'requestId' }
  | { kind: 'id'; prefix: string; length: number; alphabet: string }
  | { kind: 'now'; field: 'unix' | 'millis' | 'iso' };

export interface CompiledTemplate {
  render(ctx: TemplateContext): string;
}

export interface CompiledResponse {
  /** Non-null if the response body is a string template. */
  bodyTemplate: CompiledTemplate | null;
  /** Non-null if the response body is a JSON value with templates pre-compiled at every string leaf. */
  bodyJson: CompiledJsonValue | null;
  headers: ReadonlyMap<string, CompiledTemplate>;
}

/**
 * A JSON tree where every string leaf has been pre-compiled to a CompiledTemplate at config-load.
 *
 * - `template`   — string-mode: surrounding literals + placeholders. Renders as string.
 * - `type_placeholder` — pure placeholder (whole string is one {{...}}). Renders type-preservingly
 *                        (numbers stay numbers, objects stay objects, arrays stay arrays).
 *                        Satisfies RT-1.2 and TN3 segmentation.
 * - `literal`    — scalar pass-through.
 * - `array` / `object` — recursive structural nodes.
 */
export type CompiledJsonValue =
  | { kind: 'template'; template: CompiledTemplate }
  | { kind: 'type_placeholder'; op: TemplateOp }
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'array'; items: CompiledJsonValue[] }
  | { kind: 'object'; entries: Record<string, CompiledJsonValue> };

const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
/** Matches a whole string that is exactly ONE placeholder (pure-placeholder for type preservation). */
const PURE_PLACEHOLDER_RE = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/;

/**
 * Compile a template string into an op sequence. Called at config-load only.
 */
export function compileTemplate(template: string): CompiledTemplate {
  const ops: TemplateOp[] = [];
  let lastIndex = 0;
  for (const match of template.matchAll(TOKEN_RE)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      ops.push({ kind: 'literal', value: template.slice(lastIndex, start) });
    }
    ops.push(parseToken(match[1] ?? ''));
    lastIndex = start + match[0].length;
  }
  if (lastIndex < template.length) {
    ops.push({ kind: 'literal', value: template.slice(lastIndex) });
  }
  return {
    render(ctx: TemplateContext): string {
      return ops.map((op) => executeOp(op, ctx)).join('');
    },
  };
}

function parseToken(expr: string): TemplateOp {
  // Supported forms:
  //   faker.uuid | faker.integer(1, 100) | faker.pick(["a", "b"])
  //   request.body.user.id | request.query.page | request.headers.authorization
  //   tenant | requestId
  //   id("prefix_", 14) | id("cust_", 14, "0123456789ABCDEF")
  //   now.unix | now.millis | now.iso
  const trimmed = expr.trim();
  if (trimmed === 'tenant' || trimmed === 'requestId') {
    return { kind: 'var', name: trimmed };
  }
  if (trimmed === 'now.unix' || trimmed === 'now.millis' || trimmed === 'now.iso') {
    return { kind: 'now', field: trimmed.slice('now.'.length) as 'unix' | 'millis' | 'iso' };
  }
  if (trimmed.startsWith('id(')) {
    const argsSource = trimmed.slice('id('.length, trimmed.lastIndexOf(')'));
    const args = JSON.parse(`[${argsSource}]`) as unknown[];
    const prefix = typeof args[0] === 'string' ? args[0] : '';
    const length = typeof args[1] === 'number' ? args[1] : 14;
    const alphabet = typeof args[2] === 'string' ? args[2] : BASE62;
    return { kind: 'id', prefix, length, alphabet };
  }
  if (trimmed.startsWith('request.')) {
    return { kind: 'request', path: trimmed.slice('request.'.length).split('.') };
  }
  if (trimmed.startsWith('faker.')) {
    const rest = trimmed.slice('faker.'.length);
    const parenIdx = rest.indexOf('(');
    if (parenIdx === -1) {
      return { kind: 'faker', method: rest as keyof FakerInstance, args: [] };
    }
    const method = rest.slice(0, parenIdx) as keyof FakerInstance;
    const argsSource = rest.slice(parenIdx + 1, rest.lastIndexOf(')'));
    const args = argsSource.trim() === ''
      ? []
      : (JSON.parse(`[${argsSource}]`) as readonly unknown[]);
    return { kind: 'faker', method, args };
  }
  // Unknown token — render it literally so config errors are visible.
  return { kind: 'literal', value: `{{${expr}}}` };
}

/**
 * Execute an op in STRING context. Used for headers, URL params, query strings, and mixed-text
 * JSON leaves. Return value is always a string. Type preservation happens separately via
 * `executeOpTyped` for pure-placeholder JSON-body leaves.
 */
function executeOp(op: TemplateOp, ctx: TemplateContext): string {
  switch (op.kind) {
    case 'literal':
      return op.value;
    case 'var':
      return op.name === 'tenant' ? ctx.tenant : ctx.requestId;
    case 'request': {
      const v = walkRequestPath(op.path, ctx);
      return v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    }
    case 'faker': {
      const fn = ctx.faker[op.method] as (...args: unknown[]) => unknown;
      return String(fn.apply(ctx.faker, op.args as unknown[]));
    }
    case 'id':
      return ctx.idHelpers.id(op.prefix, op.length, op.alphabet);
    case 'now':
      return op.field === 'iso' ? ctx.clock.iso() : String(op.field === 'unix' ? ctx.clock.unix() : ctx.clock.millis());
  }
}

/**
 * Execute an op in JSON-VALUE context (type-preserving). Used exclusively by `type_placeholder`
 * nodes — strings that are a single `{{...}}` placeholder with no surrounding literal text.
 * Returns the raw value (number stays number, object stays object, null stays null).
 */
function executeOpTyped(op: TemplateOp, ctx: TemplateContext): unknown {
  switch (op.kind) {
    case 'literal':
      return op.value;
    case 'var':
      return op.name === 'tenant' ? ctx.tenant : ctx.requestId;
    case 'request':
      return walkRequestPath(op.path, ctx);
    case 'faker': {
      const fn = ctx.faker[op.method] as (...args: unknown[]) => unknown;
      return fn.apply(ctx.faker, op.args as unknown[]);
    }
    case 'id':
      return ctx.idHelpers.id(op.prefix, op.length, op.alphabet);
    case 'now':
      return op.field === 'iso' ? ctx.clock.iso() : op.field === 'unix' ? ctx.clock.unix() : ctx.clock.millis();
  }
}

function walkRequestPath(path: readonly string[], ctx: TemplateContext): unknown {
  let cursor: unknown = ctx.request;
  for (const seg of path) {
    if (cursor !== null && typeof cursor === 'object' && seg in (cursor as object)) {
      cursor = (cursor as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cursor;
}

/**
 * Build compiled responses keyed by entry id. Called once at config-load.
 */
export function compileEntryResponses(entries: readonly Entry[]): Map<string, CompiledResponse> {
  const map = new Map<string, CompiledResponse>();
  for (const e of entries) {
    const compiled: CompiledResponse = {
      bodyTemplate: null,
      bodyJson: null,
      headers: compileHeaderTemplates(e),
    };
    if (e.response.kind === 'static') {
      if (typeof e.response.body === 'string') {
        compiled.bodyTemplate = compileTemplate(e.response.body);
      } else if (e.response.body !== undefined) {
        compiled.bodyJson = compileJsonValue(e.response.body);
      }
    }
    map.set(e.id, compiled);
  }
  return map;
}

/**
 * Walk a JSON value at config-load, compiling every string leaf that contains `{{` into a
 * CompiledTemplate. Strings without `{{` become literal nodes; numbers / booleans / null pass
 * through unchanged. Arrays and objects recurse.
 *
 * Pure-placeholder strings (where the WHOLE string is a single {{...}}) become `type_placeholder`
 * nodes that render type-preservingly at request time. Mixed strings (literal + placeholder)
 * remain `template` nodes and render as strings.
 */
export function compileJsonValue(value: unknown): CompiledJsonValue {
  if (value === null || value === undefined) return { kind: 'literal', value: null };
  if (typeof value === 'string') {
    if (value.includes('{{')) {
      const pure = value.match(PURE_PLACEHOLDER_RE);
      if (pure) {
        return { kind: 'type_placeholder', op: parseToken(pure[1] ?? '') };
      }
      return { kind: 'template', template: compileTemplate(value) };
    }
    return { kind: 'literal', value };
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { kind: 'literal', value };
  }
  if (Array.isArray(value)) {
    return { kind: 'array', items: value.map((item) => compileJsonValue(item)) };
  }
  if (typeof value === 'object') {
    const entries: Record<string, CompiledJsonValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      entries[k] = compileJsonValue(v);
    }
    return { kind: 'object', entries };
  }
  // Unknown type (function, symbol, etc.) — coerce to string literal for safety.
  return { kind: 'literal', value: String(value) };
}

/**
 * Render a compiled JSON tree at request time. O(node count) with budget tracking.
 *
 * The `budget` parameter (RenderBudget) is threaded through the walk and enforces:
 *   - incremental byte cap (S4 / RT-1.5): throws PAYLOAD_TOO_LARGE before serialization
 *   - max recursion depth (T14 / RT-1.3): throws MAX_DEPTH_EXCEEDED
 *   - cycle detection on substituted request-body values (RT-1.3): throws CYCLE_DETECTED
 *
 * The budget is OPTIONAL for backward compatibility — callers without a budget get a permissive
 * default (1 MB / depth 64). Explicit budgets let the HTTP boundary (static-mock) tighten limits.
 */
export function renderCompiledJson(
  node: CompiledJsonValue,
  ctx: TemplateContext,
  budget: RenderBudget = new RenderBudget()
): unknown {
  switch (node.kind) {
    case 'template': {
      const s = node.template.render(ctx);
      budget.consume(s.length + 2);
      return s;
    }
    case 'type_placeholder': {
      const raw = executeOpTyped(node.op, ctx);
      budget.consume(estimateJsonSize(raw, budget));
      return raw;
    }
    case 'literal':
      budget.consume(estimateJsonSize(node.value, budget));
      return node.value;
    case 'array': {
      budget.enterDepth();
      budget.consume(2); // []
      const out = node.items.map((item, i) => {
        if (i > 0) budget.consume(1);
        return renderCompiledJson(item, ctx, budget);
      });
      budget.exitDepth();
      return out;
    }
    case 'object': {
      budget.enterDepth();
      budget.consume(2); // {}
      const out: Record<string, unknown> = {};
      const keys = Object.keys(node.entries);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        if (i > 0) budget.consume(1);
        budget.consume(k.length + 3); // "k":
        out[k] = renderCompiledJson(node.entries[k]!, ctx, budget);
      }
      budget.exitDepth();
      return out;
    }
  }
}

function compileHeaderTemplates(entry: Entry): ReadonlyMap<string, CompiledTemplate> {
  const m = new Map<string, CompiledTemplate>();
  if (entry.response.kind === 'static' && entry.response.headers) {
    for (const [k, v] of Object.entries(entry.response.headers)) {
      m.set(k, compileTemplate(v));
    }
  }
  return m;
}
