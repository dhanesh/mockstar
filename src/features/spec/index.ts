// Satisfies: RT-6 (enhancer re-parses source spec when provided), TN6 resolution
//            (shared spec parser module used by both importer and enhancer — not the importer's
//             private logic, per TN6's segmentation)
// Priority: structural — the enhancer calls this only when --spec is supplied

import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export type SpecFormat = "openapi" | "postman" | "unknown";

export interface ParsedSpec {
  format: SpecFormat;
  /** Flat index: method+path → property names (best-effort name-hint source). */
  fieldsByEndpoint: Map<string, Set<string>>;
  /** Detected provider tag (used ONLY for fixture organisation — never leaks into core code). */
  providerTag: string | null;
  /** Source spec for consumers that want deeper schema inspection. */
  raw: unknown;
}

/**
 * Load and index a spec file. Intentionally lightweight: the enhancer uses this only to harvest
 * FIELD NAMES for its name-match heuristic. Complex schema traversal / ref resolution is out of
 * scope — the enhancer falls back to literal field-value inspection if a name isn't in the index.
 */
export async function loadSpec(path: string): Promise<ParsedSpec> {
  const text = await readFile(path, "utf-8");
  const raw = extname(path) === ".json" ? JSON.parse(text) : parseYaml(text);
  if (isOpenApi(raw)) return indexOpenApi(raw);
  if (isPostman(raw)) return indexPostman(raw);
  return { format: "unknown", fieldsByEndpoint: new Map(), providerTag: null, raw };
}

function parseYaml(_text: string): unknown {
  // Minimal stub: YAML support can be added behind a flag. For now, the importer already
  // converts YAML → JSON on the way in, so enhance-time is JSON-first.
  throw new Error("YAML spec parsing not yet supported; convert to JSON first.");
}

function isOpenApi(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && ("openapi" in raw || "swagger" in raw) && "paths" in raw;
}

function isPostman(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && "info" in raw && "item" in raw;
}

function indexOpenApi(raw: object): ParsedSpec {
  const fieldsByEndpoint = new Map<string, Set<string>>();
  const paths = (raw as Record<string, unknown>).paths as Record<string, unknown> | undefined;
  if (paths) {
    for (const [path, ops] of Object.entries(paths)) {
      if (typeof ops !== "object" || ops === null) continue;
      for (const [method, opSpec] of Object.entries(ops as Record<string, unknown>)) {
        const key = `${method.toUpperCase()} ${path}`;
        const fields = collectFieldNames(opSpec);
        if (fields.size > 0) fieldsByEndpoint.set(key, fields);
      }
    }
  }
  return { format: "openapi", fieldsByEndpoint, providerTag: detectProviderTag(raw), raw };
}

function indexPostman(raw: object): ParsedSpec {
  // Postman has a nested folder structure; this surface-level index is a starting point.
  return { format: "postman", fieldsByEndpoint: new Map(), providerTag: detectProviderTag(raw), raw };
}

function collectFieldNames(node: unknown, out: Set<string> = new Set(), depth: number = 0): Set<string> {
  if (depth > 8 || node === null || typeof node !== "object") return out;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "properties" && typeof v === "object" && v !== null) {
      for (const propName of Object.keys(v as object)) out.add(propName);
    }
    collectFieldNames(v, out, depth + 1);
  }
  return out;
}

function detectProviderTag(raw: unknown): string | null {
  // Generic: normalise `info.title` to a slug. The enhancer passes this tag through as a hint;
  // nothing in core branches on provider identity (RT-9 / TN5).
  if (typeof raw !== "object" || raw === null) return null;
  const info = (raw as Record<string, unknown>).info as Record<string, unknown> | undefined;
  const title = typeof info?.title === "string" ? info.title : "";
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.length > 0 ? slug : null;
}
