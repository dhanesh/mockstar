// Satisfies: RT-9 (provider-agnostic core), TN5 (no provider-name conditionals outside fixtures)
// Validates: T9, U5 — the runtime has ZERO hard-coded provider-name awareness.
//
// This is the load-bearing invariant that makes mockstar a *generic* mock server and not a
// catalogue of vendor-specific shims. If any provider name leaks into `src/` outside comments,
// this test fails and CI blocks the merge. Fixtures under `examples/mocks/<provider>/` are the
// ONLY place provider names are allowed to appear.

import { describe, expect, it } from "bun:test";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const SRC_ROOT = join(REPO_ROOT, "src");
const PROVIDER_NAMES = ["razorpay", "stripe", "twilio", "paypal"];

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
    else if (s.isFile() && (p.endsWith(".ts") || p.endsWith(".tsx"))) out.push(p);
  }
  return out;
}

// Matches a block comment that opens AND closes on the same line — `/* ... */` or the
// JSDoc form `/** ... */`. Deliberately does not attempt to track state across lines: a
// multi-line block comment's continuation lines are still handled by the whole-line `*`
// skip below, and its opening line (bare `/**` with no trailing text) never contains a
// provider name to strip in the first place.
const SINGLE_LINE_BLOCK_COMMENT_RE = /\/\*\*?[^*]*\*+(?:[^/*][^*]*\*+)*\//g;

function stripCommentsAndStrings(line: string): string {
  // Conservative: remove single-line `/** ... */` / `/* ... */` block comments, then
  // trailing `// ...` comments, then strip string contents so that only identifier tokens
  // remain for the regex check.
  const noBlockComments = line.replace(SINGLE_LINE_BLOCK_COMMENT_RE, "");
  const noLineComment = noBlockComments.replace(/\/\/.*$/, "");
  const noStrings = noLineComment
    .replace(/"([^"\\]|\\.)*"/g, '""')
    .replace(/'([^'\\]|\\.)*'/g, "''")
    .replace(/`([^`\\]|\\.)*`/g, "``");
  return noStrings;
}

const PROVIDER_PATTERN = new RegExp(`\\b(${PROVIDER_NAMES.join("|")})\\b`, "i");

/**
 * Scan `text` (the contents of one file) for bare-code provider-name occurrences, per the
 * same rules the RT-9 guard enforces: `//` line comments, whole-line `*` continuation lines
 * (multi-line block-comment bodies), and single-line `/* ... *​/` / `/** ... *​/` block
 * comments are all exempt; everything else is checked.
 */
function scanForProviderHits(
  text: string,
  pattern: RegExp = PROVIDER_PATTERN,
): Array<{ line: number; text: string; match: string }> {
  const hits: Array<{ line: number; text: string; match: string }> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Line-level comments and block-comment bodies: skip whole-line `*` lines and `//`.
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    const stripped = stripCommentsAndStrings(line);
    const m = stripped.match(pattern);
    if (m) {
      hits.push({ line: i + 1, text: line.trim(), match: m[1] ?? m[0] });
    }
  }
  return hits;
}

describe("RT-9 — core source contains no hard-coded provider-name conditionals", () => {
  it("no file under src/ references razorpay|stripe|twilio|paypal outside comments/strings", async () => {
    const files = await walk(SRC_ROOT);
    const hits: Hit[] = [];

    for (const file of files) {
      const text = await readFile(file, "utf-8");
      for (const h of scanForProviderHits(text)) {
        hits.push({ file: relative(REPO_ROOT, file), ...h });
      }
    }

    if (hits.length > 0) {
      const report = hits.map((h) => `  ${h.file}:${h.line}  [${h.match}]  ${h.text}`).join("\n");
      throw new Error(
        `RT-9 violation — provider name(s) found in runtime source:\n${report}\n\nProvider names must only appear inside comments, tests, or examples/mocks/<provider>/*.`,
      );
    }
    expect(hits).toHaveLength(0);
  });

  it("comment parser: a single-line /** ... */ block comment is not flagged", () => {
    const fixture = [
      "const x = 1;",
      "/** This mirrors Stripe's t=...,v1=... construction. */",
      "const y = /* Razorpay-shaped */ 2;",
    ].join("\n");
    expect(scanForProviderHits(fixture)).toHaveLength(0);
  });

  it("comment parser: still catches a genuine bare-code occurrence", () => {
    const fixture = ["const provider = stripe;"].join("\n");
    const hits = scanForProviderHits(fixture);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.match.toLowerCase()).toBe("stripe");
  });

  it("provider names DO appear in fixture directories (sanity check — fixtures exist)", async () => {
    const mocks = join(REPO_ROOT, "examples", "mocks");
    const names = await readdir(mocks);
    for (const p of PROVIDER_NAMES) {
      expect(names).toContain(p);
    }
  });
});
