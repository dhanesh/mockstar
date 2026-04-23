#!/usr/bin/env bun
// Satisfies: RT-9 (standalone binary, 4 targets, <=150 MB each).
//
// Wraps `bun build --compile` with an explicit target matrix. Emits binaries
// into ./dist/ named `mockstar-<target>`. Each binary is asserted to be under
// the TN2-relaxed 150 MB ceiling at build time — a too-large binary fails loud.
//
// Usage:
//   bun run scripts/build-binaries.ts                 # all 4 targets
//   bun run scripts/build-binaries.ts --target=<name> # single target

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { $ } from 'bun';

// Canonical matrix — see docs/VERSIONING.md. Adding a target is a minor-version event.
const TARGETS = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-arm64',
  'bun-linux-x64',
] as const;

const SIZE_CEILING_BYTES = 150 * 1024 * 1024; // TN2 relaxed ceiling

type Target = (typeof TARGETS)[number];

function parseArgs(argv: readonly string[]): { targets: readonly Target[] } {
  const explicit = argv.find((a) => a.startsWith('--target='))?.slice('--target='.length);
  if (!explicit) return { targets: TARGETS };
  if (!TARGETS.includes(explicit as Target)) {
    throw new Error(`Unknown target: ${explicit}. Valid: ${TARGETS.join(', ')}`);
  }
  return { targets: [explicit as Target] };
}

async function build(target: Target): Promise<void> {
  const outfile = `dist/mockstar-${target}`;
  // SOURCE_DATE_EPOCH + pinned Bun (RT-1) together give reproducible bytes.
  const result = await $`bun build ./src/cli.ts --compile --target=${target} --outfile=${outfile}`
    .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`bun build --compile failed for ${target}: exit ${result.exitCode}`);
  }

  const size = statSync(resolve(outfile)).size;
  const mb = (size / 1024 / 1024).toFixed(1);
  if (size > SIZE_CEILING_BYTES) {
    throw new Error(
      `Binary ${outfile} is ${mb} MB — exceeds ${SIZE_CEILING_BYTES / 1024 / 1024} MB ceiling (T7, TN2). ` +
        'Either remove a dependency or revisit the ceiling in .manifold/distribution-packaging.json.',
    );
  }
  process.stdout.write(`  ${outfile}  ${mb.padStart(6)} MB  OK\n`);
}

async function main(): Promise<number> {
  const { targets } = parseArgs(process.argv.slice(2));
  process.stdout.write(`Building ${targets.length} target(s):\n`);
  for (const t of targets) {
    await build(t);
  }
  return 0;
}

// Direct invocation only.
void main().then((code) => {
  if (code !== 0) process.exit(code);
});
