// Satisfies: RT-2 (mockstar migrate --schema — rewrites $schema URL)
//
// Rewrites the `$schema` field in every `*.json` under a directory, bumping
// it from one minor URL to another. Does NOT touch any other field. Per
// docs/SCHEMA-HOSTING.md, patch-level upgrades never need this command —
// only minor bumps do.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SCHEMA_HOST = 'https://schemas.mockstar.dev';

export interface MigrateOptions {
  readonly dir: string;
  readonly from: string; // e.g. "v0.1"
  readonly to: string; // e.g. "v0.2"
  readonly dryRun: boolean;
}

export interface MigrateResult {
  readonly filesScanned: number;
  readonly filesChanged: number;
  readonly mismatched: readonly string[]; // files whose $schema points at an unexpected URL
}

function minorUrl(minor: string): string {
  return `${SCHEMA_HOST}/${minor}/mock.json`;
}

async function* walkJson(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walkJson(full);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      yield full;
    }
  }
}

export async function runMigrateSchema(options: MigrateOptions): Promise<MigrateResult> {
  const fromUrl = minorUrl(options.from);
  const toUrl = minorUrl(options.to);
  const root = resolve(options.dir);

  let scanned = 0;
  let changed = 0;
  const mismatched: string[] = [];

  for await (const path of walkJson(root)) {
    scanned += 1;
    const text = await readFile(path, 'utf8');
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      continue; // Not a JSON we care about.
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) continue;
    const record = doc as Record<string, unknown>;
    const current = record.$schema;
    if (typeof current !== 'string') continue;

    // Only touch schema URLs that live under schemas.mockstar.dev; leave
    // unrelated $schema fields (e.g. OpenAPI schemas) alone.
    if (!current.startsWith(SCHEMA_HOST)) continue;

    if (current === toUrl) continue; // already at target
    if (current !== fromUrl) {
      mismatched.push(path);
      continue;
    }

    record.$schema = toUrl;
    changed += 1;
    if (!options.dryRun) {
      const trailingNewline = text.endsWith('\n') ? '\n' : '';
      await writeFile(path, `${JSON.stringify(record, null, 2)}${trailingNewline}`);
    }
  }

  return { filesScanned: scanned, filesChanged: changed, mismatched };
}
