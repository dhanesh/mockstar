// @constraint O6 — Bun version policy runtime check
// @constraint G17 — runtime preflight

import { describe, expect, it } from "bun:test";
import { MIN_BUN_VERSION, compareVersion, preflight } from "../src/core/preflight.ts";

describe("preflight", () => {
  it("compares versions correctly", () => {
    expect(compareVersion("1.3.0", "1.3.0")).toBe(0);
    expect(compareVersion("1.4.0", "1.3.0")).toBeGreaterThan(0);
    expect(compareVersion("1.2.9", "1.3.0")).toBeLessThan(0);
    expect(compareVersion("2.0.0", "1.3.0")).toBeGreaterThan(0);
  });

  it("flags below-minimum versions", () => {
    const r = preflight("1.0.0");
    expect(r.ok).toBe(false);
    expect(r.warning).toContain(MIN_BUN_VERSION);
  });

  it("accepts the minimum version", () => {
    const r = preflight(MIN_BUN_VERSION);
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it("warns but does not fail when not running on Bun (library embed in Node)", () => {
    // Explicit null bypasses the default detection (which would find Bun in the test runner).
    const r = preflight(null);
    expect(r.ok).toBe(true);
    expect(r.warning ?? "").toContain("Bun");
  });
});
