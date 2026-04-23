// Satisfies: RT-5 (release-type detection) + TN1 (SLSA on stable only).
//
// Unit-tests the regex used by the `preflight` job to detect pre-release tags.
// The workflow's inline shell uses `[[ $TAG =~ -(alpha|beta|rc)\. ]]`; this
// test replicates that logic against representative tags.

import { describe, expect, it } from 'bun:test';

function isPrerelease(tag: string): boolean {
  // Mirror of the bash regex in release.yml's preflight.detect step.
  return /-(alpha|beta|rc)\./.test(tag);
}

describe('RT-5: release-type detection', () => {
  // @constraint S3 — SLSA gates on stable-only
  const cases: Array<[string, boolean]> = [
    ['v0.1.0', false],
    ['v0.2.3', false],
    ['v1.0.0', false],
    ['v0.1.0-rc.1', true],
    ['v0.1.0-beta.2', true],
    ['v0.1.0-alpha.7', true],
    ['v0.1.0-rc', false], // not matching the `.N` shape — treated as stable by design
    ['v0.1.0-dev', false], // ad-hoc suffix, treated as stable
  ];

  for (const [tag, expected] of cases) {
    it(`${tag} → ${expected ? 'pre-release' : 'stable'}`, () => {
      expect(isPrerelease(tag)).toBe(expected);
    });
  }

  it('SLSA job in release.yml is gated on is_stable', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const yml = readFileSync(
      resolve(import.meta.dir, '..', '..', '.github/workflows/release.yml'),
      'utf8',
    );
    // The slsa-provenance job must check the preflight output.
    expect(yml).toMatch(/slsa-provenance:[\s\S]*if:[\s\S]*is_stable\s*==\s*'true'/);
  });
});
