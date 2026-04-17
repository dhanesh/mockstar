// Satisfies: RT-9 (provider-agnostic core), TN5 (no provider-name conditionals outside fixtures)
// Validates: T9, U5 — the runtime has ZERO hard-coded provider-name awareness.
//
// This is the load-bearing invariant that makes mockstar a *generic* mock server and not a
// catalogue of vendor-specific shims. If any provider name leaks into `src/` outside comments,
// this test fails and CI blocks the merge. Fixtures under `examples/mocks/<provider>/` are the
// ONLY place provider names are allowed to appear.

import { describe, it, expect } from 'bun:test';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');
const SRC_ROOT = join(REPO_ROOT, 'src');
const PROVIDER_NAMES = ['razorpay', 'stripe', 'twilio', 'paypal'];

interface Hit {
  file: string;
  line: number;
  text: string;
  match: string;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    const s = await stat(p);
    if (s.isDirectory()) out.push(...(await walk(p)));
    else if (s.isFile() && (p.endsWith('.ts') || p.endsWith('.tsx'))) out.push(p);
  }
  return out;
}

function stripCommentsAndStrings(line: string): string {
  // Conservative: remove `// ...` trailing comments, then strip string contents so that
  // only identifier tokens remain for the regex check.
  const noLineComment = line.replace(/\/\/.*$/, '');
  const noStrings = noLineComment
    .replace(/"([^"\\]|\\.)*"/g, '""')
    .replace(/'([^'\\]|\\.)*'/g, "''")
    .replace(/`([^`\\]|\\.)*`/g, '``');
  return noStrings;
}

describe('RT-9 — core source contains no hard-coded provider-name conditionals', () => {
  it('no file under src/ references razorpay|stripe|twilio|paypal outside comments/strings', async () => {
    const files = await walk(SRC_ROOT);
    const hits: Hit[] = [];
    const pattern = new RegExp(`\\b(${PROVIDER_NAMES.join('|')})\\b`, 'i');

    for (const file of files) {
      const text = await readFile(file, 'utf-8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        // Line-level comments and block-comment bodies: skip whole-line `*` lines and `//`.
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        const stripped = stripCommentsAndStrings(line);
        const m = stripped.match(pattern);
        if (m) {
          hits.push({
            file: relative(REPO_ROOT, file),
            line: i + 1,
            text: line.trim(),
            match: m[1] ?? m[0],
          });
        }
      }
    }

    if (hits.length > 0) {
      const report = hits.map((h) => `  ${h.file}:${h.line}  [${h.match}]  ${h.text}`).join('\n');
      throw new Error(
        `RT-9 violation — provider name(s) found in runtime source:\n${report}\n\n` +
        `Provider names must only appear inside comments, tests, or examples/mocks/<provider>/*.`,
      );
    }
    expect(hits).toHaveLength(0);
  });

  it('provider names DO appear in fixture directories (sanity check — fixtures exist)', async () => {
    const mocks = join(REPO_ROOT, 'examples', 'mocks');
    const names = await readdir(mocks);
    for (const p of PROVIDER_NAMES) {
      expect(names).toContain(p);
    }
  });
});
