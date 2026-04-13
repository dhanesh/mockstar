// Satisfies: core static mocking (outcome)
// Priority: binding (on the hot path)

import type { Context } from 'hono';
import type { Entry } from '../core/config/schema.ts';
import type { CompiledResponse, TemplateContext } from '../core/templating/compiler.ts';
import { renderCompiledJson } from '../core/templating/compiler.ts';
import type { FakerInstance } from '../core/templating/faker.ts';

export interface StaticRenderInput {
  entry: Entry;
  compiled: CompiledResponse;
  ctx: Context;
  params: Record<string, string>;
  faker: FakerInstance;
  tenant: string;
  requestId: string;
  body: unknown;
}

export async function renderStatic(input: StaticRenderInput): Promise<Response> {
  if (input.entry.response.kind !== 'static') {
    throw new Error(`renderStatic called for non-static entry '${input.entry.id}'`);
  }
  const response = input.entry.response;

  // Delay handling — applied BEFORE templating to keep latency of actual body render tight.
  if (response.delay !== undefined) {
    await applyDelay(response.delay);
  }

  const templateCtx: TemplateContext = {
    faker: input.faker,
    tenant: input.tenant,
    requestId: input.requestId,
    request: {
      method: input.ctx.req.method,
      path: input.ctx.req.path,
      query: Object.fromEntries(new URL(input.ctx.req.url).searchParams),
      headers: Object.fromEntries(input.ctx.req.raw.headers.entries()),
      body: input.body,
      params: input.params,
    },
  };

  // Render headers
  const headers = new Headers();
  for (const [k, tpl] of input.compiled.headers) {
    headers.set(k, tpl.render(templateCtx));
  }

  // Render body. Both paths share the same op-sequence interpreter, so faker(args) works
  // identically for whole-string templates and string leaves inside JSON objects (F3 fix).
  let bodyOut: string;
  if (input.compiled.bodyTemplate) {
    bodyOut = input.compiled.bodyTemplate.render(templateCtx);
  } else if (input.compiled.bodyJson !== null) {
    bodyOut = JSON.stringify(renderCompiledJson(input.compiled.bodyJson, templateCtx));
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  } else {
    bodyOut = '';
  }

  return new Response(bodyOut, { status: response.status, headers });
}

async function applyDelay(spec: number | { min: number; max: number }): Promise<void> {
  const ms = typeof spec === 'number' ? spec : spec.min + Math.floor(Math.random() * (spec.max - spec.min + 1));
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}
