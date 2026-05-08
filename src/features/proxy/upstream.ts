// Satisfies: RT-8 (mockstar upstream reachable + diagnostic 502 on failure)
// Satisfies: T10 (upstream timeout; 502 with structured body)
//
// Forwards the decrypted request to mockstar over plain HTTP. Injects the tenant
// header (X-Mockstar-Tenant) so mockstar's existing tenancy middleware (RT-4 of
// mockstar manifold) routes without URL rewriting.

import type { StructuredLogger } from "../../core/observability/index.ts";
import type { HostConfig, ProxyConfig } from "./types.ts";

export interface ForwardContext {
  readonly config: ProxyConfig;
  readonly host: HostConfig;
  readonly requestId: string;
  /**
   * Structured logger — only info+error are used by the forwarder, so we
   * narrow with Pick so test mocks that don't supply `warn` still satisfy
   * the contract. The shape is compatible with StructuredLogger.
   */
  readonly logger: Pick<StructuredLogger, "info" | "error">;
}

/**
 * Forward the incoming request to mockstar. Preserves method, path, query, headers,
 * and body. Injects `X-Mockstar-Tenant` + `X-Mockstar-Proxy-Request-Id`. Strips
 * hop-by-hop headers.
 *
 * Returns a 502 with a structured diagnostic body when the upstream is unreachable
 * or times out. Never leaks stack traces.
 */
export async function forwardToMockstar(req: Request, ctx: ForwardContext): Promise<Response> {
  const sourceUrl = new URL(req.url);
  const targetUrl = new URL(sourceUrl.pathname + sourceUrl.search, ctx.config.mockstarUrl);

  const forwardHeaders = new Headers();
  // Preserve original headers except hop-by-hop and the tenant hint (we set that ourselves).
  req.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) return;
    if (key.toLowerCase() === "x-mockstar-tenant") return;
    if (key.toLowerCase() === "host") return;
    forwardHeaders.set(key, value);
  });
  forwardHeaders.set("x-mockstar-tenant", ctx.host.tenant);
  forwardHeaders.set("x-mockstar-proxy-request-id", ctx.requestId);
  forwardHeaders.set("x-forwarded-host", ctx.host.host);
  forwardHeaders.set("x-forwarded-proto", "https");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.config.upstreamTimeoutMs);
  (timer as unknown as { unref?: () => void }).unref?.();

  const started = performance.now();
  try {
    const upstreamBody = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    const upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: upstreamBody,
      signal: controller.signal,
      redirect: "manual",
    });
    clearTimeout(timer);
    return upstreamRes;
  } catch (err) {
    clearTimeout(timer);
    const aborted = err instanceof DOMException && err.name === "AbortError";
    const durationMs = performance.now() - started;
    ctx.logger.error({
      event: "proxy_upstream_error",
      host: ctx.host.host,
      tenant: ctx.host.tenant,
      upstream: ctx.config.mockstarUrl,
      requestId: ctx.requestId,
      aborted,
      durationMs,
      message: err instanceof Error ? err.message : String(err),
    });
    return new Response(
      JSON.stringify({
        error: "mockstar_unreachable",
        upstream: ctx.config.mockstarUrl,
        cause: aborted ? "timeout" : "connection_error",
        requestId: ctx.requestId,
        durationMs: Math.round(durationMs),
        hint: aborted
          ? `Upstream exceeded ${ctx.config.upstreamTimeoutMs}ms timeout. Increase upstreamTimeoutMs in proxy config or check mockstar load.`
          : `Mockstar is not responding at ${ctx.config.mockstarUrl}. Run 'make dev' or check mockstar logs.`,
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}

/** One-shot health probe. Returns true if mockstar's /health endpoint responds with 200. */
export async function probeMockstarHealth(config: ProxyConfig, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    const res = await fetch(new URL("/health", config.mockstarUrl), { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Hop-by-hop headers per RFC 7230 section 6.1 + CORS preflight hints.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length", // recomputed by fetch()
]);
