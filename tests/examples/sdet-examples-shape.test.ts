// Satisfies: RT-15 (support matrix covers jest30, jest29, vitest, bun-test)

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const EXAMPLES_ROOT = resolve(import.meta.dir, "..", "..", "examples");

const FRAMEWORKS = [
  { dir: "sdet-jest30", testFile: "mockstar.test.js" },
  { dir: "sdet-jest29", testFile: "mockstar.test.js" },
  { dir: "sdet-vitest", testFile: "mockstar.test.ts" },
  { dir: "sdet-bun-test", testFile: "mockstar.test.ts" },
] as const;

describe("RT-15: SDET example shape", () => {
  for (const fx of FRAMEWORKS) {
    describe(fx.dir, () => {
      const root = resolve(EXAMPLES_ROOT, fx.dir);
      it("package.json + test file + mocks fixture exist", () => {
        expect(existsSync(resolve(root, "package.json"))).toBe(true);
        expect(existsSync(resolve(root, fx.testFile))).toBe(true);
        expect(existsSync(resolve(root, "mocks", "default", "example.json"))).toBe(true);
      });

      it('package.json depends on @dhanesh/mockstar + declares a "test" script', async () => {
        const pkg = (await Bun.file(resolve(root, "package.json")).json()) as {
          dependencies?: Record<string, string>;
          scripts?: Record<string, string>;
        };
        expect(pkg.dependencies?.["@dhanesh/mockstar"]).toBeDefined();
        expect(pkg.scripts?.test).toBeDefined();
      });

      it("test file imports launch from @dhanesh/mockstar and uses deterministic:true", async () => {
        const text = await Bun.file(resolve(root, fx.testFile)).text();
        expect(text).toMatch(/import\s+\{\s*launch\s*\}\s+from\s+['"]@dhanesh\/mockstar['"]/);
        expect(text).toMatch(/deterministic:\s*true/);
      });
    });
  }

  it("docs/SDET.md lists all four examples", async () => {
    const text = await Bun.file(resolve(EXAMPLES_ROOT, "..", "docs", "SDET.md")).text();
    for (const fx of FRAMEWORKS) expect(text).toContain(fx.dir);
  });
});
