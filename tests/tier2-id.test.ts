// Validates: RT-3 (dual-mode ID generator), T4 (deterministic + authentic),
//            T6 (0 collisions in 100-ID burst), O6 (0 collisions in 1M draws at L=14)

import { describe, it, expect } from 'bun:test';
import { createIdHelpers, fnv1a, mulberry32, BASE62 } from '../src/core/templating/tier2/id.ts';

describe('createIdHelpers — non-deterministic mode (T4, T9)', () => {
  const helpers = createIdHelpers({ deterministic: false, tenant: 't', endpoint: 'e', requestCounter: 1 });

  it('generates IDs with the requested prefix and length', () => {
    const id = helpers.id('cust_', 14);
    expect(id.startsWith('cust_')).toBe(true);
    expect(id.length).toBe('cust_'.length + 14);
  });

  it('uses the base62 alphabet by default', () => {
    for (let i = 0; i < 100; i++) {
      const id = helpers.id('', 14);
      expect(id).toMatch(/^[0-9A-Za-z]+$/);
    }
  });

  it('honours a custom alphabet when supplied', () => {
    const id = helpers.id('', 20, '0123456789ABCDEF');
    expect(id).toMatch(/^[0-9A-F]{20}$/);
  });

  it('T6 — produces 100 unique IDs in a burst with 0 collisions', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(helpers.id('x_', 14));
    expect(seen.size).toBe(100);
  });

  it('O6 — 1,000,000 draws at length 14 have 0 collisions', () => {
    // Scaled-down from the stated 1M to keep CI fast; the alphabet × length bit-space makes
    // collision math well-defined: 62^14 ≈ 1.24e25. 1M draws → p(collision) ≈ 1e-14.
    // We assert the stated bound at 1M draws by running 1M iterations.
    const seen = new Set<string>();
    for (let i = 0; i < 1_000_000; i++) {
      const id = helpers.id('', 14);
      if (seen.has(id)) throw new Error(`Collision at iteration ${i}: ${id}`);
      seen.add(id);
    }
    expect(seen.size).toBe(1_000_000);
  });

  it('rejects non-positive length', () => {
    expect(() => helpers.id('', 0)).toThrow();
    expect(() => helpers.id('', -1)).toThrow();
  });

  it('rejects a degenerate alphabet', () => {
    expect(() => helpers.id('', 5, 'x')).toThrow();
  });
});

describe('createIdHelpers — deterministic mode (T4, T10, TN8)', () => {
  it('produces byte-identical IDs for the same (tenant, endpoint, counter) seed', () => {
    const a = createIdHelpers({ deterministic: true, tenant: 'acme', endpoint: 'POST /orders', requestCounter: 1 });
    const b = createIdHelpers({ deterministic: true, tenant: 'acme', endpoint: 'POST /orders', requestCounter: 1 });
    expect(a.id('order_', 14)).toBe(b.id('order_', 14));
  });

  it('varies output when tenant changes', () => {
    const a = createIdHelpers({ deterministic: true, tenant: 'acme', endpoint: 'e', requestCounter: 1 });
    const b = createIdHelpers({ deterministic: true, tenant: 'zeta', endpoint: 'e', requestCounter: 1 });
    expect(a.id('', 14)).not.toBe(b.id('', 14));
  });

  it('varies output when requestCounter changes (per-request isolation)', () => {
    const a = createIdHelpers({ deterministic: true, tenant: 't', endpoint: 'e', requestCounter: 1 });
    const b = createIdHelpers({ deterministic: true, tenant: 't', endpoint: 'e', requestCounter: 2 });
    expect(a.id('', 14)).not.toBe(b.id('', 14));
  });

  it('TN8 — two concurrent helpers with the same seed advance independently', () => {
    // Factory-per-request means the second helper starts fresh even if the first has consumed
    // some of its PRNG budget. Callers don't share state.
    const a = createIdHelpers({ deterministic: true, tenant: 't', endpoint: 'e', requestCounter: 99 });
    const first = a.id('', 14);
    const b = createIdHelpers({ deterministic: true, tenant: 't', endpoint: 'e', requestCounter: 99 });
    const replay = b.id('', 14);
    expect(first).toBe(replay);
  });

  it('matches provider-shaped ID formats (T2 spec validation)', () => {
    const h = createIdHelpers({ deterministic: true, tenant: 'acme', endpoint: 'orders', requestCounter: 42 });
    // Razorpay order_xxx — 14-char base62 after the prefix
    expect(h.id('order_', 14)).toMatch(/^order_[0-9A-Za-z]{14}$/);
    // PayPal 17-char uppercase alphanumeric
    expect(h.id('', 17, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toMatch(/^[0-9A-Z]{17}$/);
    // Twilio 34-char hex (SM + 32-char)
    expect(h.id('SM', 32, '0123456789abcdef')).toMatch(/^SM[0-9a-f]{32}$/);
  });
});

describe('PRNG primitives', () => {
  it('fnv1a is stable across runs', () => {
    expect(fnv1a('acme|orders|1')).toBe(fnv1a('acme|orders|1'));
    expect(fnv1a('a')).not.toBe(fnv1a('b'));
  });

  it('mulberry32 produces reproducible byte streams', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect(Array.from(a(16))).toEqual(Array.from(b(16)));
  });

  it('BASE62 has 62 unique symbols', () => {
    expect(BASE62.length).toBe(62);
    expect(new Set(BASE62).size).toBe(62);
  });
});
