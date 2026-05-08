// Satisfies: core static mocking (outcome)
// Satisfies: RT-1 (type-aware walker invocation), RT-2 (per-request factory closure materialisation),
//            TN8 (idHelpers built fresh per request → PRNG isolation across concurrent requests),
//            S4 (413 on exceeded body budget)
// Priority: binding (on the hot path)

import type { Context } from "hono";
import type { Entry } from "../core/config/schema.ts";
import type { CompiledResponse, TemplateContext } from "../core/templating/compiler.ts";
import { renderCompiledJson } from "../core/templating/compiler.ts";
import type { FakerInstance } from "../core/templating/faker.ts";
import { createIdHelpers, fnv1a } from "../core/templating/tier2/id.ts";
import type { Clock } from "../core/templating/tier2/now.ts";
import { RenderBudget, Tier2RenderError } from "../core/templating/tier2/walker.ts";

export interface StaticRenderInput {
  entry: Entry;
  compiled: CompiledResponse;
  ctx: Context;
  params: Record<string, string>;
  faker: FakerInstance;
  tenant: string;
  requestId: string;
  body: unknown;
  /** Injected clock — wall in prod, fixed-epoch in deterministic mode. */
  clock: Clock;
  /** Deterministic mode flag — when true, idHelpers use a seeded PRNG. */
  deterministic: boolean;
  /** Optional response-body byte cap. Defaults to RenderBudget's own default (1 MB). */
  maxResponseBytes?: number;
}

export async function renderStatic(input: StaticRenderInput): Promise<Response> {
  if (input.entry.response.kind !== "static") {
    throw new Error(`renderStatic called for non-static entry '${input.entry.id}'`);
  }
  const response = input.entry.response;

  // Delay handling — applied BEFORE templating to keep latency of actual body render tight.
  if (response.delay !== undefined) {
    await applyDelay(response.delay);
  }

  // Per-request idHelpers (TN8): fresh closure for every request, so seeded PRNG state never
  // leaks across concurrent handlers. Seed combines tenant + endpoint + requestId hash so two
  // replays of the same test produce byte-identical IDs.
  const idHelpers = createIdHelpers({
    deterministic: input.deterministic,
    tenant: input.tenant,
    endpoint: input.entry.id,
    requestCounter: fnv1a(input.requestId),
  });

  const templateCtx: TemplateContext = {
    faker: input.faker,
    tenant: input.tenant,
    requestId: input.requestId,
    clock: input.clock,
    idHelpers,
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
  try {
    if (input.compiled.bodyTemplate) {
      bodyOut = input.compiled.bodyTemplate.render(templateCtx);
    } else if (input.compiled.bodyJson !== null) {
      const budget = new RenderBudget({ maxBytes: input.maxResponseBytes });
      bodyOut = JSON.stringify(renderCompiledJson(input.compiled.bodyJson, templateCtx, budget));
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    } else {
      bodyOut = "";
    }
  } catch (err) {
    if (err instanceof Tier2RenderError) {
      return new Response(
        JSON.stringify({ error: err.code.toLowerCase(), message: err.message, mockId: input.entry.id }),
        { status: err.httpStatus, headers: { "content-type": "application/json" } },
      );
    }
    throw err;
  }

  return new Response(bodyOut, { status: response.status, headers });
}

async function applyDelay(spec: number | { min: number; max: number }): Promise<void> {
  const ms =
    typeof spec === "number" ? spec : spec.min + Math.floor(Math.random() * (spec.max - spec.min + 1));
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}
