// Satisfies: U5 (OpenAPI offline converter — subprocess entry)
// Satisfies: RT-8.5 (importer runs as isolated Bun subprocess; no server state access)
//
// Usage (from CLI):
//   bun run src/features/openapi/importer.ts <spec-path> <out-dir> [--allow-private]
//
// This module is invoked via Bun.spawn from the CLI so a malicious OpenAPI
// document cannot touch the running server's memory or dependencies. It
// only parses JSON/YAML input, emits JSON output to stdout or files, and
// exits.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { convertOpenApi, OpenApiImportError } from "./converter.ts";

export interface ImporterArgs {
  specPath: string;
  outDir: string;
  allowPrivateUpstreams?: boolean;
  tenantName?: string;
}

export async function runImporter(args: ImporterArgs): Promise<{ entryCount: number; outFile: string }> {
  const raw = await readFile(resolve(args.specPath), "utf8");
  const doc = parseSpec(raw, extname(args.specPath));
  const entries = convertOpenApi(doc, { allowPrivateUpstreams: args.allowPrivateUpstreams });

  const outDir = resolve(args.outDir, args.tenantName ?? "default");
  await mkdir(outDir, { recursive: true });
  const outFile = resolve(outDir, "openapi.json");
  await writeFile(outFile, JSON.stringify({ mocks: entries }, null, 2) + "\n", "utf8");
  return { entryCount: entries.length, outFile };
}

function parseSpec(raw: string, ext: string): unknown {
  if (ext === ".json") return JSON.parse(raw);
  if (ext === ".yaml" || ext === ".yml") {
    // Bun ships a YAML parser; in case this runs on older Bun, fall back to JSON.
    // Users with YAML specs can convert to JSON first via `bunx js-yaml`.
    try {
      // @ts-expect-error — Bun may expose YAML natively in future; fall back safely.
      if (typeof Bun !== "undefined" && Bun.YAML?.parse) return Bun.YAML.parse(raw);
    } catch {
      // ignore, fall through
    }
    throw new OpenApiImportError(
      "YAML parsing not available in this Bun version. Convert to JSON first (bunx js-yaml spec.yaml > spec.json).",
    );
  }
  throw new OpenApiImportError(`Unsupported spec extension: ${ext}`);
}

// Entry point when executed directly via Bun.spawn.
// import.meta.main is a Bun feature; guarded for type-checkers.
// biome-ignore lint/suspicious/noExplicitAny: import.meta.main is Bun-only
const isMain = (import.meta as any).main === true;
if (isMain) {
  const [specPath, outDir, ...rest] = process.argv.slice(2);
  if (!specPath || !outDir) {
    process.stderr.write("usage: openapi-importer <spec> <out-dir> [--allow-private] [--tenant=<name>]\n");
    process.exit(2);
  }
  const allowPrivate = rest.includes("--allow-private");
  const tenantArg = rest.find((r) => r.startsWith("--tenant="));
  const tenantName = tenantArg ? tenantArg.slice("--tenant=".length) : undefined;
  runImporter({ specPath, outDir, allowPrivateUpstreams: allowPrivate, tenantName })
    .then((r) => {
      process.stdout.write(`${JSON.stringify(r)}\n`);
      process.exit(0);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`openapi-importer: ${msg}\n`);
      process.exit(1);
    });
}
