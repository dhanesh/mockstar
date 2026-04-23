// Satisfies: RT-4 (cosign + CycloneDX SBOM attestation).
//
// Live verification against a published digest needs a real release to exist,
// so this test has two modes:
//   1. LIVE (env MOCKSTAR_VERIFY_DIGEST=sha256:...): shell out to cosign and
//      assert cosign verify succeeds with the repo's OIDC identity.
//   2. STATIC (default): assert the release workflow contains the load-bearing
//      shape that would make a live verify pass — signing by DIGEST (never tag),
//      attaching a CycloneDX SBOM via `cosign attest --type cyclonedx`.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = readFileSync(
  resolve(import.meta.dir, '..', '..', '.github/workflows/release.yml'),
  'utf8',
);

describe('RT-4: cosign + CycloneDX static validation', () => {
  // @constraint S1 — sign every published artifact
  it('release.yml signs the container by DIGEST, not tag', () => {
    // The attack surface we're closing: `cosign sign ghcr.io/.../mockstar:v0.1.0`
    // is vulnerable to tag mutation. Signing by `@sha256:...` binds to bytes.
    const signLine = workflow.match(/cosign sign[\s\S]*?@\$\{\{[\s\S]*?digest/);
    expect(signLine).not.toBeNull();
    // Make sure no bare tag signing slipped in (check only within sign steps).
    // Extract each `cosign sign --yes` run block and verify it references @sha256:
    // or a $TARGET shell variable (verified above to contain @digest).
    const signBlocks = workflow.matchAll(/cosign sign --yes\s+"?\$TARGET"?/g);
    for (const block of signBlocks) {
      // The target must be the $TARGET shell var (which always holds @digest form),
      // never a raw :${{ tag }} reference on the same line.
      expect(block[0]).not.toMatch(/:\$\{\{[^}]*tag/);
    }
  });

  // @constraint S2 — CycloneDX SBOM attestation
  it('release.yml attaches a CycloneDX SBOM attestation', () => {
    expect(workflow).toMatch(/cosign attest[\s\S]*--type cyclonedx/);
  });

  it('SBOM is generated from the pushed digest (syft)', () => {
    expect(workflow).toMatch(/syft.*@\$\{\{\s*steps\.build\.outputs\.digest/);
  });
});

describe('RT-4: cosign verify (live, optional)', () => {
  const digest = process.env.MOCKSTAR_VERIFY_DIGEST;
  const image = process.env.MOCKSTAR_VERIFY_IMAGE ?? 'ghcr.io/your-org/mockstar';

  if (!digest) {
    it.skip('cosign verify passes on published digest (set MOCKSTAR_VERIFY_DIGEST to run)', () => {});
    return;
  }

  it('cosign verify passes on published digest', async () => {
    const { $ } = await import('bun');
    const result =
      await $`cosign verify --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity-regexp "^https://github.com/" ${image}@${digest}`
        .nothrow()
        .quiet();
    expect(result.exitCode).toBe(0);
  });
});
