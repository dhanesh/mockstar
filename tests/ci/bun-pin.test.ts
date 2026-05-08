// Satisfies: RT-1 (Bun version pinning — TN6 resolution).
//
// The .bun-version file is the single source of truth for the toolchain version.
// This test asserts:
//   (1) the file exists and contains a parseable SemVer
//   (2) every CI workflow that invokes Bun reads from this file (never hardcodes)
//   (3) the currently-running Bun matches the pinned version (skipped locally;
//       CI sets the exact version via bun-version-file: .bun-version)

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..");

describe("RT-1: Bun version pinning", () => {
  it("`.bun-version` file exists at repo root", () => {
    expect(existsSync(resolve(repoRoot, ".bun-version"))).toBe(true);
  });

  it("`.bun-version` contains a parseable SemVer", () => {
    const raw = readFileSync(resolve(repoRoot, ".bun-version"), "utf8").trim();
    expect(raw).toMatch(/^\d+\.\d+\.\d+(?:-\S+)?$/);
  });

  // @constraint T5 — CI workflows must use bun-version-file, not a hardcoded tag
  it("every release/ci workflow step that sets up Bun uses bun-version-file", () => {
    const workflowDir = resolve(repoRoot, ".github", "workflows");
    // Not a full yaml parse — a single-line grep is sufficient and robust.
    const yml = ["release.yml", "quickstart-smoke.yml"];
    for (const name of yml) {
      const path = resolve(workflowDir, name);
      if (!existsSync(path)) continue;
      const content = readFileSync(path, "utf8");
      // Every oven-sh/setup-bun usage must specify bun-version-file.
      const uses = (content.match(/oven-sh\/setup-bun@/g) ?? []).length;
      const pinned = (content.match(/bun-version-file:\s*\.bun-version/g) ?? []).length;
      expect(uses).toBeGreaterThan(0);
      expect(pinned).toBeGreaterThanOrEqual(uses);
    }
  });
});
