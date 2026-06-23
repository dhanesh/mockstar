// Satisfies: O3 (pipeline p99 ≤ 15 min timing assertion), T5 (binary hash recording).
//
// Static verification that release.yml contains the load-bearing shapes:
//  - A timing guard step that warns when elapsed > 900s (O3).
//  - A sha256 recording step on each binary target (T5 reproducibility evidence).

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(resolve(import.meta.dir, "..", "..", ".github/workflows/release.yml"), "utf8");

describe("O3: pipeline timing guard", () => {
  // @constraint O3 — release wall-clock p99 ≤ 15 min (900s)
  it("release.yml has a timing guard step referencing github.run_started_at", () => {
    expect(workflow).toMatch(/github\.run_started_at/);
  });

  it("timing guard warns when elapsed > 900s", () => {
    const block = workflow.split(/pipeline timing guard/)[1] ?? "";
    expect(block).toMatch(/900/);
    expect(block).toMatch(/warning/);
  });
});

describe("T5: binary sha256 recording for reproducibility", () => {
  // @constraint T5 — reproducibility evidence: hash recorded per build
  it("build-binaries job records sha256 of each compiled binary", () => {
    const block = workflow.split(/record binary sha256/)[1] ?? "";
    // Portable hashing: `sha256sum` on Linux, `shasum -a 256` on macOS runners.
    expect(block).toMatch(/sha256sum|shasum -a 256/);
    expect(block).toMatch(/mockstar-.*target/);
  });

  it("sha256 file is included in the uploaded artifact", () => {
    const block = workflow.split(/record binary sha256/)[1] ?? "";
    expect(block).toMatch(/\.sha256/);
  });
});
