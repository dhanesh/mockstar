// Satisfies: U4 (DevOps quickstart includes cosign verify as deploy-to-prod step).
//
// U4 was anchored via TN3 resolution: "DevOps quickstart must show explicit
// cosign verify as the deploy-to-prod step, with a doc link."

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const doc = resolve(ROOT, "docs", "DEPLOYMENT.md");

describe("U4: deployment guide includes cosign verify section", () => {
  it("docs/DEPLOYMENT.md exists", () => {
    expect(existsSync(doc)).toBe(true);
  });

  const text = readFileSync(doc, "utf8");

  // @constraint U4 — DevOps quickstart has explicit cosign verify step
  it('has a "Verifying the image before deploying to production" section', () => {
    expect(text).toMatch(/Verifying the image before deploying to production/i);
  });

  it("shows the cosign verify command with OIDC issuer flag", () => {
    expect(text).toMatch(/cosign verify/);
    expect(text).toMatch(/certificate-oidc-issuer/);
    expect(text).toMatch(/token\.actions\.githubusercontent\.com/);
  });

  it("shows cosign verify-attestation for the CycloneDX SBOM", () => {
    expect(text).toMatch(/cosign verify-attestation/);
    expect(text).toMatch(/cyclonedx/);
  });

  it("links to docs/OIDC-SETUP.md for signing identity context", () => {
    expect(text).toMatch(/OIDC-SETUP\.md/);
  });
});
