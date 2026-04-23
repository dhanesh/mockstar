// Validates: RT-3 (Zod schema — ScenarioPredicate, ScenarioResponse, ScenarioRule, MockEntry extension)
// Validates: B1 (backward compat — existing mock files without scenarios still parse)
// Validates: B2 (any HTTP status 100-599 accepted in scenario response)
// Validates: T4 (50-rule ceiling with actionable error message)
// Validates: S1 (ReDoS guard on regex predicates)
// Validates: U3 (config-load validation with actionable errors — mock ID, scenario index)
// Validates: TN1 (dynamic/passthrough scenario responses require status+headers+body)

import { describe, it, expect } from 'bun:test';
import { MockEntry, ScenarioRule, ScenarioPredicate, ScenarioResponse } from '../src/core/config/schema.ts';

// -- B1: backward compatibility --

describe('backward compatibility', () => {
  it('parses a mock entry without scenarios unchanged', () => {
    // @constraint B1
    const result = MockEntry.safeParse({
      id: 'get-user',
      match: { method: 'GET', path: '/users/:id' },
      response: { kind: 'static', status: 200, body: { id: '1' } },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.scenarios).toBeUndefined();
  });
});

// -- ScenarioPredicate --

describe('ScenarioPredicate', () => {
  it('accepts params predicate with exact string', () => {
    // @constraint T3
    expect(ScenarioPredicate.safeParse({ params: { lastName: 'Test' } }).success).toBe(true);
  });

  it('accepts query predicate with regex', () => {
    expect(ScenarioPredicate.safeParse({ query: { status: { regex: '^error$' } } }).success).toBe(true);
  });

  it('accepts body dot-path predicate', () => {
    // @constraint T3
    expect(ScenarioPredicate.safeParse({ body: { 'user.role': 'admin' } }).success).toBe(true);
  });

  it('rejects empty predicate (no attributes)', () => {
    const r = ScenarioPredicate.safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/at least one of/);
  });

  it('rejects unsafe regex — nested quantifiers', () => {
    // @constraint S1
    const r = ScenarioPredicate.safeParse({ params: { name: { regex: '(a+)+' } } });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/catastrophic backtracking/);
  });

  it('rejects unsafe regex — alternation with quantifier', () => {
    // @constraint S1
    const r = ScenarioPredicate.safeParse({ params: { name: { regex: '(foo|bar)+' } } });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/catastrophic backtracking/);
  });

  it('accepts safe regex with bounded quantifier', () => {
    // @constraint S1 (TN3 — bounded patterns accepted)
    expect(ScenarioPredicate.safeParse({ params: { code: { regex: '^[A-Z]{2,4}$' } } }).success).toBe(true);
  });
});

// -- ScenarioResponse --

describe('ScenarioResponse', () => {
  it('accepts status-only override', () => {
    // @constraint U2
    expect(ScenarioResponse.safeParse({ status: 404 }).success).toBe(true);
  });

  it('accepts body-only override', () => {
    expect(ScenarioResponse.safeParse({ body: { error: 'not found' } }).success).toBe(true);
  });

  it('accepts status+body override', () => {
    // @constraint B2
    expect(ScenarioResponse.safeParse({ status: 500, body: { error: 'server_error' } }).success).toBe(true);
  });

  it('accepts any valid HTTP status code', () => {
    // @constraint B2
    for (const status of [100, 200, 201, 301, 404, 422, 500, 503, 599]) {
      expect(ScenarioResponse.safeParse({ status }).success).toBe(true);
    }
  });

  it('rejects status 99', () => {
    expect(ScenarioResponse.safeParse({ status: 99 }).success).toBe(false);
  });

  it('rejects status 600', () => {
    expect(ScenarioResponse.safeParse({ status: 600 }).success).toBe(false);
  });

  it('rejects delay-only override (no status/headers/body)', () => {
    const r = ScenarioResponse.safeParse({ delay: 100 });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/at least one of/);
  });

  it('rejects empty response', () => {
    expect(ScenarioResponse.safeParse({}).success).toBe(false);
  });
});

// -- ScenarioRule --

describe('ScenarioRule', () => {
  it('parses a complete scenario rule', () => {
    const r = ScenarioRule.safeParse({
      id: 'not-found-for-test-user',
      when: { params: { lastName: 'Test' } },
      response: { status: 404, body: { error: 'user_not_found' } },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.id).toBe('not-found-for-test-user');
      expect(r.data.when.params?.lastName).toBe('Test');
      expect(r.data.response.status).toBe(404);
    }
  });
});

// -- MockEntry with scenarios --

describe('MockEntry scenarios', () => {
  it('parses entry with scenarios array', () => {
    // @constraint B3
    const r = MockEntry.safeParse({
      id: 'get-user',
      match: { method: 'GET', path: '/users/:lastName' },
      response: { kind: 'static', status: 200, body: { found: true } },
      scenarios: [
        { id: 'not-found', when: { params: { lastName: 'Test' } }, response: { status: 404 } },
        { id: 'server-error', when: { params: { lastName: 'Carpenter' } }, response: { status: 500 } },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.scenarios?.length).toBe(2);
  });

  it('rejects more than 50 scenarios', () => {
    // @constraint T4
    const scenarios = Array.from({ length: 51 }, (_, i) => ({
      id: `rule-${i}`,
      when: { params: { id: String(i) } },
      response: { status: 404 },
    }));
    const r = MockEntry.safeParse({
      id: 'test',
      match: { method: 'GET', path: '/items/:id' },
      response: { kind: 'static', status: 200 },
      scenarios,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/ceiling is 50/);
  });

  it('accepts exactly 50 scenarios', () => {
    // @constraint T4
    const scenarios = Array.from({ length: 50 }, (_, i) => ({
      id: `rule-${i}`,
      when: { params: { id: String(i) } },
      response: { status: 404 },
    }));
    const r = MockEntry.safeParse({
      id: 'test',
      match: { method: 'GET', path: '/items/:id' },
      response: { kind: 'static', status: 200 },
      scenarios,
    });
    expect(r.success).toBe(true);
  });

  it('rejects dynamic entry with incomplete scenario response', () => {
    // @constraint TN1 (dynamic must have status+headers+body)
    const r = MockEntry.safeParse({
      id: 'dyn',
      match: { method: 'POST', path: '/orders' },
      response: { kind: 'dynamic', handler: 'myHandler' },
      scenarios: [
        {
          id: 'bad',
          when: { params: { id: 'x' } },
          response: { status: 500 },  // missing headers + body
        },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues[0]?.message ?? '';
      expect(msg).toMatch(/dynamic/);
      expect(msg).toMatch(/status, headers, body/);
    }
  });

  it('rejects passthrough entry with incomplete scenario response', () => {
    // @constraint TN1
    const r = MockEntry.safeParse({
      id: 'pt',
      match: { method: 'GET', path: '/proxy' },
      response: { kind: 'passthrough', upstream: 'https://api.example.com' },
      scenarios: [
        { id: 'err', when: { query: { fail: 'true' } }, response: { status: 503 } },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues[0]?.message ?? '';
      expect(msg).toMatch(/passthrough/);
    }
  });

  it('accepts dynamic entry with complete scenario response', () => {
    // @constraint TN1
    const r = MockEntry.safeParse({
      id: 'dyn',
      match: { method: 'POST', path: '/orders' },
      response: { kind: 'dynamic', handler: 'myHandler' },
      scenarios: [
        {
          id: 'err',
          when: { params: { id: 'bad' } },
          response: {
            status: 500,
            headers: { 'content-type': 'application/json' },
            body: { error: 'internal' },
          },
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('includes mock ID and scenario index in error message', () => {
    // @constraint U3
    const r = MockEntry.safeParse({
      id: 'my-mock-id',
      match: { method: 'GET', path: '/items/:id' },
      response: { kind: 'dynamic', handler: 'h' },
      scenarios: [
        { id: 'bad-scenario', when: { params: { id: 'x' } }, response: { status: 404 } },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues[0]?.message ?? '';
      expect(msg).toContain('my-mock-id');
      expect(msg).toContain('bad-scenario');
    }
  });
});
