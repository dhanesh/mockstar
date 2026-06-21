// Validates: U4 (timestamp helpers), T4 (deterministic mode: fixed epoch yields byte-identity)

import { describe, expect, it } from "bun:test";
import { createClock } from "../src/core/templating/tier2/now.ts";

describe("createClock — wall mode", () => {
  const clock = createClock({ deterministic: false });

  it("unix() returns integer seconds close to Date.now()", () => {
    const now = Math.floor(Date.now() / 1000);
    const u = clock.unix();
    expect(Number.isInteger(u)).toBe(true);
    expect(Math.abs(u - now)).toBeLessThanOrEqual(2);
  });

  it("millis() returns integer ms close to Date.now()", () => {
    const now = Date.now();
    const m = clock.millis();
    expect(Number.isInteger(m)).toBe(true);
    expect(Math.abs(m - now)).toBeLessThanOrEqual(50);
  });

  it("iso() returns a parseable RFC 3339 string", () => {
    const s = clock.iso();
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(s))).toBe(false);
  });
});

describe("createClock — deterministic mode (T4)", () => {
  it("returns the default fixed epoch (2026-01-01T00:00:00Z) when no override", () => {
    const c = createClock({ deterministic: true });
    expect(c.iso()).toBe("2026-01-01T00:00:00.000Z");
    expect(c.unix()).toBe(Math.floor(Date.UTC(2026, 0, 1) / 1000));
    expect(c.millis()).toBe(Date.UTC(2026, 0, 1));
  });

  it("honours a custom fixedEpochMs", () => {
    const c = createClock({ deterministic: true, fixedEpochMs: 1_700_000_000_000 });
    expect(c.millis()).toBe(1_700_000_000_000);
    expect(c.unix()).toBe(1_700_000_000);
    expect(c.iso()).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("produces byte-identical output across calls (no side effects)", () => {
    const c = createClock({ deterministic: true });
    expect(c.iso()).toBe(c.iso());
    expect(c.unix()).toBe(c.unix());
  });

  it("two clocks with the same config produce identical output (T4 reproducibility)", () => {
    const a = createClock({ deterministic: true, fixedEpochMs: 1000 });
    const b = createClock({ deterministic: true, fixedEpochMs: 1000 });
    expect(a.iso()).toBe(b.iso());
    expect(a.unix()).toBe(b.unix());
    expect(a.millis()).toBe(b.millis());
  });
});
