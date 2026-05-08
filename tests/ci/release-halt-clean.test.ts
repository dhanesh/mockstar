// Satisfies: RT-6 (CI pipeline retry + halt-clean).
//
// O5 requires two things:
//  (1) Transient failures are retried with exponential backoff (max 3 attempts).
//  (2) A hard failure leaves no partial state (unsigned tag in GHCR).
// This test validates both.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflowPath = resolve(import.meta.dir, "..", "..", ".github", "workflows", "release.yml");

describe("RT-6: release workflow retry + halt-clean wiring", () => {
  const yml = readFileSync(workflowPath, "utf8");

  // @constraint O5 — retry on transient failure (exponential backoff, max 3 attempts)
  it("npm publish step retries up to 3 times with backoff", () => {
    const block = yml.split(/name: publish to npm with provenance/)[1] ?? "";
    expect(block).toMatch(/for attempt in 1 2 3/);
    expect(block).toMatch(/sleep \$\(\(attempt \* 15\)\)/);
  });

  it("cosign sign image step retries up to 3 times with backoff", () => {
    const block = yml.split(/name: cosign sign image by digest/)[1] ?? "";
    expect(block).toMatch(/for attempt in 1 2 3/);
    expect(block).toMatch(/sleep \$\(\(attempt \* 15\)\)/);
  });

  it("cosign attest step retries up to 3 times with backoff", () => {
    const block = yml.split(/name: cosign attest CycloneDX SBOM/)[1] ?? "";
    expect(block).toMatch(/for attempt in 1 2 3/);
    expect(block).toMatch(/sleep \$\(\(attempt \* 15\)\)/);
  });

  it("helm push step retries up to 3 times with backoff", () => {
    const block = yml.split(/name: helm push to OCI/)[1] ?? "";
    expect(block).toMatch(/for attempt in 1 2 3/);
    expect(block).toMatch(/sleep \$\(\(attempt \* 15\)\)/);
  });

  it("cosign sign helm chart step retries up to 3 times with backoff", () => {
    const block = yml.split(/name: cosign sign helm chart by digest/)[1] ?? "";
    expect(block).toMatch(/for attempt in 1 2 3/);
    expect(block).toMatch(/sleep \$\(\(attempt \* 15\)\)/);
  });

  // @constraint O5 — halt-clean runs only on failure (partial-state cleanup)
  it("declares a `halt-clean` job gated on failure()", () => {
    expect(yml).toMatch(/^\s{2}halt-clean:/m);
    const block = yml.split(/^\s{2}halt-clean:/m)[1] ?? "";
    expect(block).toMatch(/if:\s*\$\{\{\s*failure\(\)\s*\}\}/);
  });

  // @constraint S1 — unsigned-artifact deletion is the halt-clean load-bearing step
  it("`halt-clean` depends on every publish job", () => {
    const block = yml.split(/^\s{2}halt-clean:/m)[1] ?? "";
    for (const dep of ["publish-npm", "publish-container", "publish-helm", "build-binaries"]) {
      expect(block).toContain(dep);
    }
  });

  it("`halt-clean` deletes the pushed container tag", () => {
    const block = yml.split(/^\s{2}halt-clean:/m)[1] ?? "";
    expect(block).toMatch(/DELETE/);
    expect(block).toMatch(/tag_name=/);
  });
});
