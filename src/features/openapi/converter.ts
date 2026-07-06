// Satisfies: U5 (OpenAPI 3.x offline converter)
// Satisfies: RT-8.3 (external $ref disabled), RT-8.4 (URL-encoded path params)
// Addresses: CVE-2026-39885 class of attacks

import { validateUpstreamUrl } from "../url-validator.ts";

export interface OpenApiDoc {
  openapi?: string;
  swagger?: string;
  servers?: Array<{ url: string; description?: string }>;
  paths?: Record<string, PathItemObject>;
  components?: unknown;
}

interface PathItemObject {
  [method: string]: OperationObject | unknown;
}

interface OperationObject {
  operationId?: string;
  responses?: Record<string, ResponseObject>;
  parameters?: Array<{ name: string; in: string; schema?: unknown; example?: unknown }>;
}

interface ResponseObject {
  description?: string;
  content?: Record<string, MediaTypeObject>;
}

interface MediaTypeObject {
  example?: unknown;
  examples?: Record<string, { value?: unknown }>;
  schema?: unknown;
}

export class OpenApiImportError extends Error {
  constructor(
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "OpenApiImportError";
  }
}

export interface ConvertOptions {
  allowPrivateUpstreams?: boolean;
}

/**
 * Convert an OpenAPI document into Mockstar mock entries. Rejects any input
 * that contains external `$ref`s ($ref values starting with '#' are allowed;
 * anything else is a security error — CVE-2026-39885 class).
 */
export function convertOpenApi(doc: unknown, opts: ConvertOptions = {}): Array<Record<string, unknown>> {
  if (!doc || typeof doc !== "object") {
    throw new OpenApiImportError("OpenAPI document root must be an object");
  }

  // 1. Scan for external $refs and bail before we process anything else (RT-8.3).
  const refs = findRefs(doc);
  for (const ref of refs) {
    if (!ref.startsWith("#")) {
      throw new OpenApiImportError(
        `External $ref rejected: '${ref}'. Only in-document ($ref starting with '#') references are permitted.`,
        { ref },
      );
    }
  }

  const openapi = doc as OpenApiDoc;

  // 2. Validate server URLs (RT-8, S6). Relative URLs (no scheme) have no host —
  //    no SSRF risk, just a path prefix the OpenAPI spec author chose. Skip those.
  if (openapi.servers) {
    for (const server of openapi.servers) {
      if (!/^[a-z][a-z0-9+.-]*:/i.test(server.url)) continue; // relative URL, safe
      try {
        validateUpstreamUrl(server.url, {
          allowedSchemes: ["https", "http"],
          allowPrivateUpstreams: opts.allowPrivateUpstreams,
        });
      } catch (err) {
        throw new OpenApiImportError(
          `Server URL rejected: '${server.url}' — ${err instanceof Error ? err.message : String(err)}`,
          { server: server.url },
        );
      }
    }
  }

  // 3. Walk paths → operations → responses, emit mock entries.
  const entries: Array<Record<string, unknown>> = [];
  for (const [path, pathItem] of Object.entries(openapi.paths ?? {})) {
    const safePath = encodePathTemplate(path);
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, op] of Object.entries(pathItem)) {
      if (!/^(get|post|put|patch|delete|head|options)$/i.test(method)) continue;
      const operation = op as OperationObject;
      const { status, example, contentType } = pickExemplar(operation, doc as OpenApiDoc);
      const entry = {
        id: operation.operationId ?? `${method.toUpperCase()}-${safePath}`,
        match: {
          method: method.toUpperCase(),
          path: safePath,
          priority: 0,
        },
        response: {
          kind: "static",
          status,
          headers: { "content-type": contentType },
          body: example ?? { note: `Mock for ${method.toUpperCase()} ${safePath}` },
        },
      };
      entries.push(entry);
    }
  }

  return entries;
}

function findRefs(value: unknown, acc: string[] = []): string[] {
  if (value === null || typeof value !== "object") return acc;
  if (Array.isArray(value)) {
    for (const v of value) findRefs(v, acc);
    return acc;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "$ref" && typeof v === "string") acc.push(v);
    findRefs(v, acc);
  }
  return acc;
}

function pickExemplar(
  op: OperationObject,
  doc: OpenApiDoc,
): { status: number; example: unknown; contentType: string } {
  const responses = op.responses ?? {};
  const preferred = ["200", "201", "202", "204", "default"];
  for (const code of preferred) {
    const res = responses[code];
    if (!res) continue;
    const status = code === "default" ? 200 : Number.parseInt(code, 10);
    const content = res.content ?? {};
    for (const ct of [
      "application/json",
      "application/problem+json",
      "text/plain",
      ...Object.keys(content),
    ]) {
      const media = content[ct];
      if (!media) continue;
      // Precedence: explicit media example → named example → schema-derived body.
      // Schema synthesis is what makes imported mocks shaped like the real API instead
      // of a `{note:…}` placeholder; `enhance` later tokenises the literal values.
      const example =
        media.example ??
        firstExample(media.examples) ??
        (media.schema !== undefined ? synthesizeFromSchema(media.schema, doc) : undefined);
      return { status, example, contentType: ct };
    }
  }
  return { status: 200, example: null, contentType: "application/json" };
}

function firstExample(examples: Record<string, { value?: unknown }> | undefined): unknown {
  if (!examples) return undefined;
  for (const v of Object.values(examples)) if (v.value !== undefined) return v.value;
  return undefined;
}

/**
 * Best-effort synthesis of a representative body from a JSON Schema so imported mocks
 * are shaped like the real API. Bounded (depth + a per-branch $ref-visited set) so
 * self-referential schemas terminate. Emits literal placeholders; `mockstar enhance`
 * upgrades them to Tier 2 tokens. Only in-document `#/…` $refs are followed (external
 * refs are already rejected upstream — RT-8.3).
 */
export function synthesizeFromSchema(
  schema: unknown,
  doc: OpenApiDoc,
  seen: ReadonlySet<string> = new Set(),
  depth = 0,
): unknown {
  if (depth > 8 || schema === null || typeof schema !== "object") return null;
  const s = schema as Record<string, unknown>;

  // Resolve an in-document $ref, guarding against cycles.
  if (typeof s.$ref === "string") {
    if (seen.has(s.$ref)) return null; // cycle — stop here
    const resolved = resolveRef(s.$ref, doc);
    if (resolved === undefined) return null;
    return synthesizeFromSchema(resolved, doc, new Set(seen).add(s.$ref), depth + 1);
  }

  // Explicit hints win, in order.
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];

  // Composition.
  if (Array.isArray(s.allOf)) {
    const merged: Record<string, unknown> = {};
    for (const sub of s.allOf) {
      const part = synthesizeFromSchema(sub, doc, seen, depth + 1);
      if (part && typeof part === "object" && !Array.isArray(part)) Object.assign(merged, part);
    }
    return merged;
  }
  const oneOf = s.oneOf ?? s.anyOf;
  if (Array.isArray(oneOf) && oneOf.length > 0) {
    return synthesizeFromSchema(oneOf[0], doc, seen, depth + 1);
  }

  const type = Array.isArray(s.type) ? s.type[0] : s.type;

  if (type === "object" || s.properties) {
    const out: Record<string, unknown> = {};
    const props = (s.properties ?? {}) as Record<string, unknown>;
    for (const [key, propSchema] of Object.entries(props)) {
      out[key] = synthesizeFromSchema(propSchema, doc, seen, depth + 1);
    }
    return out;
  }
  if (type === "array") {
    const item = s.items !== undefined ? synthesizeFromSchema(s.items, doc, seen, depth + 1) : null;
    return item === null ? [] : [item];
  }
  if (type === "string") return placeholderForString(typeof s.format === "string" ? s.format : "");
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return true;
  if (type === "null") return null;
  return null;
}

function placeholderForString(format: string): string {
  switch (format) {
    case "date-time":
      return "1970-01-01T00:00:00Z";
    case "date":
      return "1970-01-01";
    case "uuid":
      return "00000000-0000-0000-0000-000000000000";
    case "email":
      return "user@example.com";
    case "uri":
    case "url":
      return "https://example.com";
    case "byte":
    case "binary":
      return "";
    default:
      return "string";
  }
}

/** Resolve an in-document JSON-pointer `#/a/b/c` against the OpenAPI doc. */
function resolveRef(ref: string, doc: OpenApiDoc): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = doc;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * OpenAPI uses `{name}` path params; we rewrite to `:name` for Hono-style
 * matching. Path segments are URL-encoded to prevent traversal attacks
 * (RT-8.4, addresses FastMCP CVE-2026-32871).
 */
export function encodePathTemplate(openapiPath: string): string {
  const parts = openapiPath.split("/").map((seg) => {
    if (seg === "") return seg;
    // A segment that CONTAINS one or more `{param}` tokens becomes a single
    // whole-segment `:param`. mockstar's path-trie only treats a whole segment as a
    // parameter (no partial-segment params), so `{api}.json` → `:api` (captures e.g.
    // `2.0.json`) and `{a}-{b}` → `:a`. Collapsing to the FIRST param name is correct:
    // the slot matches any real value, whereas URL-encoding the braces (`%7Bapi%7D.json`)
    // matches no real request. Names are cosmetic in the trie.
    const firstParam = seg.match(/\{([^}]+)\}/);
    if (firstParam?.[1]) {
      const name = firstParam[1].replace(/[^a-zA-Z0-9_]/g, "_");
      return `:${name}`;
    }
    // Literal segment — encode to prevent `..` or slashes sneaking through.
    return encodeURIComponent(seg);
  });
  const joined = parts.join("/");
  return joined.startsWith("/") ? joined : `/${joined}`;
}
