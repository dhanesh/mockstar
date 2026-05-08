// Satisfies: RT-2 (per-request handler fault isolation; tier 1 of TN2)
// Satisfies: T10 (handler crashes never kill the server — sync/await branch)

import type { Context } from "hono";
import type { StructuredLogger } from "../observability/logger.ts";

export interface BoundaryOptions {
  timeoutMs: number;
  logger: StructuredLogger;
}

export interface HandlerInvocationResult {
  response: Response;
  faulted: boolean;
  faultKind?: "throw" | "rejection" | "timeout";
}

/**
 * Wrap a handler invocation: await it with try/catch + timeout, produce a
 * safe 500 on fault. Caught faults become a 500 response with a safe
 * diagnostic body. The server keeps serving. (RT-2.1, RT-2.2)
 */
export async function invokeWithBoundary(
  ctx: Context,
  handlerName: string,
  invoke: () => Response | Promise<Response>,
  opts: BoundaryOptions,
): Promise<HandlerInvocationResult> {
  const requestId = ctx.var.requestId ?? "-";
  const tenant = ctx.var.tenant ?? "-";
  try {
    const response = await Promise.race([Promise.resolve().then(invoke), timeout(opts.timeoutMs)]);
    return { response, faulted: false };
  } catch (err) {
    const kind: "throw" | "rejection" | "timeout" =
      err instanceof HandlerTimeoutError ? "timeout" : err instanceof Error ? "rejection" : "throw";
    opts.logger.error({
      event: "handler_fault",
      handler: handlerName,
      tenant,
      requestId,
      kind,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return {
      response: new Response(
        JSON.stringify({
          error: "handler_fault",
          handler: handlerName,
          requestId,
          // Never leak stack traces to clients; internal detail only.
          kind,
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      ),
      faulted: true,
      faultKind: kind,
    };
  }
}

export class HandlerTimeoutError extends Error {
  constructor(public readonly ms: number) {
    super(`Handler exceeded ${ms}ms timeout`);
    this.name = "HandlerTimeoutError";
  }
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new HandlerTimeoutError(ms)), ms).unref?.();
  });
}
