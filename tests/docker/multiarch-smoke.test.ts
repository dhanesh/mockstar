// Satisfies: RT-8 (multi-arch container smoke).
//
// Locally: verifies the Dockerfile declares both amd64 and arm64 are buildable
// (by inspecting the release workflow's platforms: string) and that the built
// image passes a /health curl.
// In CI: matrix-run on each arch via docker buildx.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";

const repoRoot = resolve(import.meta.dir, "..", "..");
const workflow = readFileSync(resolve(repoRoot, ".github/workflows/release.yml"), "utf8");

describe("RT-8: multi-arch container", () => {
  // @constraint T2 — linux/amd64 AND linux/arm64 both
  it("release.yml declares platforms: linux/amd64,linux/arm64", () => {
    expect(workflow).toMatch(/platforms:\s*linux\/amd64,\s*linux\/arm64/);
  });

  it("build-push-action has provenance and sbom enabled", () => {
    expect(workflow).toMatch(/provenance:\s*mode=max/);
    expect(workflow).toMatch(/sbom:\s*true/);
  });

  // Optional: actually build + smoke test locally. Requires Docker running.
  const imageTag = process.env.MOCKSTAR_SMOKE_IMAGE;
  if (!imageTag) {
    it.skip("(skipped — live smoke test; set MOCKSTAR_SMOKE_IMAGE to run)", () => {});
    return;
  }

  it("docker run <image> responds to /health", async () => {
    const run =
      await $`docker run -d -p 3001:3000 -v ${repoRoot}/examples/mocks:/config/mocks --name mockstar-smoke ${imageTag}`
        .nothrow()
        .quiet();
    try {
      expect(run.exitCode).toBe(0);
      // Give it a moment to boot.
      await new Promise((r) => setTimeout(r, 1500));
      const curl = await $`curl -sf http://127.0.0.1:3001/health`.nothrow().quiet();
      expect(curl.exitCode).toBe(0);
    } finally {
      await $`docker rm -f mockstar-smoke`.nothrow().quiet();
    }
  });
});
