// Satisfies: S5 — per-tenant request body size cap, enforced on the stream itself.
// Closes: #33 (chunked-encoding bypass of the Content-Length fast path).

import type { Context } from "hono";

/**
 * S5 / #33: splice a byte-counting `TransformStream` in front of a request body so an
 * oversized body is refused WHILE STREAMING — never by trusting `Content-Length` (a
 * chunked request carries none) and never by buffering the whole body first and
 * measuring after. The capped stream is swapped into `ctx.req.raw` before anything
 * reads it, so every consumer downstream (Hono's `.text()`/`.json()` body cache, or a
 * raw `.arrayBuffer()` read for pass-through forwarding) reads through the same cap.
 *
 * Once the running total exceeds `maxBodyBytes` the stream is errored, which aborts the
 * read immediately — the remainder of an oversized body is never pulled off the wire
 * into memory.
 *
 * Shared by both consumers of the request body so the cap can't drift out of sync
 * between them:
 *  - `safeParseBody` (src/server.ts) — the JSON path, cap applied before `.text()`/`.json()`.
 *  - `renderPassThrough` (src/features/pass-through.ts) — the pass-through forwarding
 *    path, cap applied before `.arrayBuffer()`. Content-type is irrelevant here: a
 *    non-JSON body is never routed through the JSON path's cap at all (it early-returns
 *    before this function is even called), so pass-through forwarding is the only
 *    remaining place a chunked, oversized, non-JSON body would otherwise be buffered
 *    unbounded.
 *
 * No-op (returns a predicate that always reports `false`) when there is no body, or when
 * the body has already been fully consumed by an earlier call (`bodyUsed`) — that's the
 * signal a prior caller (the JSON path) already decided the outcome for this request, and
 * calling this again must not disturb that. In that case a caller's own subsequent read
 * behaves exactly as it did before this cap existed (typically an "already used" error),
 * which is intentional: this function only ever ADDS a cap to a stream nothing has
 * touched yet, it never changes how an already-consumed stream behaves.
 */
export function capRequestBodyStream(ctx: Context, maxBodyBytes: number): { tooLarge: () => boolean } {
  const original = ctx.req.raw;
  let tooLarge = false;
  if (original.body && !original.bodyUsed) {
    let total = 0;
    const limited = original.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          total += chunk.byteLength;
          if (total > maxBodyBytes) {
            tooLarge = true;
            controller.error(new Error("body_too_large"));
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    ctx.req.raw = new Request(original, { body: limited, duplex: "half" } as RequestInit);
  }
  return { tooLarge: () => tooLarge };
}

/** The one 413 shape used everywhere a body exceeds the tenant's cap. */
export function bodyTooLargeResponse(limit: number): Response {
  return new Response(JSON.stringify({ error: "body_too_large", limit }), {
    status: 413,
    headers: { "content-type": "application/json" },
  });
}
