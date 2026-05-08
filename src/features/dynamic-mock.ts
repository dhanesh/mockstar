// Satisfies: dynamic mocking via named JS handlers (outcome, T5)
// Traces to: RT-1 (registry), RT-2 (error boundary on invocation)

import type { Context } from "hono";
import type { Entry } from "../core/config/schema.ts";
import type { HandlerRegistry } from "../core/handlers/index.ts";
import type { FakerInstance } from "../core/templating/faker.ts";
import { invokeWithBoundary, type BoundaryOptions } from "../core/errors/index.ts";

export interface DynamicInput {
  entry: Entry;
  ctx: Context;
  registry: HandlerRegistry;
  tenant: string;
  requestId: string;
  faker: FakerInstance;
  boundary: BoundaryOptions;
}

export async function renderDynamic(input: DynamicInput): Promise<Response> {
  if (input.entry.response.kind !== "dynamic") {
    throw new Error(`renderDynamic called for non-dynamic entry '${input.entry.id}'`);
  }
  const handler = input.registry.get(input.entry.response.handler);
  // Should be unreachable post-boot because RT-1.3 cross-check ran at config load,
  // but defensive 500 keeps server alive if registry was manipulated at runtime.
  if (!handler) {
    input.boundary.logger.error({
      event: "handler_missing_at_runtime",
      handler: input.entry.response.handler,
      entryId: input.entry.id,
      tenant: input.tenant,
      requestId: input.requestId,
    });
    return new Response(JSON.stringify({ error: "handler_missing", handler: input.entry.response.handler }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const result = await invokeWithBoundary(
    input.ctx,
    input.entry.response.handler,
    () =>
      handler(input.ctx, {
        tenant: input.tenant,
        requestId: input.requestId,
        faker: {
          uuid: (): string => input.faker.uuid(),
          email: (): string => input.faker.email(),
          name: (): string => input.faker.name(),
          integer: (min, max): number => input.faker.integer(min, max),
          pick: <T>(items: readonly T[]): T => input.faker.pick(items),
        },
      }),
    input.boundary,
  );
  return result.response;
}
