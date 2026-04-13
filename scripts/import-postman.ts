#!/usr/bin/env bun
// scripts/import-postman.ts
//
// Convert a Postman collection (v2.1) into Mockstar JSON config.
// One file per top-level folder; each request becomes a mock entry whose body
// is the first 2xx example from the request's response[] array.
//
// Usage:
//   bun run scripts/import-postman.ts <collection.json> <out-dir> [--tenant=<name>]
//
// Output:
//   <out-dir>/<tenant>/<folder-slug>.json   (one per top-level folder)
//
// Notes:
// - Path is taken from request.url.path (segments) so {{var}} substitutions in
//   raw URLs become literal mockstar paths. {{petId}} → :petId.
// - Postman variables in the URL ({{baseUrl}}, {{API_Key_ID}}) are stripped from
//   the path: only the resource portion is mocked.
// - Bodies preserve the example's status code (defaults to 200).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

interface PostmanItem {
  name: string;
  item?: PostmanItem[];
  request?: PostmanRequest;
  response?: PostmanResponse[];
}

interface PostmanRequest {
  method: string;
  url?: { raw?: string; path?: (string | { value: string })[] };
  body?: { mode?: string; raw?: string };
}

interface PostmanResponse {
  name?: string;
  status?: string;
  code?: number;
  body?: string;
  header?: Array<{ key: string; value: string }>;
  _postman_previewlanguage?: string;
}

interface MockEntry {
  id: string;
  match: { method: string; path: string; priority?: number };
  response: { kind: 'static'; status: number; headers?: Record<string, string>; body?: unknown };
}

interface ConvertSummary {
  filesWritten: string[];
  totalMocks: number;
  skipped: Array<{ name: string; reason: string }>;
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';

function pathFromRequest(req: PostmanRequest): string | null {
  const segments = req.url?.path;
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const cleaned: string[] = [];
  for (const seg of segments) {
    const value = typeof seg === 'string' ? seg : seg?.value ?? '';
    if (!value) continue;
    // Postman path variables: ":id" → mockstar's ":id" (already compatible).
    // Curly-brace vars: "{{baseUrl}}" → skip; "{id}" → ":id".
    if (/^\{\{.*\}\}$/.test(value)) continue;
    if (/^\{[^{}]+\}$/.test(value)) {
      cleaned.push(`:${value.slice(1, -1).replace(/[^a-zA-Z0-9_]/g, '_')}`);
    } else if (value.startsWith(':')) {
      cleaned.push(value);
    } else {
      cleaned.push(value);
    }
  }
  return cleaned.length === 0 ? '/' : `/${cleaned.join('/')}`;
}

function pickExample(responses: PostmanResponse[] | undefined): { body: unknown; status: number; contentType: string } | null {
  if (!responses || responses.length === 0) return null;
  // Prefer the first 2xx, fall back to whatever exists.
  const ranked = [...responses].sort((a, b) => {
    const aOk = (a.code ?? 0) >= 200 && (a.code ?? 0) < 300 ? 0 : 1;
    const bOk = (b.code ?? 0) >= 200 && (b.code ?? 0) < 300 ? 0 : 1;
    return aOk - bOk;
  });
  const ex = ranked[0];
  if (!ex) return null;
  const ctHeader = ex.header?.find((h) => h.key.toLowerCase() === 'content-type')?.value;
  const contentType = ctHeader ?? 'application/json';
  let body: unknown = ex.body ?? null;
  // If it looks like JSON, parse so the body is rendered structurally.
  if (typeof body === 'string' && (contentType.includes('json') || ex._postman_previewlanguage === 'json')) {
    try {
      body = JSON.parse(body);
    } catch {
      // leave as raw string
    }
  }
  return { body, status: ex.code ?? 200, contentType };
}

interface FlatRequest {
  topFolder: string;
  fullName: string;
  request: PostmanRequest;
  response?: PostmanResponse[];
}

function flatten(items: PostmanItem[], topFolder: string, parentPath: string[], out: FlatRequest[]): void {
  for (const it of items) {
    const here = [...parentPath, it.name];
    if (it.request) {
      out.push({ topFolder, fullName: here.join(' / '), request: it.request, response: it.response });
    }
    if (Array.isArray(it.item)) {
      flatten(it.item, topFolder, here, out);
    }
  }
}

async function convert(collectionPath: string, outDir: string, tenant: string): Promise<ConvertSummary> {
  const raw = await readFile(collectionPath, 'utf8');
  const doc = JSON.parse(raw) as { info?: { name?: string }; item?: PostmanItem[] };
  if (!Array.isArray(doc.item)) throw new Error('Collection has no top-level items');

  const tenantDir = resolve(outDir, tenant);
  await mkdir(tenantDir, { recursive: true });

  const summary: ConvertSummary = { filesWritten: [], totalMocks: 0, skipped: [] };
  const usedIds = new Set<string>();

  for (const top of doc.item) {
    const folderName = top.name ?? 'unnamed';
    const flat: FlatRequest[] = [];
    if (top.request) {
      // Top-level item is itself a request (rare but valid).
      flat.push({ topFolder: folderName, fullName: top.name, request: top.request, response: top.response });
    }
    if (Array.isArray(top.item)) {
      flatten(top.item, folderName, [], flat);
    }

    const mocks: MockEntry[] = [];
    for (const r of flat) {
      const path = pathFromRequest(r.request);
      if (!path) {
        summary.skipped.push({ name: r.fullName, reason: 'no resolvable path' });
        continue;
      }
      const ex = pickExample(r.response);
      if (!ex) {
        summary.skipped.push({ name: r.fullName, reason: 'no response example' });
        continue;
      }
      const baseId = `${r.request.method}-${slug(r.fullName)}`;
      let id = baseId;
      let n = 2;
      while (usedIds.has(id)) {
        id = `${baseId}-${n++}`;
      }
      usedIds.add(id);

      mocks.push({
        id,
        match: { method: r.request.method.toUpperCase(), path, priority: 0 },
        response: {
          kind: 'static',
          status: ex.status,
          headers: { 'content-type': ex.contentType },
          body: ex.body,
        },
      });
    }

    if (mocks.length === 0) continue;
    const fileName = `${slug(folderName)}.json`;
    const outPath = resolve(tenantDir, fileName);
    await writeFile(outPath, JSON.stringify({ mocks }, null, 2) + '\n');
    summary.filesWritten.push(outPath);
    summary.totalMocks += mocks.length;
  }

  return summary;
}

// Entry
// biome-ignore lint/suspicious/noExplicitAny: import.meta.main is Bun-only
const isMain = (import.meta as any).main === true;
if (isMain) {
  const [collectionPath, outDir, ...rest] = process.argv.slice(2);
  if (!collectionPath || !outDir) {
    process.stderr.write('usage: bun run scripts/import-postman.ts <collection.json> <out-dir> [--tenant=<name>]\n');
    process.exit(2);
  }
  const tenantArg = rest.find((a) => a.startsWith('--tenant='));
  const tenant = tenantArg ? tenantArg.slice('--tenant='.length) : 'default';
  convert(collectionPath, outDir, tenant)
    .then((s) => {
      process.stdout.write(`Wrote ${s.filesWritten.length} files (${s.totalMocks} mocks) to ${resolve(outDir, tenant)}/\n`);
      if (s.skipped.length > 0) {
        process.stdout.write(`Skipped ${s.skipped.length} requests:\n`);
        for (const sk of s.skipped.slice(0, 10)) {
          process.stdout.write(`  - ${sk.name} (${sk.reason})\n`);
        }
        if (s.skipped.length > 10) process.stdout.write(`  ... and ${s.skipped.length - 10} more\n`);
      }
    })
    .catch((err: unknown) => {
      process.stderr.write(`import-postman: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}

export { convert, type ConvertSummary };
