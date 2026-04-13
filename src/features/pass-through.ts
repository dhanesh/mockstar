// Satisfies: T9 (per-route pass-through with timeout + diagnostic errors)
// Satisfies: RT-8 (hardened URL validator applied at config parse AND request time)

import type { Context } from 'hono';
import type { Entry } from '../core/config/schema.ts';
import type { StructuredLogger } from '../core/observability/logger.ts';
import { validateUpstreamUrl, UrlValidationError } from './url-validator.ts';

export interface PassThroughOptions {
  allowPrivateUpstreams: boolean;
  logger: StructuredLogger;
}

export async function renderPassThrough(
  entry: Entry,
  ctx: Context,
  opts: PassThroughOptions,
): Promise<Response> {
  if (entry.response.kind !== 'passthrough') {
    throw new Error(`renderPassThrough called for non-passthrough entry '${entry.id}'`);
  }
  const spec = entry.response;

  // Re-validate at request time (RT-8.2) in case templating ever rewrites the URL in future.
  let upstreamUrl: URL;
  try {
    upstreamUrl = validateUpstreamUrl(spec.upstream, { allowedSchemes: ['https', 'http'], allowPrivateUpstreams: opts.allowPrivateUpstreams });
  } catch (err) {
    opts.logger.error({ event: 'passthrough_url_rejected', entryId: entry.id, reason: err instanceof UrlValidationError ? err.reason : String(err) });
    return new Response(JSON.stringify({ error: 'passthrough_config', reason: 'upstream URL rejected by validator' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Build the target URL by taking the inbound path + query and joining with the upstream.
  const targetUrl = new URL(upstreamUrl);
  const inboundUrl = new URL(ctx.req.url);
  targetUrl.pathname = (targetUrl.pathname.replace(/\/$/, '')) + inboundUrl.pathname;
  targetUrl.search = inboundUrl.search;

  const headers = new Headers();
  if (spec.forwardHeaders) {
    ctx.req.raw.headers.forEach((v, k) => {
      // Strip hop-by-hop headers + our tenancy hint.
      if (k === 'host' || k === 'content-length' || k === 'x-mockstar-tenant') return;
      headers.set(k, v);
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), spec.timeoutMs);
  // Bun/Node: unref the timer so it doesn't keep the process alive.
  (timer as unknown as { unref?: () => void }).unref?.();

  const started = performance.now();
  try {
    const upstreamRes = await fetch(targetUrl, {
      method: ctx.req.method,
      headers,
      body: ctx.req.method === 'GET' || ctx.req.method === 'HEAD' ? undefined : await ctx.req.raw.arrayBuffer(),
      signal: controller.signal,
    });
    clearTimeout(timer);
    // Pass upstream response verbatim.
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: upstreamRes.headers,
    });
  } catch (err) {
    clearTimeout(timer);
    const durationMs = performance.now() - started;
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    opts.logger.error({
      event: 'passthrough_upstream_error',
      entryId: entry.id,
      upstream: String(upstreamUrl),
      durationMs,
      aborted,
      message: err instanceof Error ? err.message : String(err),
    });
    return new Response(
      JSON.stringify({
        error: 'passthrough_upstream',
        upstream: String(upstreamUrl),
        aborted,
        durationMs: Math.round(durationMs),
      }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }
}
