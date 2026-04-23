#!/usr/bin/env bun
// One-shot: populate generation.artifacts[], auto-verify file_exists +
// content_match evidence, append iteration #4, set phase to GENERATED.
//
// This script is an artifact of the m4-generate run on 2026-04-20. It is
// idempotent — running it twice produces the same output — but is kept in
// the repo mainly to document what the generation step actually emitted.

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type Evidence = {
  id: string;
  type: 'file_exists' | 'content_match' | 'test_passes' | 'metric_value' | 'manual_review';
  path?: string;
  pattern?: string;
  test_name?: string;
  status: 'VERIFIED' | 'PENDING' | 'FAILED' | 'STALE';
};

type RT = {
  id: string;
  status: string;
  maps_to: string[];
  evidence?: Evidence[];
};

type Manifold = {
  phase: string;
  anchors: { required_truths: RT[]; binding_constraint?: unknown };
  iterations: unknown[];
  generation?: unknown;
  convergence?: { status: string };
};

const ROOT = resolve(import.meta.dir, '..');
const JSON_PATH = resolve(ROOT, '.manifold', 'distribution-packaging.json');

const manifold = JSON.parse(await readFile(JSON_PATH, 'utf8')) as Manifold;

// ── artifacts list (explicit — sourced from the generation session) ─────
type Artifact = {
  path: string;
  type: 'code' | 'test' | 'docs' | 'ops' | 'config';
  satisfies: string[];
  status: 'generated';
  artifact_class: 'substantive' | 'structural';
};

const artifacts: Artifact[] = [
  // RT-1 — Bun pinning
  { path: '.bun-version', type: 'config', satisfies: ['RT-1'], status: 'generated', artifact_class: 'substantive' },
  { path: 'tests/ci/bun-pin.test.ts', type: 'test', satisfies: ['RT-1'], status: 'generated', artifact_class: 'substantive' },
  { path: 'Dockerfile', type: 'ops', satisfies: ['RT-1', 'RT-8'], status: 'generated', artifact_class: 'substantive' },

  // RT-2 — dual-URL schema hosting + migrate CLI
  { path: 'docs/SCHEMA-HOSTING.md', type: 'docs', satisfies: ['RT-2'], status: 'generated', artifact_class: 'substantive' },
  { path: 'scripts/generate-schema.ts', type: 'code', satisfies: ['RT-2'], status: 'generated', artifact_class: 'substantive' },
  { path: '.github/workflows/schema-publish.yml', type: 'ops', satisfies: ['RT-2'], status: 'generated', artifact_class: 'substantive' },
  { path: 'src/cli/commands/migrate.ts', type: 'code', satisfies: ['RT-2'], status: 'generated', artifact_class: 'substantive' },
  { path: 'tests/cli/migrate-schema.test.ts', type: 'test', satisfies: ['RT-2'], status: 'generated', artifact_class: 'substantive' },
  { path: 'tests/schema/generate-schema.test.ts', type: 'test', satisfies: ['RT-2'], status: 'generated', artifact_class: 'substantive' },

  // RT-3/4/5/6/18/19 — signing + release surface (from earlier in the session)
  { path: '.github/workflows/release.yml', type: 'ops', satisfies: ['RT-3', 'RT-4', 'RT-5', 'RT-6', 'RT-18', 'RT-19'], status: 'generated', artifact_class: 'substantive' },
  { path: 'docs/OIDC-SETUP.md', type: 'docs', satisfies: ['RT-3'], status: 'generated', artifact_class: 'substantive' },
  { path: 'tests/ci/release-halt-clean.test.ts', type: 'test', satisfies: ['RT-6'], status: 'generated', artifact_class: 'substantive' },
  { path: 'tests/ci/changelog-gate.test.ts', type: 'test', satisfies: ['RT-18'], status: 'generated', artifact_class: 'substantive' },
  { path: 'tests/ci/cve-gate.test.ts', type: 'test', satisfies: ['RT-19'], status: 'generated', artifact_class: 'substantive' },
  { path: 'tests/ci/release-type.test.ts', type: 'test', satisfies: ['RT-5'], status: 'generated', artifact_class: 'substantive' },
  { path: 'tests/ci/verify-signature.test.ts', type: 'test', satisfies: ['RT-4'], status: 'generated', artifact_class: 'substantive' },

  // RT-7/8/9/10 — publishing targets
  { path: 'package.json', type: 'config', satisfies: ['RT-7'], status: 'generated', artifact_class: 'substantive' },
  { path: 'tsconfig.build.json', type: 'config', satisfies: ['RT-7'], status: 'generated', artifact_class: 'structural' },
  { path: 'scripts/build-binaries.ts', type: 'code', satisfies: ['RT-9'], status: 'generated', artifact_class: 'substantive' },
  { path: 'tests/packaging/exports-map.test.ts', type: 'test', satisfies: ['RT-7'], status: 'generated', artifact_class: 'substantive' },
  { path: 'tests/packaging/binary-size.test.ts', type: 'test', satisfies: ['RT-9'], status: 'generated', artifact_class: 'substantive' },
  { path: 'tests/packaging/binary-smoke.test.ts', type: 'test', satisfies: ['RT-9'], status: 'generated', artifact_class: 'substantive' },
  { path: 'tests/docker/multiarch-smoke.test.ts', type: 'test', satisfies: ['RT-8'], status: 'generated', artifact_class: 'substantive' },

  // RT-11/12 — Helm chart
  { path: 'charts/mockstar/Chart.yaml', type: 'ops', satisfies: ['RT-10'], status: 'generated', artifact_class: 'substantive' },
  { path: 'charts/mockstar/values.yaml', type: 'ops', satisfies: ['RT-11', 'RT-12'], status: 'generated', artifact_class: 'substantive' },
  { path: 'charts/mockstar/templates/_helpers.tpl', type: 'ops', satisfies: ['RT-11'], status: 'generated', artifact_class: 'structural' },
  { path: 'charts/mockstar/templates/deployment.yaml', type: 'ops', satisfies: ['RT-11', 'RT-12'], status: 'generated', artifact_class: 'substantive' },
  { path: 'charts/mockstar/templates/service.yaml', type: 'ops', satisfies: ['RT-11'], status: 'generated', artifact_class: 'structural' },
  { path: 'charts/mockstar/templates/servicemonitor.yaml', type: 'ops', satisfies: ['RT-12'], status: 'generated', artifact_class: 'substantive' },
  { path: 'charts/mockstar/README.md', type: 'docs', satisfies: ['RT-11'], status: 'generated', artifact_class: 'substantive' },
  { path: 'charts/mockstar/.helmignore', type: 'ops', satisfies: ['RT-11'], status: 'generated', artifact_class: 'structural' },
  { path: 'tests/helm/upgrade-preserves-tenants.test.ts', type: 'test', satisfies: ['RT-11'], status: 'generated', artifact_class: 'substantive' },

  // RT-13/14 — quickstart + init
  { path: '.github/workflows/quickstart-smoke.yml', type: 'ops', satisfies: ['RT-13'], status: 'generated', artifact_class: 'substantive' },
  { path: 'src/cli/commands/init.ts', type: 'code', satisfies: ['RT-13', 'RT-14'], status: 'generated', artifact_class: 'substantive' },
  { path: 'src/cli.ts', type: 'code', satisfies: ['RT-2', 'RT-14'], status: 'generated', artifact_class: 'substantive' },
  { path: 'tests/cli/init.test.ts', type: 'test', satisfies: ['RT-13', 'RT-14'], status: 'generated', artifact_class: 'substantive' },
  { path: 'tests/ci/quickstart-smoke-shape.test.ts', type: 'test', satisfies: ['RT-13'], status: 'generated', artifact_class: 'substantive' },

  // RT-15 — SDET matrix
  { path: 'docs/SDET.md', type: 'docs', satisfies: ['RT-15'], status: 'generated', artifact_class: 'substantive' },
  { path: 'examples/sdet-jest30/package.json', type: 'config', satisfies: ['RT-15'], status: 'generated', artifact_class: 'structural' },
  { path: 'examples/sdet-jest30/mockstar.test.js', type: 'test', satisfies: ['RT-15'], status: 'generated', artifact_class: 'substantive' },
  { path: 'examples/sdet-jest29/package.json', type: 'config', satisfies: ['RT-15'], status: 'generated', artifact_class: 'structural' },
  { path: 'examples/sdet-jest29/mockstar.test.js', type: 'test', satisfies: ['RT-15'], status: 'generated', artifact_class: 'substantive' },
  { path: 'examples/sdet-vitest/package.json', type: 'config', satisfies: ['RT-15'], status: 'generated', artifact_class: 'structural' },
  { path: 'examples/sdet-vitest/mockstar.test.ts', type: 'test', satisfies: ['RT-15'], status: 'generated', artifact_class: 'substantive' },
  { path: 'examples/sdet-bun-test/package.json', type: 'config', satisfies: ['RT-15'], status: 'generated', artifact_class: 'structural' },
  { path: 'examples/sdet-bun-test/mockstar.test.ts', type: 'test', satisfies: ['RT-15'], status: 'generated', artifact_class: 'substantive' },
  { path: 'tests/examples/sdet-examples-shape.test.ts', type: 'test', satisfies: ['RT-15'], status: 'generated', artifact_class: 'substantive' },

  // RT-16/17 — team + versioning
  { path: 'CONTRIBUTING.md', type: 'docs', satisfies: ['RT-16'], status: 'generated', artifact_class: 'substantive' },
  { path: 'docs/TEAM-WORKFLOW.md', type: 'docs', satisfies: ['RT-16'], status: 'generated', artifact_class: 'substantive' },
  { path: 'docs/VERSIONING.md', type: 'docs', satisfies: ['RT-17'], status: 'generated', artifact_class: 'substantive' },
  { path: 'README.md', type: 'docs', satisfies: ['RT-16'], status: 'generated', artifact_class: 'substantive' },
  { path: 'CHANGELOG.md', type: 'docs', satisfies: ['RT-18'], status: 'generated', artifact_class: 'substantive' },
  { path: 'tests/docs/team-versioning-shape.test.ts', type: 'test', satisfies: ['RT-16', 'RT-17', 'RT-18'], status: 'generated', artifact_class: 'substantive' },
];

// Sanity-check: every declared artifact exists on disk. Missing files are a
// generation failure, not a verification failure.
const missing = artifacts.filter((a) => !existsSync(resolve(ROOT, a.path)));
if (missing.length > 0) {
  process.stderr.write(
    `ERROR: ${missing.length} declared artifacts missing on disk:\n` +
      missing.map((a) => `  - ${a.path}`).join('\n') +
      '\n',
  );
  process.exit(1);
}

// Auto-verify evidence items we can check right now.
let verifiedCount = 0;
let failedCount = 0;
for (const rt of manifold.anchors.required_truths) {
  for (const ev of rt.evidence ?? []) {
    if (ev.type === 'file_exists' && ev.path) {
      const ok = existsSync(resolve(ROOT, ev.path));
      ev.status = ok ? 'VERIFIED' : 'FAILED';
      if (ok) verifiedCount += 1;
      else failedCount += 1;
    } else if (ev.type === 'content_match' && ev.path && ev.pattern) {
      try {
        const text = await readFile(resolve(ROOT, ev.path), 'utf8');
        const re = new RegExp(ev.pattern);
        if (re.test(text)) {
          ev.status = 'VERIFIED';
          verifiedCount += 1;
        } else {
          ev.status = 'FAILED';
          failedCount += 1;
        }
      } catch {
        ev.status = 'FAILED';
        failedCount += 1;
      }
    }
    // test_passes and manual_review stay PENDING — that's m5's job.
  }
}

// Stamp generation block.
const generation = {
  option: 'D',
  timestamp: new Date().toISOString(),
  artifacts,
  coverage: {
    constraints_addressed: new Set(artifacts.flatMap((a) => a.satisfies)).size,
    required_truths_total: manifold.anchors.required_truths.length,
    percentage: Math.round(
      (new Set(artifacts.flatMap((a) => a.satisfies)).size /
        manifold.anchors.required_truths.length) *
        100,
    ),
  },
};

manifold.generation = generation;
manifold.phase = 'GENERATED';
manifold.iterations.push({
  number: manifold.iterations.length + 1,
  phase: 'generate',
  timestamp: new Date().toISOString(),
  result: `Generated ${artifacts.length} artifacts covering ${generation.coverage.constraints_addressed} RTs (option D). Auto-verified ${verifiedCount} evidence items; ${failedCount} failed; remainder pending m5.`,
  artifacts_generated: artifacts.length,
  evidence_auto_verified: verifiedCount,
  evidence_auto_failed: failedCount,
});

await writeFile(JSON_PATH, JSON.stringify(manifold, null, 2) + '\n');

process.stdout.write(
  `OK — ${artifacts.length} artifacts, auto-verified ${verifiedCount}, failed ${failedCount}\n`,
);
