// Satisfies: T9 (per-route pass-through with timeout + diagnostic errors)
// Satisfies: RT-8 (hardened URL validator applied at config parse AND request time)

import type { Context } from "hono";
import type { Entry } from "../core/config/schema.ts";
import { bodyTooLargeResponse, capRequestBodyStream } from "../core/http/body-cap.ts";
import type { StructuredLogger } from "../core/observability/logger.ts";
import { UrlValidationError, fetchWithRedirectGuard, validateUpstreamUrlResolved } from "./url-validator.ts";

export interface PassThroughOptions {
  allowPrivateUpstreams: boolean;
  logger: StructuredLogger;
  /**
   * S5 / #33: the tenant's request body size cap. `safeParseBody` (src/server.ts) only
   * caps JSON bodies — a non-JSON body (chunked, no Content-Length) reaches this function
   * with its stream untouched, so we apply the SAME cap (via `capRequestBodyStream`)
   * before reading it for upstream forwarding. See the read below.
   */
  maxBodyBytes: number;
}

export async function renderPassThrough(
  entry: Entry,
  ctx: Context,
  opts: PassThroughOptions,
): Promise<Response> {
  if (entry.response.kind !== "passthrough") {
    throw new Error(`renderPassThrough called for non-passthrough entry '${entry.id}'`);
  }
  const spec = entry.response;

  // Re-validate at request time (RT-8.2) in case templating ever rewrites the URL in future.
  // Resolves DNS and rejects hostnames whose A/AAAA records point at private ranges (F1 SSRF guard).
  // Reused verbatim (not re-derived from defaults) to re-validate any redirect Location below (#37).
  const validationOpts = {
    allowedSchemes: ["https", "http"] as const,
    allowPrivateUpstreams: opts.allowPrivateUpstreams,
  };
  let upstreamUrl: URL;
  try {
    upstreamUrl = await validateUpstreamUrlResolved(spec.upstream, validationOpts);
  } catch (err) {
    opts.logger.error({
      event: "passthrough_url_rejected",
      entryId: entry.id,
      reason: err instanceof UrlValidationError ? err.reason : String(err),
    });
    return new Response(
      JSON.stringify({ error: "passthrough_config", reason: "upstream URL rejected by validator" }),
      {
        status: 502,
        headers: { "content-type": "application/json" },
      },
    );
  }

  // Build the target URL by taking the inbound path + query and joining with the upstream.
  const targetUrl = new URL(upstreamUrl);
  const inboundUrl = new URL(ctx.req.url);
  targetUrl.pathname = targetUrl.pathname.replace(/\/$/, "") + inboundUrl.pathname;
  targetUrl.search = inboundUrl.search;

  const headers = new Headers();
  if (spec.forwardHeaders) {
    ctx.req.raw.headers.forEach((v, k) => {
      // Strip hop-by-hop headers + our tenancy hint.
      if (k === "host" || k === "content-length" || k === "x-mockstar-tenant") return;
      headers.set(k, v);
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), spec.timeoutMs);
  // Bun/Node: unref the timer so it doesn't keep the process alive.
  (timer as unknown as { unref?: () => void }).unref?.();

  // S5 / #33: apply the same byte cap the JSON path applies, right before the read that
  // would otherwise buffer an unbounded, non-JSON, chunked body into memory. `capRequestBodyStream`
  // no-ops when the body was already capped-and-consumed upstream (a JSON-content-type body
  // routed to a passthrough entry — `safeParseBody` already read it), so this doesn't touch
  // that path's behavior.
  const bodyCap =
    ctx.req.method === "GET" || ctx.req.method === "HEAD"
      ? null
      : capRequestBodyStream(ctx, opts.maxBodyBytes);

  const started = performance.now();
  try {
    const requestBody = bodyCap ? await ctx.req.raw.arrayBuffer() : null;
    // redirect: "manual" + fetchWithRedirectGuard (#37): the default redirect: "follow"
    // would otherwise let a permitted public upstream 3xx the caller to a private/loopback/
    // metadata address with no revalidation. `targetUrl` shares its scheme+host+port with
    // `upstreamUrl` (already validated above) — only the path/query differ — so it's safe
    // to fetch directly; every REDIRECT hop beyond it is separately re-validated inside
    // the guard using the SAME validationOpts.
    const { response: upstreamRes } = await fetchWithRedirectGuard(
      targetUrl,
      {
        method: ctx.req.method,
        headers,
        body: requestBody,
        signal: controller.signal,
      },
      validationOpts,
    );
    clearTimeout(timer);
    // Pass upstream response verbatim.
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: upstreamRes.headers,
    });
  } catch (err) {
    clearTimeout(timer);
    if (bodyCap?.tooLarge()) {
      return bodyTooLargeResponse(opts.maxBodyBytes);
    }
    const durationMs = performance.now() - started;
    if (err instanceof UrlValidationError) {
      // A redirect hop (or the hop cap) was rejected by the SSRF guard — fail closed,
      // same shape as the initial-URL rejection above, but distinguishable in logs (#37).
      opts.logger.error({
        event: "passthrough_redirect_rejected",
        entryId: entry.id,
        upstream: String(upstreamUrl),
        reason: err.reason,
      });
      return new Response(
        JSON.stringify({
          error: "passthrough_upstream",
          upstream: String(upstreamUrl),
          reason: "upstream redirected to a URL rejected by validator",
        }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }
    const aborted = err instanceof DOMException && err.name === "AbortError";
    opts.logger.error({
      event: "passthrough_upstream_error",
      entryId: entry.id,
      upstream: String(upstreamUrl),
      durationMs,
      aborted,
      message: err instanceof Error ? err.message : String(err),
    });
    return new Response(
      JSON.stringify({
        error: "passthrough_upstream",
        upstream: String(upstreamUrl),
        aborted,
        durationMs: Math.round(durationMs),
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
