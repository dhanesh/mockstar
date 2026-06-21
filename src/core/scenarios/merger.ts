// Satisfies: RT-6 (response merger — static partial override, dynamic/passthrough self-contained)
// Satisfies: U2 (partial response override — absent scenario fields inherit from default)
// Satisfies: TN1 (partition: static inherits; dynamic/passthrough must be self-contained)
// Satisfies: T1 (single Tier 2 walker pass — merged result goes through walker exactly once)
// Satisfies: T5 (Tier 2 tokens supported in scenario bodies — rendered via same walker pass)

import type { Context } from "hono";
import type { Entry } from "../config/schema.ts";
import type { CompiledResponse, TemplateContext } from "../templating/compiler.ts";
import { renderCompiledJson } from "../templating/compiler.ts";
import type { FakerInstance } from "../templating/faker.ts";
import { createIdHelpers, fnv1a } from "../templating/tier2/id.ts";
import type { Clock } from "../templating/tier2/now.ts";
import { RenderBudget, Tier2RenderError } from "../templating/tier2/walker.ts";
import type { CompiledScenario, CompiledScenarioResponse } from "./evaluator.ts";

export interface ScenarioRenderInput {
  status: number;
  headers: ReadonlyMap<string, import("../templating/compiler.ts").CompiledTemplate>;
  bodyTemplate: import("../templating/compiler.ts").CompiledTemplate | null;
  bodyJson: import("../templating/compiler.ts").CompiledJsonValue | null;
  delay?: number | { min: number; max: number };
}

// Merge a matched scenario over the compiled default response for static entries (U2).
// Scenario fields override; absent fields inherit from the default.
export function mergeStaticResponse(
  defaultEntry: Entry & {
    response: { kind: "static"; status: number; delay?: number | { min: number; max: number } };
  },
  defaultCompiled: CompiledResponse,
  scenario: CompiledScenario,
): ScenarioRenderInput {
  const resp: CompiledScenarioResponse = scenario.response;
  const headers = new Map(defaultCompiled.headers);
  if (resp.headers) for (const [k, v] of resp.headers) headers.set(k, v);
  return {
    status: resp.status ?? defaultEntry.response.status,
    headers,
    bodyTemplate:
      resp.bodyTemplate !== undefined ? (resp.bodyTemplate ?? null) : defaultCompiled.bodyTemplate,
    bodyJson: resp.bodyJson !== undefined ? (resp.bodyJson ?? null) : defaultCompiled.bodyJson,
    delay: resp.delay ?? defaultEntry.response.delay,
  };
}

// For dynamic/passthrough entries: scenario response is self-contained (TN1 resolution).
// Validated complete at config-load by MockEntry.superRefine.
export function scenarioResponseForNonStatic(scenario: CompiledScenario): ScenarioRenderInput {
  const resp: CompiledScenarioResponse = scenario.response;
  if (resp.status === undefined) {
    throw new Error(
      `scenario '${scenario.id}': non-static scenario response missing status (should have been caught by schema validation)`,
    );
  }
  return {
    status: resp.status,
    headers: resp.headers ?? new Map(),
    bodyTemplate: resp.bodyTemplate ?? null,
    bodyJson: resp.bodyJson ?? null,
    delay: resp.delay,
  };
}

export interface ScenarioRenderOpts {
  faker: FakerInstance;
  clock: Clock;
  deterministic: boolean;
  tenant: string;
  requestId: string;
  entryId: string;
  ctx: Context;
  params: Record<string, string>;
  body: unknown;
  maxResponseBytes?: number;
}

async function applyDelay(spec: number | { min: number; max: number }): Promise<void> {
  const ms =
    typeof spec === "number" ? spec : spec.min + Math.floor(Math.random() * (spec.max - spec.min + 1));
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

/**
 * Render a merged scenario response through the Tier 2 walker exactly once (T1).
 * Type-preservation and token expansion behave identically to renderStatic.
 */
export async function renderScenario(
  merged: ScenarioRenderInput,
  opts: ScenarioRenderOpts,
): Promise<Response> {
  if (merged.delay !== undefined) {
    await applyDelay(merged.delay);
  }

  const idHelpers = createIdHelpers({
    deterministic: opts.deterministic,
    tenant: opts.tenant,
    endpoint: opts.entryId,
    requestCounter: fnv1a(opts.requestId),
  });

  const templateCtx: TemplateContext = {
    faker: opts.faker,
    tenant: opts.tenant,
    requestId: opts.requestId,
    clock: opts.clock,
    idHelpers,
    request: {
      method: opts.ctx.req.method,
      path: opts.ctx.req.path,
      query: Object.fromEntries(new URL(opts.ctx.req.url).searchParams),
      headers: Object.fromEntries(opts.ctx.req.raw.headers.entries()),
      body: opts.body,
      params: opts.params,
    },
  };

  const headers = new Headers();
  for (const [k, tpl] of merged.headers) {
    headers.set(k, tpl.render(templateCtx));
  }

  let bodyOut: string;
  try {
    if (merged.bodyTemplate) {
      bodyOut = merged.bodyTemplate.render(templateCtx);
    } else if (merged.bodyJson !== null) {
      const budget = new RenderBudget({ maxBytes: opts.maxResponseBytes });
      bodyOut = JSON.stringify(renderCompiledJson(merged.bodyJson, templateCtx, budget));
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    } else {
      bodyOut = "";
    }
  } catch (err) {
    if (err instanceof Tier2RenderError) {
      return new Response(
        JSON.stringify({ error: err.code.toLowerCase(), message: err.message, mockId: opts.entryId }),
        { status: err.httpStatus, headers: { "content-type": "application/json" } },
      );
    }
    throw err;
  }

  return new Response(bodyOut, { status: merged.status, headers });
}
