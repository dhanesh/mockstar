// Satisfies: RT-9 (standalone binary <= 150 MB per target, TN2-relaxed ceiling).
//
// Runs after `bun run scripts/build-binaries.ts` has produced at least one
// target. Skipped gracefully when no dist/mockstar-* binaries exist so this
// test file can live in the default test run without forcing a binary build.

import { describe, expect, it } from "bun:test";
import { readdirSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const distDir = resolve(import.meta.dir, "..", "..", "dist");
const SIZE_CEILING = 150 * 1024 * 1024; // T7, TN2

const EXPECTED_TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-arm64", "bun-linux-x64"];

describe("RT-9: binary size ceiling", () => {
  const distExists = existsSync(distDir);
  const artifacts = distExists ? readdirSync(distDir).filter((f) => f.startsWith("mockstar-bun-")) : [];

  if (artifacts.length === 0) {
    it.skip("(skipped — no dist/mockstar-bun-* binaries; run `bun run scripts/build-binaries.ts` to build)", () => {});
    return;
  }

  // @constraint T7 — 150 MB ceiling per target
  for (const a of artifacts) {
    it(`${a} is <= 150 MB`, () => {
      const size = statSync(resolve(distDir, a)).size;
      expect(size).toBeLessThanOrEqual(SIZE_CEILING);
    });
  }

  it("produces binaries for all 4 declared targets (when run in CI)", () => {
    if (process.env.CI !== "true") {
      // Locally, one target is enough — CI matrix exercises all four.
      expect(artifacts.length).toBeGreaterThanOrEqual(1);
      return;
    }
    for (const t of EXPECTED_TARGETS) {
      expect(artifacts).toContain(`mockstar-${t}`);
    }
  });
});
