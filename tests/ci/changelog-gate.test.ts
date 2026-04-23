// Satisfies: RT-18 (CHANGELOG gate in release workflow).
//
// The release workflow's `preflight` job runs a grep against CHANGELOG.md that
// must match `## [<tag>]` — this test proves the gate is wired and the grep
// pattern is non-trivial (i.e. won't match any tag that happens to appear anywhere).

import { describe, expect, it } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..', '..');
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/release.yml'), 'utf8');

describe('RT-18: CHANGELOG gate', () => {
  // @constraint B4 — no release without a CHANGELOG entry
  it('release.yml preflight has a check-changelog step', () => {
    const preflight = workflow.split(/^\s{2}preflight:/m)[1]?.split(/^\s{2}\w/m)[0] ?? '';
    expect(preflight).toMatch(/check-changelog/);
    expect(preflight).toMatch(/CHANGELOG\.md/);
    expect(preflight).toMatch(/## \\\[/); // escaped regex for "## ["
  });

  it('CHANGELOG.md exists at repo root', () => {
    expect(existsSync(resolve(repoRoot, 'CHANGELOG.md'))).toBe(true);
  });

  it('gate uses a tag-specific pattern (not a bare tag prefix match)', () => {
    const preflight = workflow.split(/^\s{2}preflight:/m)[1]?.split(/^\s{2}\w/m)[0] ?? '';
    // Must anchor to line start and require the [version] header shape, not just "contains $TAG".
    // CHANGELOG headers follow Keep a Changelog convention (no leading `v`),
    // so the workflow strips the `v` before grepping.
    expect(preflight).toMatch(/grep -qE "\^## \\\[\$\{VERSION\}\\\]"/);
    expect(preflight).toMatch(/VERSION="\$\{TAG#v\}"/);
  });
});
