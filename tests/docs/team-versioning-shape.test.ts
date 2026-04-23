// Satisfies: RT-16 (team/contributor docs exist and cross-link)
// Satisfies: RT-17 (versioning contract documented + aligns with RT-2 schema hosting)
// Satisfies: RT-18 (CHANGELOG has an entry for the rc.1 release tag)

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('RT-16/17/18: team + versioning docs', () => {
  it('CONTRIBUTING.md exists and mentions the .bun-version + bun test workflow', () => {
    expect(existsSync(resolve(ROOT, 'CONTRIBUTING.md'))).toBe(true);
    const text = read('CONTRIBUTING.md');
    expect(text).toMatch(/\.bun-version/);
    expect(text).toMatch(/bun test/);
    expect(text).toMatch(/bun run typecheck/);
  });

  it('docs/TEAM-WORKFLOW.md exists and documents the pre-release gate on SLSA', () => {
    expect(existsSync(resolve(ROOT, 'docs', 'TEAM-WORKFLOW.md'))).toBe(true);
    const text = read('docs/TEAM-WORKFLOW.md');
    expect(text).toMatch(/pre-release/i);
    expect(text).toMatch(/SLSA/);
    expect(text).toMatch(/halt-clean/);
  });

  it('docs/VERSIONING.md exists and is consistent with RT-2 (minor-URL immutability)', () => {
    expect(existsSync(resolve(ROOT, 'docs', 'VERSIONING.md'))).toBe(true);
    const text = read('docs/VERSIONING.md');
    expect(text.toLowerCase()).toContain('immutabil');
    expect(text).toContain('schemas.mockstar.dev');
    expect(text.toLowerCase()).toContain('deprecation');
  });

  it('README.md banner points at versioning doc + sdet docs', () => {
    const text = read('README.md');
    expect(text).toMatch(/docs\/VERSIONING\.md/);
    expect(text).toMatch(/docs\/SDET\.md/);
    expect(text).toMatch(/CONTRIBUTING\.md/);
  });

  it('CHANGELOG.md has a 0.1.0-rc.1 section (RT-18 gate would pass)', () => {
    const text = read('CHANGELOG.md');
    expect(text).toMatch(/^## \[0\.1\.0-rc\.1\]/m);
  });
});
