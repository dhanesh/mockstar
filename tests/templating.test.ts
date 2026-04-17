// @constraint U4 — templating helpers
// @constraint RT-6.2 — compiled at config-load, not per-request
// @constraint F3 — JSON-body templating must compile string leaves at config-load (regression)

import { describe, it, expect } from 'bun:test';
import {
  compileTemplate,
  compileJsonValue,
  renderCompiledJson,
  type TemplateContext,
} from '../src/core/templating/compiler.ts';
import { createFaker } from '../src/core/templating/faker.ts';
import { createClock } from '../src/core/templating/tier2/now.ts';
import { createIdHelpers } from '../src/core/templating/tier2/id.ts';

const ctx: TemplateContext = {
  faker: createFaker({ deterministic: true, seed: 42 }),
  tenant: 'acme',
  requestId: 'req-00000001',
  clock: createClock({ deterministic: true }),
  idHelpers: createIdHelpers({ deterministic: true, tenant: 'acme', endpoint: 'test', requestCounter: 1 }),
  request: {
    method: 'GET',
    path: '/users/42',
    query: { page: '3' },
    headers: { accept: 'application/json' },
    body: { userId: 'u-7' },
    params: { id: '42' },
  },
};

describe('compileTemplate', () => {
  it('renders literals unchanged', () => {
    expect(compileTemplate('hello world').render(ctx)).toBe('hello world');
  });

  it('interpolates {{ tenant }}', () => {
    expect(compileTemplate('tenant={{tenant}}').render(ctx)).toBe('tenant=acme');
  });

  it('interpolates request fields via dot-path', () => {
    expect(compileTemplate('page={{request.query.page}}').render(ctx)).toBe('page=3');
    expect(compileTemplate('id={{request.params.id}}').render(ctx)).toBe('id=42');
    expect(compileTemplate('uid={{request.body.userId}}').render(ctx)).toBe('uid=u-7');
  });

  it('invokes faker methods', () => {
    const out = compileTemplate('{{faker.uuid}}').render(ctx);
    expect(out).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('produces identical output under deterministic mode', () => {
    // RT-12: deterministic seeding — same template, same seed, same output.
    const ctx1: TemplateContext = { ...ctx, faker: createFaker({ deterministic: true, seed: 1 }) };
    const ctx2: TemplateContext = { ...ctx, faker: createFaker({ deterministic: true, seed: 1 }) };
    const tpl = compileTemplate('u:{{faker.uuid}} e:{{faker.email}}');
    expect(tpl.render(ctx1)).toBe(tpl.render(ctx2));
  });

  it('renders unknown tokens literally (surface config errors)', () => {
    // Intentional: unknown tokens render as `{{expr}}` so users see their typo in the response.
    // Silent-empty would hide config mistakes until a consumer noticed a missing field.
    expect(compileTemplate('{{not.a.real.thing}}').render(ctx)).toBe('{{not.a.real.thing}}');
  });
});

describe('JSON-body templating (F3 regression)', () => {
  // Rebuild ctx with a deterministic faker for reproducible assertions.
  const jsonCtx: TemplateContext = {
    ...ctx,
    faker: createFaker({ deterministic: true, seed: 7 }),
  };

  it('compiles string leaves inside an object body and renders them at request time', () => {
    const compiled = compileJsonValue({
      id: '{{request.params.id}}',
      tenant: '{{tenant}}',
      uuid: '{{faker.uuid}}',
      static: 'unchanged',
      nested: { name: '{{faker.name}}' },
    });
    const rendered = renderCompiledJson(compiled, jsonCtx) as Record<string, unknown>;
    expect(rendered.id).toBe('42');
    expect(rendered.tenant).toBe('acme');
    expect(typeof rendered.uuid).toBe('string');
    expect(rendered.uuid as string).toMatch(/^[0-9a-f-]{36}$/);
    expect(rendered.static).toBe('unchanged');
    expect((rendered.nested as Record<string, unknown>).name).toEqual(expect.any(String));
  });

  it('handles faker calls with arguments inside JSON bodies (F3 root cause)', () => {
    // Pre-fix bug: the regex walker called faker methods with no args, so faker.pick([...])
    // received undefined and crashed with "items.length" reading undefined. Fix: compile the
    // string leaf to a CompiledTemplate at config-load, so the same op-sequence interpreter
    // that powers whole-string templates is used for JSON-leaf strings.
    const compiled = compileJsonValue({
      status: '{{faker.pick(["available", "pending", "sold"])}}',
      score: '{{faker.integer(1, 10)}}',
    });
    const rendered = renderCompiledJson(compiled, jsonCtx) as Record<string, unknown>;
    // Tier 2 RT-1.2 type preservation: pure placeholders return raw faker value types.
    expect(['available', 'pending', 'sold']).toContain(rendered.status as string);
    expect(typeof rendered.score).toBe('number');
    expect(rendered.score as number).toBeGreaterThanOrEqual(1);
    expect(rendered.score as number).toBeLessThanOrEqual(10);
  });

  it('compiles string leaves inside arrays (recursion through array items)', () => {
    const compiled = compileJsonValue([
      '{{faker.uuid}}',
      'literal',
      { embedded: '{{request.params.id}}' },
    ]);
    const rendered = renderCompiledJson(compiled, jsonCtx) as unknown[];
    expect((rendered[0] as string)).toMatch(/^[0-9a-f-]{36}$/);
    expect(rendered[1]).toBe('literal');
    expect((rendered[2] as Record<string, unknown>).embedded).toBe('42');
  });

  it('preserves non-string leaf types (numbers, booleans, null) without coercion', () => {
    const compiled = compileJsonValue({
      count: 42,
      active: true,
      nullable: null,
      mixed: { score: 3.14 },
    });
    const rendered = renderCompiledJson(compiled, jsonCtx) as Record<string, unknown>;
    expect(rendered.count).toBe(42);
    expect(rendered.active).toBe(true);
    expect(rendered.nullable).toBeNull();
    expect((rendered.mixed as Record<string, unknown>).score).toBe(3.14);
  });

  it('strings without {{ are stored as literals (no template overhead)', () => {
    const compiled = compileJsonValue({ name: 'plain' });
    expect(compiled.kind).toBe('object');
    if (compiled.kind === 'object') {
      const nameNode = compiled.entries.name;
      expect(nameNode?.kind).toBe('literal');
    }
  });

  it('renderCompiledJson is the only allocation on the hot path for JSON bodies (RT-6.2)', () => {
    // Regression intent: every string leaf must be a pre-built op-sequence, not a string
    // that gets parsed at request time. Pure placeholders → `type_placeholder` (Tier 2 RT-1.2);
    // mixed strings → `template`; strings with no `{{` → `literal`.
    const compiled = compileJsonValue({
      a: '{{faker.uuid}}',
      b: 'plain',
      c: { d: '{{tenant}}' },
      e: 'hello-{{tenant}}-world',
    });
    if (compiled.kind !== 'object') throw new Error('expected object');
    expect(compiled.entries.a?.kind).toBe('type_placeholder');
    expect(compiled.entries.b?.kind).toBe('literal');
    if (compiled.entries.c?.kind !== 'object') throw new Error('expected nested object');
    expect(compiled.entries.c.entries.d?.kind).toBe('type_placeholder');
    expect(compiled.entries.e?.kind).toBe('template');
  });
});
