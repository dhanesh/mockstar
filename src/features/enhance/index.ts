// Satisfies: RT-6 (mockstar enhance), T7/T11/T12/T15/O3 (idempotent + respects user edits),
//            TN6 (spec-aware + heuristic fallback), TN7 (_mockstarGenerated boundary)
// Priority: binding — enhancer's idempotency is load-bearing

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { loadSpec, type ParsedSpec } from '../spec/index.ts';
import { decideRewrite, type EnhanceHint } from './field-mapping.ts';
import {
  GENERATED_VERSION,
  clearManifest,
  readManifest,
  writeManifest,
  type GeneratedEntry,
} from './boundary.ts';

export interface EnhanceOptions {
  /** Directory containing Mockstar mock files (JSON). Walked non-recursively. */
  inputDir: string;
  /** Optional spec file to harvest field-name hints from (per TN6). */
  specPath?: string;
  /** Dry run: print diff without writing. */
  dryRun?: boolean;
  /** Fixed timestamp for `enhancedAt` — used by tests to make byte-identity assertions possible. */
  now?: () => string;
  /** When true, override an existing manifest's provenance; otherwise we preserve `enhancedAt`
      for unchanged files so re-runs are byte-identical (O3). */
  forceRefreshTimestamp?: boolean;
}

export interface EnhanceResult {
  filesScanned: number;
  filesChanged: number;
  rewrites: number;
  warnings: string[];
}

interface Mock {
  id: string;
  match?: unknown;
  response?: {
    kind?: string;
    body?: unknown;
  };
}

export async function runEnhance(opts: EnhanceOptions): Promise<EnhanceResult> {
  const result: EnhanceResult = { filesScanned: 0, filesChanged: 0, rewrites: 0, warnings: [] };
  const spec = opts.specPath ? await loadSpec(opts.specPath) : null;
  if (opts.specPath && !spec) result.warnings.push(`spec at ${opts.specPath} could not be parsed`);

  const files = await listMockFiles(opts.inputDir);
  for (const file of files) {
    result.filesScanned++;
    const text = await readFile(file, 'utf-8');
    const raw = JSON.parse(text) as Record<string, unknown>;
    const before = canonicalJSON(raw);

    await enhanceFile(raw, file, spec, result, opts);

    const after = canonicalJSON(raw);
    if (before !== after) {
      result.filesChanged++;
      if (!opts.dryRun) {
        await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
      }
    }
  }
  return result;
}

// --- internals ---------------------------------------------------------------

async function listMockFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  return names.filter((n) => n.endsWith('.json')).map((n) => join(dir, n));
}

async function enhanceFile(
  raw: Record<string, unknown>,
  filePath: string,
  spec: ParsedSpec | null,
  result: EnhanceResult,
  opts: EnhanceOptions,
): Promise<void> {
  const prior = readManifest(raw);
  // Drift-detection (REV-2): paths where user has edited the enhancer's token. We neither restore
  // the original nor re-enhance — the user has taken ownership of that position.
  const userOwnedPaths = new Set<string>();

  // Step 1 — restore originals from prior manifest (if any) so re-enhance starts from a clean base.
  // This keeps rewrites idempotent (O3) without clobbering user edits on non-enhanced siblings.
  if (prior) {
    for (const entry of prior.entries) {
      const currentValue = getEntryValue(raw, entry);
      if (currentValue !== entry.token) {
        // User has edited the field we previously enhanced. Preserve their value and skip
        // re-enhancement for this path on this run.
        result.warnings.push(
          `user-drift at ${entry.entry}.${entry.path}: manifest expected token ${entry.token}, ` +
            `file has ${JSON.stringify(currentValue)}. Preserving user edit; skipping re-enhance for this path.`,
        );
        userOwnedPaths.add(`${entry.entry}|${entry.path}`);
        continue;
      }
      restoreOriginalAt(raw, entry);
    }
    clearManifest(raw);
  }

  // Step 2 — apply heuristics to every mock's response.body.
  const entries: GeneratedEntry[] = [];
  const mocks = Array.isArray(raw.mocks) ? raw.mocks as Mock[] : [];
  for (const mock of mocks) {
    if (!mock?.response || mock.response.kind !== 'static') continue;
    const hint: EnhanceHint = {
      providerTag: spec?.providerTag ?? inferProviderFromPath(filePath),
      knownFieldNames: spec?.fieldsByEndpoint.get(methodPathKey(mock)),
    };
    const skipPath = (path: string[]): boolean =>
      userOwnedPaths.has(`${mock.id}|${path.join('.')}`);
    walkAndRewrite(
      mock.response,
      ['body'],
      hint,
      (path, token, original) => {
        entries.push({ entry: mock.id, path: path.join('.'), token, original });
        result.rewrites++;
      },
      skipPath,
    );
  }

  // Step 3 — write back the manifest if any rewrites happened OR a prior manifest existed.
  if (entries.length > 0 || prior) {
    const enhancedAt = prior && !opts.forceRefreshTimestamp && entries.length === prior.entries.length
      ? prior.enhancedAt
      : (opts.now ?? defaultNow)();
    writeManifest(raw, {
      version: GENERATED_VERSION,
      enhancedAt,
      entries,
      providerTag: spec?.providerTag ?? null,
    });
  }

}

function walkAndRewrite(
  root: Record<string, unknown> | unknown,
  path: string[],
  hint: EnhanceHint,
  onRewrite: (path: string[], token: string, original: unknown) => void,
  skip?: (path: string[]) => boolean,
): void {
  const current = getAt(root, path);
  if (current === null || current === undefined) return;
  if (Array.isArray(current)) {
    for (let i = 0; i < current.length; i++) {
      walkAndRewrite(root, [...path, String(i)], hint, onRewrite, skip);
    }
    return;
  }
  if (typeof current !== 'object') return;
  for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
    const childPath = [...path, key];
    if (value !== null && typeof value === 'object') {
      walkAndRewrite(root, childPath, hint, onRewrite, skip);
      continue;
    }
    if (skip?.(childPath)) continue;
    const rewrite = decideRewrite(key, value, hint);
    if (rewrite) {
      const original = (current as Record<string, unknown>)[key];
      (current as Record<string, unknown>)[key] = rewrite.token;
      onRewrite(childPath, rewrite.token, original);
    }
  }
}

function getAt(root: unknown, path: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const seg of path) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const idx = Number.parseInt(seg, 10);
      cursor = Number.isNaN(idx) ? undefined : cursor[idx];
      continue;
    }
    if (typeof cursor === 'object') {
      cursor = (cursor as Record<string, unknown>)[seg];
      continue;
    }
    return undefined;
  }
  return cursor;
}

function setAt(root: unknown, path: readonly string[], value: unknown): void {
  if (path.length === 0) return;
  let cursor: unknown = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    if (Array.isArray(cursor)) {
      const idx = Number.parseInt(seg, 10);
      cursor = Number.isNaN(idx) ? undefined : cursor[idx];
    } else if (typeof cursor === 'object' && cursor !== null) {
      cursor = (cursor as Record<string, unknown>)[seg];
    } else {
      return;
    }
  }
  const lastSeg = path[path.length - 1]!;
  if (Array.isArray(cursor)) {
    const idx = Number.parseInt(lastSeg, 10);
    if (!Number.isNaN(idx)) cursor[idx] = value;
  } else if (typeof cursor === 'object' && cursor !== null) {
    (cursor as Record<string, unknown>)[lastSeg] = value;
  }
}

function restoreOriginalAt(raw: Record<string, unknown>, entry: GeneratedEntry): void {
  const mock = Array.isArray(raw.mocks)
    ? (raw.mocks as Mock[]).find((m) => m.id === entry.entry)
    : undefined;
  if (!mock?.response) return;
  setAt(mock.response, entry.path.split('.'), entry.original);
}

function getEntryValue(raw: Record<string, unknown>, entry: GeneratedEntry): unknown {
  const mock = Array.isArray(raw.mocks)
    ? (raw.mocks as Mock[]).find((m) => m.id === entry.entry)
    : undefined;
  if (!mock?.response) return undefined;
  return getAt(mock.response, entry.path.split('.'));
}

function methodPathKey(mock: Mock): string {
  const match = mock.match as { method?: string; path?: string } | undefined;
  return `${(match?.method ?? 'GET').toUpperCase()} ${match?.path ?? ''}`;
}

function inferProviderFromPath(filePath: string): string | null {
  // Generic folder-tag extractor: the parent-dir name becomes the provider tag. No hard-coded
  // provider list — per RT-9 / TN5 the runtime has ZERO provider-name awareness. Folder
  // organisation is the only channel through which a fixture library can self-label.
  const parent = basename(dirname(filePath));
  if (!parent || parent === '.' || parent === 'mocks' || parent === 'default') return null;
  return parent.toLowerCase();
}

function defaultNow(): string {
  return new Date().toISOString();
}

/** Canonical JSON for change detection — key order preserved via Object.keys() insertion order. */
function canonicalJSON(obj: unknown): string {
  return JSON.stringify(obj);
}
