// Satisfies: U5 (OpenAPI 3.x offline converter)
// Satisfies: RT-8.3 (external $ref disabled), RT-8.4 (URL-encoded path params)
// Addresses: CVE-2026-39885 class of attacks

import { validateUpstreamUrl } from '../url-validator.ts';

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
  constructor(message: string, public readonly detail?: unknown) {
    super(message);
    this.name = 'OpenApiImportError';
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
  if (!doc || typeof doc !== 'object') {
    throw new OpenApiImportError('OpenAPI document root must be an object');
  }

  // 1. Scan for external $refs and bail before we process anything else (RT-8.3).
  const refs = findRefs(doc);
  for (const ref of refs) {
    if (!ref.startsWith('#')) {
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
          allowedSchemes: ['https', 'http'],
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
    if (typeof pathItem !== 'object' || pathItem === null) continue;
    for (const [method, op] of Object.entries(pathItem)) {
      if (!/^(get|post|put|patch|delete|head|options)$/i.test(method)) continue;
      const operation = op as OperationObject;
      const { status, example, contentType } = pickExemplar(operation);
      const entry = {
        id: operation.operationId ?? `${method.toUpperCase()}-${safePath}`,
        match: {
          method: method.toUpperCase(),
          path: safePath,
          priority: 0,
        },
        response: {
          kind: 'static',
          status,
          headers: { 'content-type': contentType },
          body: example ?? { note: `Mock for ${method.toUpperCase()} ${safePath}` },
        },
      };
      entries.push(entry);
    }
  }

  return entries;
}

function findRefs(value: unknown, acc: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return acc;
  if (Array.isArray(value)) {
    for (const v of value) findRefs(v, acc);
    return acc;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === '$ref' && typeof v === 'string') acc.push(v);
    findRefs(v, acc);
  }
  return acc;
}

function pickExemplar(op: OperationObject): { status: number; example: unknown; contentType: string } {
  const responses = op.responses ?? {};
  const preferred = ['200', '201', '202', '204', 'default'];
  for (const code of preferred) {
    const res = responses[code];
    if (!res) continue;
    const status = code === 'default' ? 200 : Number.parseInt(code, 10);
    const content = res.content ?? {};
    for (const ct of ['application/json', 'application/problem+json', 'text/plain', ...Object.keys(content)]) {
      const media = content[ct];
      if (!media) continue;
      const example = media.example ?? firstExample(media.examples);
      return { status, example, contentType: ct };
    }
  }
  return { status: 200, example: null, contentType: 'application/json' };
}

function firstExample(examples: Record<string, { value?: unknown }> | undefined): unknown {
  if (!examples) return undefined;
  for (const v of Object.values(examples)) if (v.value !== undefined) return v.value;
  return undefined;
}

/**
 * OpenAPI uses `{name}` path params; we rewrite to `:name` for Hono-style
 * matching. Path segments are URL-encoded to prevent traversal attacks
 * (RT-8.4, addresses FastMCP CVE-2026-32871).
 */
export function encodePathTemplate(openapiPath: string): string {
  const parts = openapiPath.split('/').map((seg) => {
    if (seg === '') return seg;
    const paramMatch = seg.match(/^\{([^}]+)\}$/);
    if (paramMatch?.[1]) {
      const name = paramMatch[1].replace(/[^a-zA-Z0-9_]/g, '_');
      return `:${name}`;
    }
    // Literal segment — encode to prevent `..` or slashes sneaking through.
    return encodeURIComponent(seg);
  });
  const joined = parts.join('/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}
