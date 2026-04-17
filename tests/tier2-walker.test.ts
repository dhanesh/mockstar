// Validates: RT-1 (type-aware JSON walker) — binding constraint
// Validates: RT-1.1 (placeholder parser), RT-1.2 (type-preserving substitution),
//            RT-1.3 (cycle + max-depth), RT-1.4 (deterministic key ordering),
//            RT-1.5 (incremental size bound), RT-1.6 (string-mode dual path)
// Validates: S4 (bounded echo response), T14 (cycle detection + max-depth)

import { describe, it, expect } from 'bun:test';
import {
  compileJsonValue,
  compileTemplate,
  renderCompiledJson,
  type TemplateContext,
} from '../src/core/templating/compiler.ts';
import { createFaker } from '../src/core/templating/faker.ts';
import { createClock } from '../src/core/templating/tier2/now.ts';
import { createIdHelpers } from '../src/core/templating/tier2/id.ts';
import { RenderBudget, Tier2RenderError } from '../src/core/templating/tier2/walker.ts';

function mkCtx(overrides: Partial<TemplateContext['request']> = {}): TemplateContext {
  return {
    faker: createFaker({ deterministic: true, seed: 1 }),
    tenant: 'acme',
    requestId: 'req-00000001',
    clock: createClock({ deterministic: true }),
    idHelpers: createIdHelpers({ deterministic: true, tenant: 'acme', endpoint: 'test', requestCounter: 1 }),
    request: {
      method: 'POST',
      path: '/orders',
      query: {},
      headers: {},
      body: {},
      params: {},
      ...overrides,
    },
  };
}

describe('RT-1.2 — type-preserving substitution', () => {
  it('preserves numbers from request.body', () => {
    const compiled = compileJsonValue({ amount: '{{request.body.amount}}' });
    const rendered = renderCompiledJson(compiled, mkCtx({ body: { amount: 5000 } })) as Record<string, unknown>;
    expect(rendered.amount).toBe(5000);
    expect(typeof rendered.amount).toBe('number');
  });

  it('preserves booleans from request.body', () => {
    const compiled = compileJsonValue({ flag: '{{request.body.flag}}' });
    const rendered = renderCompiledJson(compiled, mkCtx({ body: { flag: true } })) as Record<string, unknown>;
    expect(rendered.flag).toBe(true);
    expect(typeof rendered.flag).toBe('boolean');
  });

  it('preserves nested objects from request.body', () => {
    const compiled = compileJsonValue({ user: '{{request.body.user}}' });
    const user = { id: 42, name: 'ada' };
    const rendered = renderCompiledJson(compiled, mkCtx({ body: { user } })) as Record<string, unknown>;
    expect(rendered.user).toEqual(user);
  });

  it('preserves arrays from request.body', () => {
    const compiled = compileJsonValue({ items: '{{request.body.items}}' });
    const items = [1, 2, 3];
    const rendered = renderCompiledJson(compiled, mkCtx({ body: { items } })) as Record<string, unknown>;
    expect(rendered.items).toEqual(items);
  });

  it('preserves null when the source field is null', () => {
    const compiled = compileJsonValue({ maybe: '{{request.body.maybe}}' });
    const rendered = renderCompiledJson(compiled, mkCtx({ body: { maybe: null } })) as Record<string, unknown>;
    expect(rendered.maybe).toBeNull();
  });

  it('mixed strings stay string-mode (RT-1.6 dual path)', () => {
    const compiled = compileJsonValue({ greeting: 'hello-{{tenant}}-world' });
    const rendered = renderCompiledJson(compiled, mkCtx()) as Record<string, unknown>;
    expect(rendered.greeting).toBe('hello-acme-world');
  });

  it('now.unix returns a number (type-preserved)', () => {
    const compiled = compileJsonValue({ t: '{{now.unix}}' });
    const rendered = renderCompiledJson(compiled, mkCtx()) as Record<string, unknown>;
    expect(typeof rendered.t).toBe('number');
    expect(rendered.t).toBe(Math.floor(Date.UTC(2026, 0, 1) / 1000));
  });

  it('now.iso returns a string', () => {
    const compiled = compileJsonValue({ t: '{{now.iso}}' });
    const rendered = renderCompiledJson(compiled, mkCtx()) as Record<string, unknown>;
    expect(rendered.t).toBe('2026-01-01T00:00:00.000Z');
  });

  it('id() returns a prefixed string', () => {
    const compiled = compileJsonValue({ oid: '{{id("order_", 14)}}' });
    const rendered = renderCompiledJson(compiled, mkCtx()) as Record<string, unknown>;
    expect(rendered.oid).toMatch(/^order_[0-9A-Za-z]{14}$/);
  });
});

describe('RT-1.6 — string-mode dual path (TN3 segmentation)', () => {
  it('compileTemplate always produces string output (header/URL/query contract)', () => {
    const tpl = compileTemplate('{{request.body.amount}}');
    const s = tpl.render(mkCtx({ body: { amount: 5000 } }));
    expect(s).toBe('5000');
    expect(typeof s).toBe('string');
  });

  it('compileTemplate stringifies objects (so headers stay valid)', () => {
    const tpl = compileTemplate('{{request.body.user}}');
    const s = tpl.render(mkCtx({ body: { user: { id: 42 } } }));
    expect(s).toBe('{"id":42}');
  });

  it('now.unix in string context returns a string (header-safe)', () => {
    const tpl = compileTemplate('X-Timestamp: {{now.unix}}');
    const out = tpl.render(mkCtx());
    expect(out).toMatch(/^X-Timestamp: \d+$/);
  });
});

describe('RT-1.5 — incremental size bound (S4)', () => {
  it('throws PAYLOAD_TOO_LARGE when echoed value exceeds budget', () => {
    const huge = 'x'.repeat(2000);
    const compiled = compileJsonValue({ echo: '{{request.body.huge}}' });
    const ctx = mkCtx({ body: { huge } });
    const budget = new RenderBudget({ maxBytes: 500 });
    expect(() => renderCompiledJson(compiled, ctx, budget)).toThrow(Tier2RenderError);
  });

  it('error is surfaced with PAYLOAD_TOO_LARGE code and HTTP 413', () => {
    const compiled = compileJsonValue({ echo: '{{request.body.huge}}' });
    const ctx = mkCtx({ body: { huge: 'x'.repeat(2000) } });
    const budget = new RenderBudget({ maxBytes: 500 });
    try {
      renderCompiledJson(compiled, ctx, budget);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Tier2RenderError);
      const e = err as Tier2RenderError;
      expect(e.code).toBe('PAYLOAD_TOO_LARGE');
      expect(e.httpStatus).toBe(413);
    }
  });

  it('check is incremental — fires BEFORE full serialisation for nested echo', () => {
    // Build a 1 MB body; ensure the walker short-circuits without allocating the full output.
    const huge = { payload: 'z'.repeat(1_200_000) };
    const compiled = compileJsonValue({ echo: '{{request.body.huge}}' });
    const ctx = mkCtx({ body: { huge } });
    const budget = new RenderBudget({ maxBytes: 500_000 });
    try {
      renderCompiledJson(compiled, ctx, budget);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Tier2RenderError);
      expect((err as Tier2RenderError).code).toBe('PAYLOAD_TOO_LARGE');
    }
  });

  it('does NOT throw when within budget', () => {
    const compiled = compileJsonValue({ echo: '{{request.body.msg}}', t: '{{now.unix}}' });
    const ctx = mkCtx({ body: { msg: 'hello' } });
    const budget = new RenderBudget({ maxBytes: 100_000 });
    const rendered = renderCompiledJson(compiled, ctx, budget) as Record<string, unknown>;
    expect(rendered.echo).toBe('hello');
    expect(typeof rendered.t).toBe('number');
  });
});

describe('RT-1.3 — max-depth + cycle detection (T14)', () => {
  it('throws MAX_DEPTH_EXCEEDED when response template is too deep', () => {
    // Build a deep object at COMPILE time.
    let node: unknown = 'leaf';
    for (let i = 0; i < 70; i++) node = { nested: node };
    const compiled = compileJsonValue(node);
    const budget = new RenderBudget({ maxDepth: 32 });
    expect(() => renderCompiledJson(compiled, mkCtx(), budget)).toThrow(Tier2RenderError);
  });

  it('throws CYCLE_DETECTED when request body contains a cycle echoed into response', () => {
    const body: Record<string, unknown> = { self: null };
    body.self = body; // cycle
    const compiled = compileJsonValue({ echo: '{{request.body}}' });
    const ctx = mkCtx({ body });
    expect(() => renderCompiledJson(compiled, ctx)).toThrow(Tier2RenderError);
  });
});

describe('RT-1.4 — deterministic key ordering', () => {
  it('preserves insertion order from the response template', () => {
    const compiled = compileJsonValue({ c: 3, a: 1, b: 2 });
    const rendered = renderCompiledJson(compiled, mkCtx()) as Record<string, unknown>;
    expect(Object.keys(rendered)).toEqual(['c', 'a', 'b']);
  });

  it('produces byte-identical output across two renders with same inputs (T4 via TN4)', () => {
    const compiled = compileJsonValue({
      id: '{{id("order_", 14)}}',
      ts: '{{now.unix}}',
      amount: '{{request.body.amount}}',
      nested: { user: '{{request.body.user}}' },
    });
    const ctx1 = mkCtx({ body: { amount: 5000, user: { id: 42 } } });
    const ctx2 = mkCtx({ body: { amount: 5000, user: { id: 42 } } });
    const a = JSON.stringify(renderCompiledJson(compiled, ctx1));
    const b = JSON.stringify(renderCompiledJson(compiled, ctx2));
    expect(a).toBe(b);
  });
});

describe('RT-1.1 — placeholder parser (tier2 token grammar)', () => {
  it('rejects unknown placeholder shapes by rendering literally', () => {
    // Renders `{{weird.thing}}` as the literal characters in BOTH contexts.
    const tpl = compileTemplate('{{weird.thing}}');
    expect(tpl.render(mkCtx())).toBe('{{weird.thing}}');
  });

  it('accepts id() with 2 or 3 args', () => {
    const c2 = compileJsonValue('{{id("x_", 5)}}');
    const c3 = compileJsonValue('{{id("x_", 5, "ABC")}}');
    const r2 = renderCompiledJson(c2, mkCtx()) as string;
    const r3 = renderCompiledJson(c3, mkCtx()) as string;
    expect(r2).toMatch(/^x_[0-9A-Za-z]{5}$/);
    expect(r3).toMatch(/^x_[ABC]{5}$/);
  });
});
