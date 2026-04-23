// Satisfies: RT-4 (tenant routing middleware is first)
// Satisfies: T1 (Hono on Bun), RT-5 (config snapshot reads)
// Satisfies: O1 (request logging), O2 (metrics), O3 (journal)

import { Hono, type Context } from 'hono';
import type { ConfigSnapshot, SnapshotHolder } from './core/config/snapshot.ts';
import type { HandlerRegistry } from './core/handlers/index.ts';
import { JournalRegistry, type JournalEntry } from './core/journal/index.ts';
import { Metrics, createLogger, type StructuredLogger } from './core/observability/index.ts';
import { installProcessHandlers } from './core/errors/index.ts';
import { effectivePath, tenantMiddleware } from './core/tenancy/index.ts';
import { renderStatic } from './features/static-mock.ts';
import { renderDynamic } from './features/dynamic-mock.ts';
import { renderPassThrough } from './features/pass-through.ts';
import { adminRouter } from './features/admin/index.ts';
import { createFaker, type FakerInstance } from './core/templating/faker.ts';
import { createClock, type Clock } from './core/templating/tier2/now.ts';
import { evaluateScenarios, type ScenarioAttrs } from './core/scenarios/evaluator.ts';
import { mergeStaticResponse, scenarioResponseForNonStatic, renderScenario } from './core/scenarios/merger.ts';

// Hono variable augmentation — all middleware reads typed `ctx.var.*`.
declare module 'hono' {
  interface ContextVariableMap {
    tenant: string;
    originalPath: string;
    tenantStrippedPath: string;
    requestId: string;
    adminAuth: { scope: 'tenant' | 'root'; tenant: string | null };
  }
}

export interface CreateServerOptions {
  holder: SnapshotHolder;
  registry: HandlerRegistry;
  logger?: StructuredLogger;
  /** Supplied to enable RT-12 deterministic mode. */
  deterministic?: boolean;
  /** Hook to unit-test process handlers without terminating. */
  installCrashHandlers?: boolean;
  /** Handler-invocation timeout, propagated to invokeWithBoundary (T10). */
  handlerTimeoutMs?: number;
}

export interface RunningServer {
  readonly hono: Hono;
  readonly journal: JournalRegistry;
  readonly metrics: Metrics;
  readonly ready: { current: () => boolean; set: (v: boolean) => void };
  readonly uninstallCrashHandlers: () => void;
}

export function createServer(opts: CreateServerOptions): RunningServer {
  const logger = opts.logger ?? createLogger({ deterministic: opts.deterministic });
  const metrics = new Metrics();
  const journal = new JournalRegistry((tenant) => {
    const snap = opts.holder.get().tenants.get(tenant);
    return snap?.limits.journalSize ?? 1000;
  });
  let readyFlag = true;
  const ready = {
    current: (): boolean => readyFlag,
    set: (v: boolean): void => {
      readyFlag = v;
    },
  };

  const uninstallCrashHandlers = opts.installCrashHandlers !== false
    ? installProcessHandlers({ logger, setReady: ready.set })
    : (): void => undefined;

  const faker: FakerInstance = createFaker({ deterministic: opts.deterministic ?? false });
  const clock: Clock = createClock({ deterministic: opts.deterministic ?? false });
  const handlerTimeoutMs = opts.handlerTimeoutMs ?? 5_000;
  const genRequestId = createRequestIdGenerator(opts.deterministic ?? false);

  const app = new Hono();

  // Admin routes — mounted BEFORE the tenant extractor so /health and /ready
  // are not subject to tenant rewriting (RT-3.2).
  app.route('/', adminRouter({ holder: opts.holder, journal, metrics, ready }));

  // Tenant extractor — first non-admin middleware (RT-4.1).
  const snapshot = opts.holder.get();
  app.use(
    '*',
    tenantMiddleware({ modes: snapshot.server.tenancyModes }),
  );

  // Main mock dispatcher.
  app.all('*', async (ctx) => dispatch(ctx, { opts, logger, faker, clock, journal, metrics, handlerTimeoutMs, genRequestId }));

  return { hono: app, journal, metrics, ready, uninstallCrashHandlers };
}

interface DispatchDeps {
  opts: CreateServerOptions;
  logger: StructuredLogger;
  faker: FakerInstance;
  clock: Clock;
  journal: JournalRegistry;
  metrics: Metrics;
  handlerTimeoutMs: number;
  genRequestId: () => string;
}

async function dispatch(ctx: Context, deps: DispatchDeps): Promise<Response> {
  const snapshot: ConfigSnapshot = deps.opts.holder.get(); // RT-5.3: captured once for this request
  const tenant = ctx.var.tenant;
  const tenantSnap = snapshot.tenants.get(tenant);
  const requestId = deps.genRequestId();
  ctx.set('requestId', requestId);
  const startedUs = performance.now() * 1000;

  // Path after /t/{tenant} stripping (RT-4).
  const matchPath = effectivePath(ctx);
  const method = ctx.req.method;

  let response: Response;
  let matchedMockId: string | null = null;
  let scenarioId: string | undefined;
  let scenarioMissReason: string | undefined;

  try {
    if (!tenantSnap) {
      response = notFoundUnknownTenant(tenant, method, matchPath);
    } else {
      // Rate / size caps (S5) — cheap pre-check.
      const contentLength = Number.parseInt(ctx.req.header('content-length') ?? '0', 10);
      if (contentLength > tenantSnap.limits.maxBodyBytes) {
        response = new Response(JSON.stringify({ error: 'body_too_large', limit: tenantSnap.limits.maxBodyBytes }), {
          status: 413,
          headers: { 'content-type': 'application/json' },
        });
      } else {
        const result = await routeToMock(ctx, matchPath, method, tenant, snapshot, tenantSnap, requestId, deps);
        response = result.response;
        matchedMockId = (response.headers.get('x-mockstar-matched') ?? null);
        scenarioId = result.scenarioId;
        scenarioMissReason = result.scenarioMissReason;
      }
    }
  } catch (err) {
    deps.logger.error({
      event: 'dispatch_error',
      tenant,
      method,
      path: matchPath,
      requestId,
      message: err instanceof Error ? err.message : String(err),
    });
    response = new Response(JSON.stringify({ error: 'internal' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Defer observability writes to after the response goes out (RT-6.3).
  queueMicrotask(() => {
    const durationUs = Math.round(performance.now() * 1000 - startedUs);
    const entry: JournalEntry = {
      timestamp: Date.now(),
      tenant,
      requestId,
      method,
      path: matchPath,
      status: response.status,
      matchedMockId,
      durationUs,
      ...(scenarioId !== undefined && { scenarioId }),
      ...(scenarioMissReason !== undefined && { scenarioMissReason }),
    };
    deps.journal.record(entry);
    deps.metrics.incCounter('mockstar_requests_total', {
      tenant,
      method,
      status: String(response.status),
      matched: matchedMockId ? '1' : '0',
    });
    deps.metrics.observeLatencyUs('mockstar_request_latency_us', { tenant }, durationUs);
    deps.logger.info({
      event: 'request',
      tenant,
      method,
      path: matchPath,
      status: response.status,
      matchedMockId,
      requestId,
      durationUs,
    });
  });

  return response;
}

interface RouteResult {
  response: Response;
  scenarioId?: string;
  scenarioMissReason?: string;
}

async function routeToMock(
  ctx: Context,
  matchPath: string,
  method: string,
  tenant: string,
  snapshot: ConfigSnapshot,
  tenantSnap: NonNullable<ReturnType<ConfigSnapshot['tenants']['get']>>,
  requestId: string,
  deps: DispatchDeps,
): Promise<RouteResult> {
  // Build the request view for matching discriminators.
  const url = new URL(ctx.req.url);
  const body = await safeParseBody(ctx);
  const req = {
    query: new Map(Array.from(url.searchParams)),
    headers: new Map(Array.from(ctx.req.raw.headers).map(([k, v]) => [k.toLowerCase(), v])),
    body,
  };

  const hit = tenantSnap.matchIndex.match(method, matchPath, req);
  if (!hit) {
    // Diagnostic 404 (RT-9, U1).
    const nearest = tenantSnap.matchIndex.nearestMatch(method, matchPath, req, 3);
    return {
      response: new Response(
        JSON.stringify({
          error: 'unmatched',
          method,
          path: matchPath,
          tenant,
          nearest_matches: nearest.map((n) => ({
            mockId: n.entry.id,
            failed_predicate: n.failure,
          })),
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ),
    };
  }

  // Scenario evaluation — runs before kind dispatch (RT-1 insertion point, T7 kind-agnostic).
  const compiledScenarios = tenantSnap.compiledScenarios.get(hit.entry.id) ?? [];
  let scenarioId: string | undefined;
  let scenarioMissReason: string | undefined;
  if (compiledScenarios.length > 0) {
    const attrs: ScenarioAttrs = {
      params: hit.params,
      query: req.query,
      headers: req.headers,
      body,
    };
    const { match: scenarioMatch, scenarioMissReason: missReason } = evaluateScenarios(compiledScenarios, attrs);
    scenarioMissReason = missReason;
    if (scenarioMatch) {
      scenarioId = scenarioMatch.id;
      const scenarioRenderOpts = {
        faker: deps.faker,
        clock: deps.clock,
        deterministic: deps.opts.deterministic ?? false,
        tenant,
        requestId,
        entryId: hit.entry.id,
        ctx,
        params: hit.params,
        body,
        maxResponseBytes: tenantSnap.limits.maxResponseBytes,
      };
      let scenarioResp: Response;
      if (hit.entry.response.kind === 'static') {
        const compiled = tenantSnap.compiledResponses.get(hit.entry.id);
        if (!compiled) throw new Error(`Missing compiled response for entry '${hit.entry.id}'`);
        const merged = mergeStaticResponse(
          hit.entry as Parameters<typeof mergeStaticResponse>[0],
          compiled,
          scenarioMatch,
        );
        scenarioResp = await renderScenario(merged, scenarioRenderOpts);
      } else {
        scenarioResp = await renderScenario(scenarioResponseForNonStatic(scenarioMatch), scenarioRenderOpts);
      }
      const h = new Headers(scenarioResp.headers);
      h.set('x-mockstar-matched', hit.entry.id);
      h.set('x-mockstar-scenario', scenarioMatch.id);
      return { response: new Response(scenarioResp.body, { status: scenarioResp.status, headers: h }), scenarioId };
    }
  }

  let response: Response;
  switch (hit.entry.response.kind) {
    case 'static': {
      const compiled = tenantSnap.compiledResponses.get(hit.entry.id);
      if (!compiled) throw new Error(`Missing compiled response for entry '${hit.entry.id}'`);
      response = await renderStatic({
        entry: hit.entry,
        compiled,
        ctx,
        params: hit.params,
        faker: deps.faker,
        clock: deps.clock,
        deterministic: deps.opts.deterministic ?? false,
        maxResponseBytes: tenantSnap.limits.maxResponseBytes,
        tenant,
        requestId,
        body,
      });
      break;
    }
    case 'dynamic':
      response = await renderDynamic({
        entry: hit.entry,
        ctx,
        registry: snapshot.handlers,
        tenant,
        requestId,
        faker: deps.faker,
        boundary: { logger: deps.logger, timeoutMs: deps.handlerTimeoutMs },
      });
      break;
    case 'passthrough':
      response = await renderPassThrough(hit.entry, ctx, {
        allowPrivateUpstreams: tenantSnap.allowPrivateUpstreams,
        logger: deps.logger,
      });
      break;
  }

  const headers = new Headers(response.headers);
  headers.set('x-mockstar-matched', hit.entry.id);
  return {
    response: new Response(response.body, { status: response.status, headers }),
    scenarioMissReason,
  };
}

function notFoundUnknownTenant(tenant: string, method: string, path: string): Response {
  return new Response(
    JSON.stringify({ error: 'unknown_tenant', tenant, method, path }),
    { status: 404, headers: { 'content-type': 'application/json' } },
  );
}

async function safeParseBody(ctx: Context): Promise<unknown> {
  const method = ctx.req.method;
  if (method === 'GET' || method === 'HEAD') return null;
  const contentType = ctx.req.header('content-type') ?? '';
  if (!contentType.includes('json')) return null;
  try {
    // Hono's req.json() clones; we use raw to avoid double-read issues downstream.
    const text = await ctx.req.text();
    if (text.length === 0) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Per-server request-ID generator. The deterministic counter lives in closure scope so each
 * `createServer()` call gets an isolated counter — two back-to-back launches in the same process
 * produce byte-identical IDs for matching request sequences (prevents flaky cross-launch replay
 * assertions).
 */
function createRequestIdGenerator(deterministic: boolean): () => string {
  if (!deterministic) return (): string => crypto.randomUUID();
  let counter = 0;
  return (): string => {
    counter += 1;
    return `req-${counter.toString().padStart(8, '0')}`;
  };
}
