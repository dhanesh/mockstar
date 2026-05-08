// Satisfies: RT-9 (standalone binary smoke — `--version` returns 0).
//
// Runs the compiled binary on the current host's target only (cross-arch
// execution needs qemu/emulation which is not wired here — CI matrix runs
// this test on each native runner).

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";

const distDir = resolve(import.meta.dir, "..", "..", "dist");

function currentTarget(): string {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `bun-${os}-${arch}`;
}

describe("RT-9: binary smoke", () => {
  const target = currentTarget();
  const binPath = resolve(distDir, `mockstar-${target}`);

  if (!existsSync(binPath)) {
    it.skip(`(skipped — ${binPath} not built; run \`bun run scripts/build-binaries.ts --target=${target}\`)`, () => {});
    return;
  }

  // @constraint T3 — binary runs `--version` successfully
  it(`mockstar-${target} --version exits 0`, async () => {
    const result = await $`${binPath} --version`.nothrow().quiet();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toMatch(/^mockstar \d+\.\d+\.\d+/);
  });
});
