// Satisfies: RT-7 (ESM-only package shape with Jest 29 escape hatch).
//
// Asserts the package.json `exports` map has `types` listed FIRST in every
// condition branch — load-bearing for TypeScript's moduleResolution: bundler
// and node16/nodenext, which use the first matching condition. Getting this
// order wrong silently breaks type resolution in consumer projects.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Conditions = Record<string, string | Conditions>;

const pkg: {
  type?: string;
  exports?: Record<string, Conditions | string>;
  main?: string;
} = JSON.parse(readFileSync(resolve(import.meta.dir, "..", "..", "package.json"), "utf8"));

describe("RT-7: ESM-only package shape", () => {
  // @constraint T1 — ESM-only, no dual CJS/ESM
  it('declares `"type": "module"`', () => {
    expect(pkg.type).toBe("module");
  });

  it("does NOT declare `main` (ESM-only, no CJS fallback)", () => {
    expect(pkg.main).toBeUndefined();
  });

  it("has an `exports` map", () => {
    expect(pkg.exports).toBeDefined();
  });

  it('root export "." has `types` listed BEFORE `import` in its condition branch', () => {
    const root = pkg.exports?.["."];
    expect(root).toBeDefined();
    expect(typeof root).toBe("object");
    const conditions = root as Conditions;
    const keys = Object.keys(conditions);
    // types-first is load-bearing for moduleResolution: bundler/node16/nodenext.
    expect(keys.indexOf("types")).toBeLessThan(keys.indexOf("import"));
  });

  it('root export "." import target is ESM (.js)', () => {
    const imp = (pkg.exports?.["."] as Conditions)?.["import"];
    expect(typeof imp).toBe("string");
    expect(imp).toMatch(/\.js$/);
  });
});
