// Satisfies: RT-6 (mockstar enhance), O3 (byte-identical re-runs), T7/T11/T12/T15 (idempotent),
//            TN7 (_mockstarGenerated boundary preserves user edits)
// Validates: B1, O3 — re-enhance is a no-op on unchanged input, and user edits outside the
//            _mockstarGenerated block survive re-runs.

import { describe, it, expect } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runEnhance } from '../src/features/enhance/index.ts';
import { GENERATED_KEY } from '../src/features/enhance/boundary.ts';

async function setup(content: unknown): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'tier2-enhance-'));
  const file = join(dir, 'fixture.json');
  await writeFile(file, JSON.stringify(content, null, 2) + '\n', 'utf-8');
  return { dir, file };
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>;
}

const FIXED_NOW = () => '2026-04-14T00:00:00.000Z';

describe('runEnhance — idempotency and boundary', () => {
  const literalFixture = {
    mocks: [{
      id: 'create-order',
      match: { method: 'POST', path: '/orders' },
      response: {
        kind: 'static',
        status: 200,
        body: {
          id: 'order_abc123XYZ456',
          customer_id: 'cust_DEF789GHI012',
          created_at: '2024-01-15T10:30:00Z',
          amount: 4200,
          description: 'literal kept as-is',
        },
      },
    }],
  };

  it('rewrites id-like and timestamp-like fields, records manifest under _mockstarGenerated', async () => {
    const { file } = await setup(literalFixture);
    const result = await runEnhance({ inputDir: await parentOf(file), now: FIXED_NOW });
    expect(result.filesScanned).toBe(1);
    expect(result.filesChanged).toBe(1);
    expect(result.rewrites).toBe(3);

    const after = await readJson(file);
    const body = (after.mocks as Array<{ response: { body: Record<string, unknown> } }>)[0]!.response.body;
    expect(body.id).toBe('{{id("order_", 12)}}');
    expect(body.customer_id).toBe('{{id("cust_", 12)}}');
    expect(body.created_at).toBe('{{now.iso}}');
    expect(body.amount).toBe(4200);
    expect(body.description).toBe('literal kept as-is');

    const manifest = after[GENERATED_KEY] as { version: number; entries: unknown[] };
    expect(manifest.version).toBe(1);
    expect(manifest.entries).toHaveLength(3);
  });

  it('is byte-identical on a second run (O3)', async () => {
    const { file } = await setup(literalFixture);
    const dir = await parentOf(file);
    await runEnhance({ inputDir: dir, now: FIXED_NOW });
    const firstBytes = await readFile(file, 'utf-8');
    await runEnhance({ inputDir: dir, now: FIXED_NOW });
    const secondBytes = await readFile(file, 'utf-8');
    expect(secondBytes).toBe(firstBytes);
  });

  it('preserves user edits outside the _mockstarGenerated boundary', async () => {
    const { file } = await setup(literalFixture);
    const dir = await parentOf(file);
    await runEnhance({ inputDir: dir, now: FIXED_NOW });

    // User adds a new mock by hand AFTER enhancement.
    const edited = await readJson(file);
    const mocks = edited.mocks as Array<Record<string, unknown>>;
    mocks.push({
      id: 'hand-authored',
      match: { method: 'GET', path: '/hand' },
      response: { kind: 'static', status: 200, body: { note: 'user added this' } },
    });
    await writeFile(file, JSON.stringify(edited, null, 2) + '\n', 'utf-8');

    await runEnhance({ inputDir: dir, now: FIXED_NOW });
    const final = await readJson(file);
    const finalMocks = final.mocks as Array<Record<string, unknown>>;
    expect(finalMocks).toHaveLength(2);
    expect(finalMocks[1]?.id).toBe('hand-authored');
    expect((finalMocks[1]?.response as { body: { note: string } }).body.note).toBe('user added this');
  });

  it('dry-run does not write to disk', async () => {
    const { file } = await setup(literalFixture);
    const dir = await parentOf(file);
    const before = await readFile(file, 'utf-8');
    const result = await runEnhance({ inputDir: dir, dryRun: true, now: FIXED_NOW });
    expect(result.filesChanged).toBe(1);
    expect(result.rewrites).toBe(3);
    const after = await readFile(file, 'utf-8');
    expect(after).toBe(before);
  });

  it('does not rewrite English-word fields that happen to end in "id" or "at" (REV-1)', async () => {
    // Regression test for code-review finding REV-1. Pre-fix, `endsWith("id")` and `endsWith("at")`
    // matched fields like `format`/`grid`/`paid`/`android` and silently corrupted their values.
    const { file } = await setup({
      mocks: [{
        id: 'negative-test',
        match: { method: 'GET', path: '/x' },
        response: {
          kind: 'static',
          status: 200,
          body: {
            grid: 'abc_0123456789',            // endsWith("id") + looksLikeIdValue — must NOT rewrite
            format: 1700000001,                 // endsWith("at") + > 1e9         — must NOT rewrite
            paid: 'abc_0123456789',             // endsWith("id") + looksLikeIdValue
            flat: '2024-01-15T10:30:00Z',       // endsWith("at") + ISO_RE
            android: 'xyz_0123456789',          // endsWith("id")
            void: 'abc_0123456789',             // endsWith("id")
            heat: 1700000001,                   // endsWith("at") + > 1e9
            chat: '2024-01-15T10:30:00Z',       // endsWith("at") + ISO_RE
          },
        },
      }],
    });
    const dir = await parentOf(file);
    const result = await runEnhance({ inputDir: dir, now: FIXED_NOW });
    expect(result.rewrites).toBe(0);
    const after = await readJson(file);
    const body = (after.mocks as Array<{ response: { body: Record<string, unknown> } }>)[0]!.response.body;
    expect(body.grid).toBe('abc_0123456789');
    expect(body.format).toBe(1700000001);
    expect(body.paid).toBe('abc_0123456789');
    expect(body.flat).toBe('2024-01-15T10:30:00Z');
    expect(body.android).toBe('xyz_0123456789');
    expect(body.void).toBe('abc_0123456789');
    expect(body.heat).toBe(1700000001);
    expect(body.chat).toBe('2024-01-15T10:30:00Z');
    expect(after[GENERATED_KEY]).toBeUndefined();
  });

  it('still rewrites camelCase id/timestamp fields via word-boundary detection', async () => {
    const { file } = await setup({
      mocks: [{
        id: 'camel-case',
        match: { method: 'POST', path: '/users' },
        response: {
          kind: 'static',
          status: 200,
          body: {
            userId: 'user_ABC123DEF456',
            orderId: 'order_GHI789JKL012',
            createdAt: '2024-01-15T10:30:00Z',
            updatedAt: 1700000001,
          },
        },
      }],
    });
    const dir = await parentOf(file);
    const result = await runEnhance({ inputDir: dir, now: FIXED_NOW });
    expect(result.rewrites).toBe(4);
    const after = await readJson(file);
    const body = (after.mocks as Array<{ response: { body: Record<string, unknown> } }>)[0]!.response.body;
    expect(body.userId).toBe('{{id("user_", 12)}}');
    expect(body.orderId).toBe('{{id("order_", 12)}}');
    expect(body.createdAt).toBe('{{now.iso}}');
    expect(body.updatedAt).toBe('{{now.unix}}');
  });

  it('preserves user edits to generated tokens and emits a drift warning (REV-2)', async () => {
    const { file } = await setup(literalFixture);
    const dir = await parentOf(file);
    await runEnhance({ inputDir: dir, now: FIXED_NOW });

    // User overwrites the generated token for `id` with a literal they prefer.
    const edited = await readJson(file);
    const bodyRef = (edited.mocks as Array<{ response: { body: Record<string, unknown> } }>)[0]!.response.body;
    bodyRef.id = 'order_HAND_WRITTEN_99';
    await writeFile(file, JSON.stringify(edited, null, 2) + '\n', 'utf-8');

    const result = await runEnhance({ inputDir: dir, now: FIXED_NOW });
    expect(result.warnings.some((w) => w.includes('user-drift') && w.includes('create-order.body.id'))).toBe(true);

    const final = await readJson(file);
    const finalBody = (final.mocks as Array<{ response: { body: Record<string, unknown> } }>)[0]!.response.body;
    // User's value must be preserved — not re-enhanced, not reverted to original literal.
    expect(finalBody.id).toBe('order_HAND_WRITTEN_99');
    // Other enhanced fields (not user-edited) remain as Tier 2 tokens.
    expect(finalBody.customer_id).toBe('{{id("cust_", 12)}}');
    expect(finalBody.created_at).toBe('{{now.iso}}');
  });

  it('ambiguous field values are left as literals (conservative heuristic)', async () => {
    const { file } = await setup({
      mocks: [{
        id: 'conservative',
        match: { method: 'GET', path: '/x' },
        response: {
          kind: 'static',
          status: 200,
          body: {
            short: 'abc',            // too short to look like an id
            number_field: 42,         // not an id-like name
            random_label: 'nothing-special-here',
          },
        },
      }],
    });
    const dir = await parentOf(file);
    const result = await runEnhance({ inputDir: dir, now: FIXED_NOW });
    expect(result.rewrites).toBe(0);
    expect(result.filesChanged).toBe(0);
    const after = await readJson(file);
    expect(after[GENERATED_KEY]).toBeUndefined();
  });
});

async function parentOf(file: string): Promise<string> {
  return file.slice(0, file.lastIndexOf('/'));
}

// Exercise mkdir to avoid the unused-import error.
void mkdir;
