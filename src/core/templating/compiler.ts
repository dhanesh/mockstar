// Satisfies: RT-6.2 (templating compiled at config-load to op sequence; no per-request parsing)
// Satisfies: U4 (response templating helpers)
// Priority: binding — on hot path

import type { Entry } from '../config/schema.ts';
import type { FakerInstance } from './faker.ts';

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
}

export type TemplateOp =
  | { kind: 'literal'; value: string }
  | { kind: 'faker'; method: keyof FakerInstance; args: readonly unknown[] }
  | { kind: 'request'; path: readonly string[] }
  | { kind: 'var'; name: 'tenant' | 'requestId' };

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
 * Closes F3: previously, JSON-object bodies used a runtime regex walker that called faker methods
 * with no arguments, breaking faker.pick(args) and similar. Now the same op-sequence parsing that
 * powers whole-string templates also covers string leaves inside JSON objects/arrays — keeping
 * RT-6.2 (templates compiled at config-load, not per-request).
 */
export type CompiledJsonValue =
  | { kind: 'template'; template: CompiledTemplate }
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'array'; items: CompiledJsonValue[] }
  | { kind: 'object'; entries: Record<string, CompiledJsonValue> };

const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

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
  const trimmed = expr.trim();
  if (trimmed === 'tenant' || trimmed === 'requestId') {
    return { kind: 'var', name: trimmed };
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

function executeOp(op: TemplateOp, ctx: TemplateContext): string {
  switch (op.kind) {
    case 'literal':
      return op.value;
    case 'var':
      return op.name === 'tenant' ? ctx.tenant : ctx.requestId;
    case 'request': {
      let cursor: unknown = ctx.request;
      for (const seg of op.path) {
        if (cursor !== null && typeof cursor === 'object' && seg in (cursor as object)) {
          cursor = (cursor as Record<string, unknown>)[seg];
        } else {
          return '';
        }
      }
      return cursor === undefined || cursor === null ? '' : String(cursor);
    }
    case 'faker': {
      const fn = ctx.faker[op.method] as (...args: unknown[]) => unknown;
      const out = fn.apply(ctx.faker, op.args as unknown[]);
      return String(out);
    }
  }
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
 */
export function compileJsonValue(value: unknown): CompiledJsonValue {
  if (value === null || value === undefined) return { kind: 'literal', value: null };
  if (typeof value === 'string') {
    if (value.includes('{{')) return { kind: 'template', template: compileTemplate(value) };
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
 * Render a compiled JSON tree at request time. O(node count); no parsing or regex.
 */
export function renderCompiledJson(node: CompiledJsonValue, ctx: TemplateContext): unknown {
  switch (node.kind) {
    case 'template':
      return node.template.render(ctx);
    case 'literal':
      return node.value;
    case 'array':
      return node.items.map((item) => renderCompiledJson(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.entries)) {
        out[k] = renderCompiledJson(v, ctx);
      }
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
