// Satisfies: RT-4 (tenant routing middleware is first)
// Satisfies: T1 (Hono on Bun), RT-5 (config snapshot reads)
// Satisfies: O1 (request logging), O2 (metrics), O3 (journal)

import { Hono, type Context } from "hono";
import type { ConfigSnapshot, SnapshotHolder } from "./core/config/snapshot.ts";
import type { HandlerRegistry } from "./core/handlers/index.ts";
import { JournalRegistry, type JournalEntry } from "./core/journal/index.ts";
import { Metrics, createLogger, type StructuredLogger } from "./core/observability/index.ts";
import { installProcessHandlers } from "./core/errors/index.ts";
import { effectivePath, tenantMiddleware } from "./core/tenancy/index.ts";
import { renderStatic } from "./features/static-mock.ts";
import { renderDynamic } from "./features/dynamic-mock.ts";
import { renderPassThrough } from "./features/pass-through.ts";
import { adminRouter } from "./features/admin/index.ts";
import { createFaker, type FakerInstance } from "./core/templating/faker.ts";
import { createClock, type Clock } from "./core/templating/tier2/now.ts";
import { createIdHelpers } from "./core/templating/tier2/id.ts";
import { evaluateScenarios, type ScenarioAttrs } from "./core/scenarios/evaluator.ts";
import {
  mergeStaticResponse,
  scenarioResponseForNonStatic,
  renderScenario,
} from "./core/scenarios/merger.ts";
import {
  BoundedRetryQueue,
  CircuitBreaker,
  DeliveryEventRegistry,
  WebhookJournalRegistry,
  dispatchWebhooks,
  type CompiledWebhookSpec,
} from "./features/webhooks/index.ts";

// Hono variable augmentation — all middleware reads typed `ctx.var.*`.
declare module "hono" {
  interface ContextVariableMap {
    tenant: string;
    originalPath: string;
    tenantStrippedPath: string;
    requestId: string;
    adminAuth: { scope: "tenant" | "root"; tenant: string | null };
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
  /** B5/TN5: honour the X-Mockstar-Webhook-Url request header. Default false. */
  allowWebhookUrlHeader?: boolean;
  /** INT-1: optional JSONL append-only log of webhook delivery attempts. */
  webhookJournalFile?: string;
}

export interface RunningServer {
  readonly hono: Hono;
  readonly journal: JournalRegistry;
  readonly metrics: Metrics;
  readonly ready: { current: () => boolean; set: (v: boolean) => void };
  readonly uninstallCrashHandlers: () => void;
  /** Webhook delivery journal — separate ring buffer per tenant (RT-11). */
  readonly webhookJournal: WebhookJournalRegistry;
  /** Terminal-state event registry for the await admin endpoint (U1, RT-14). */
  readonly webhookEvents: DeliveryEventRegistry;
  /**
   * INT-2: replay a delivery by id. Looks up the original journal entry, finds the
   * webhook spec in the CURRENT snapshot (NOT a stored copy), and re-enqueues a
   * fresh delivery. Returns the new deliveryId on success or an error code.
   */
  readonly replayWebhook: (tenant: string, deliveryId: string) => ReplayResult;
}

export type ReplayResult =
  | { ok: true; newDeliveryId: string }
  | {
      ok: false;
      code: "tenant_not_found" | "delivery_not_in_journal" | "mock_entry_removed" | "webhook_spec_removed";
    };

export function createServer(opts: CreateServerOptions): RunningServer {
  const logger = opts.logger ?? createLogger({ deterministic: opts.deterministic });
  const metrics = new Metrics();
  const journal = new JournalRegistry((tenant) => {
    const snap = opts.holder.get().tenants.get(tenant);
    return snap?.limits.journalSize ?? 1000;
  });

  // Webhook infrastructure (RT-1, RT-11, RT-14, RT-4, INT-1).
  const webhookJournal = new WebhookJournalRegistry(
    (tenant) => {
      const snap = opts.holder.get().tenants.get(tenant);
      return snap?.limits.journalSize ?? 1000;
    },
    { journalFile: opts.webhookJournalFile },
  );
  const webhookEvents = new DeliveryEventRegistry();
  const webhookQueues = new Map<string, BoundedRetryQueue>();
  const webhookCircuits = new Map<string, CircuitBreaker>();
  const queueForTenant = (tenant: string): BoundedRetryQueue => {
    let q = webhookQueues.get(tenant);
    if (!q) {
      q = new BoundedRetryQueue({
        onDropped: () => metrics.incCounter("mockstar_webhook_queue_dropped_total", { tenant }),
        // Keep webhook_queue_depth gauge in sync with reality on every state mutation
        // (enqueue +1, task completion -1) — fixes the previous lag where the gauge
        // sampled only at enqueue and stuck at the high-water mark.
        onSizeChange: (size) => metrics.setGauge("mockstar_webhook_queue_depth", { tenant }, size),
      });
      webhookQueues.set(tenant, q);
    }
    return q;
  };
  const circuitFor = (tenant: string, webhookId: string, spec: CompiledWebhookSpec): CircuitBreaker => {
    const key = `${tenant}::${webhookId}`;
    let c = webhookCircuits.get(key);
    if (!c) {
      c = new CircuitBreaker({
        failureThreshold: spec.circuit.failureThreshold,
        cooldownMs: spec.circuit.cooldownMs,
      });
      webhookCircuits.set(key, c);
    }
    return c;
  };

  let readyFlag = true;
  const ready = {
    current: (): boolean => readyFlag,
    set: (v: boolean): void => {
      readyFlag = v;
    },
  };

  const uninstallCrashHandlers =
    opts.installCrashHandlers !== false
      ? installProcessHandlers({ logger, setReady: ready.set })
      : (): void => undefined;

  const faker: FakerInstance = createFaker({ deterministic: opts.deterministic ?? false });
  const clock: Clock = createClock({ deterministic: opts.deterministic ?? false });
  const handlerTimeoutMs = opts.handlerTimeoutMs ?? 5_000;
  const genRequestId = createRequestIdGenerator(opts.deterministic ?? false);

  const app = new Hono();

  // INT-2: replay function — closure-captures the deps the admin router needs to re-enqueue.
  const replayWebhook = (tenant: string, deliveryId: string): ReplayResult => {
    const snap = opts.holder.get();
    const tenantSnap = snap.tenants.get(tenant);
    if (!tenantSnap) return { ok: false, code: "tenant_not_found" };

    const original = webhookJournal.findLatestByDeliveryId(tenant, deliveryId);
    if (!original) return { ok: false, code: "delivery_not_in_journal" };

    const specs = tenantSnap.compiledWebhooks.get(original.entryId);
    if (!specs || specs.length === 0) return { ok: false, code: "mock_entry_removed" };
    const spec = specs.find((s) => s.id === original.webhookId);
    if (!spec) return { ok: false, code: "webhook_spec_removed" };

    // Build a minimal template context. Replay uses the CURRENT snapshot's spec
    // and an EMPTY request snapshot — templates referencing request data render
    // as empty strings. Documented in DECISIONS.md INT-2.
    const replayCtx = {
      faker,
      request: { method: "GET", path: "/__replay", query: {}, headers: {}, body: null, params: {} },
      tenant,
      requestId: original.triggerRequestId,
      clock,
      idHelpers: createIdHelpers({
        deterministic: opts.deterministic ?? false,
        tenant,
        endpoint: original.entryId,
        requestCounter: 0,
      }),
    };

    const enqueued = dispatchWebhooks(
      {
        metrics,
        journal: webhookJournal,
        events: webhookEvents,
        queueForTenant,
        circuitFor,
        allowWebhookUrlHeader,
      },
      {
        tenant,
        matchPath: "/__replay", // synthetic path; admin-skip prefix-list is checked, this is safe
        triggerRequestId: original.triggerRequestId,
        entryId: original.entryId,
        webhooks: [spec],
        templateContext: replayCtx,
        requestHeaders: new Map(),
        replay: true,
      },
    );

    return { ok: true, newDeliveryId: enqueued[0] ?? "" };
  };

  // Admin routes — mounted BEFORE the tenant extractor so /health and /ready
  // are not subject to tenant rewriting (RT-3.2).
  app.route(
    "/",
    adminRouter({
      holder: opts.holder,
      journal,
      metrics,
      ready,
      webhookJournal,
      webhookEvents,
      replayWebhook,
    }),
  );

  // Tenant extractor — first non-admin middleware (RT-4.1).
  const snapshot = opts.holder.get();
  app.use("*", tenantMiddleware({ modes: snapshot.server.tenancyModes }));

  // Main mock dispatcher.
  const allowWebhookUrlHeader = opts.allowWebhookUrlHeader ?? false;
  app.all("*", async (ctx) =>
    dispatch(ctx, {
      opts,
      logger,
      faker,
      clock,
      journal,
      metrics,
      handlerTimeoutMs,
      genRequestId,
      webhookJournal,
      webhookEvents,
      queueForTenant,
      circuitFor,
      allowWebhookUrlHeader,
    }),
  );

  return {
    hono: app,
    journal,
    metrics,
    ready,
    uninstallCrashHandlers,
    webhookJournal,
    webhookEvents,
    replayWebhook,
  };
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
  // Webhook fan-out (T4: post-response microtask).
  webhookJournal: WebhookJournalRegistry;
  webhookEvents: DeliveryEventRegistry;
  queueForTenant: (tenant: string) => BoundedRetryQueue;
  circuitFor: (tenant: string, webhookId: string, spec: CompiledWebhookSpec) => CircuitBreaker;
  allowWebhookUrlHeader: boolean;
}

interface WebhookTrigger {
  entryId: string;
  webhooks: readonly CompiledWebhookSpec[];
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
}

async function dispatch(ctx: Context, deps: DispatchDeps): Promise<Response> {
  const snapshot: ConfigSnapshot = deps.opts.holder.get(); // RT-5.3: captured once for this request
  const tenant = ctx.var.tenant;
  const tenantSnap = snapshot.tenants.get(tenant);
  const requestId = deps.genRequestId();
  ctx.set("requestId", requestId);
  const startedUs = performance.now() * 1000;

  // Path after /t/{tenant} stripping (RT-4).
  const matchPath = effectivePath(ctx);
  const method = ctx.req.method;

  let response: Response;
  let matchedMockId: string | null = null;
  let scenarioId: string | undefined;
  let scenarioMissReason: string | undefined;
  let webhookTrigger: WebhookTrigger | undefined;

  try {
    if (!tenantSnap) {
      response = notFoundUnknownTenant(tenant, method, matchPath);
    } else {
      // Rate / size caps (S5) — cheap pre-check.
      const contentLength = Number.parseInt(ctx.req.header("content-length") ?? "0", 10);
      if (contentLength > tenantSnap.limits.maxBodyBytes) {
        response = new Response(
          JSON.stringify({ error: "body_too_large", limit: tenantSnap.limits.maxBodyBytes }),
          {
            status: 413,
            headers: { "content-type": "application/json" },
          },
        );
      } else {
        const result = await routeToMock(
          ctx,
          matchPath,
          method,
          tenant,
          snapshot,
          tenantSnap,
          requestId,
          deps,
        );
        response = result.response;
        matchedMockId = response.headers.get("x-mockstar-matched") ?? null;
        scenarioId = result.scenarioId;
        scenarioMissReason = result.scenarioMissReason;
        webhookTrigger = result.webhookTrigger;
      }
    }
  } catch (err) {
    deps.logger.error({
      event: "dispatch_error",
      tenant,
      method,
      path: matchPath,
      requestId,
      message: err instanceof Error ? err.message : String(err),
    });
    response = new Response(JSON.stringify({ error: "internal" }), {
      status: 500,
      headers: { "content-type": "application/json" },
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
    deps.metrics.incCounter("mockstar_requests_total", {
      tenant,
      method,
      status: String(response.status),
      matched: matchedMockId ? "1" : "0",
    });
    deps.metrics.observeLatencyUs("mockstar_request_latency_us", { tenant }, durationUs);
    deps.logger.info({
      event: "request",
      tenant,
      method,
      path: matchPath,
      status: response.status,
      matchedMockId,
      requestId,
      durationUs,
    });

    // Webhook fan-out (T4: still in the post-response microtask, never on hot path).
    if (webhookTrigger) {
      const idHelpers = createIdHelpers({
        deterministic: deps.opts.deterministic ?? false,
        tenant,
        endpoint: webhookTrigger.entryId,
        requestCounter: 0,
      });
      dispatchWebhooks(
        {
          metrics: deps.metrics,
          journal: deps.webhookJournal,
          events: deps.webhookEvents,
          queueForTenant: deps.queueForTenant,
          circuitFor: deps.circuitFor,
          allowWebhookUrlHeader: deps.allowWebhookUrlHeader,
        },
        {
          tenant,
          matchPath,
          triggerRequestId: requestId,
          entryId: webhookTrigger.entryId,
          webhooks: webhookTrigger.webhooks,
          requestHeaders: new Map(Object.entries(webhookTrigger.headers)),
          templateContext: {
            faker: deps.faker,
            request: {
              method,
              path: matchPath,
              query: webhookTrigger.query,
              headers: webhookTrigger.headers,
              body: webhookTrigger.body,
              params: webhookTrigger.params,
            },
            tenant,
            requestId,
            clock: deps.clock,
            idHelpers,
          },
        },
      );
    }
  });

  return response;
}

interface RouteResult {
  response: Response;
  scenarioId?: string;
  scenarioMissReason?: string;
  webhookTrigger?: WebhookTrigger;
}

async function routeToMock(
  ctx: Context,
  matchPath: string,
  method: string,
  tenant: string,
  snapshot: ConfigSnapshot,
  tenantSnap: NonNullable<ReturnType<ConfigSnapshot["tenants"]["get"]>>,
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
          error: "unmatched",
          method,
          path: matchPath,
          tenant,
          nearest_matches: nearest.map((n) => ({
            mockId: n.entry.id,
            failed_predicate: n.failure,
          })),
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
    };
  }

  // Webhook fan-out trigger info (T5). Built once; threaded through both scenario and main return paths.
  const compiledWebhooks = tenantSnap.compiledWebhooks.get(hit.entry.id) ?? [];
  const webhookTrigger: WebhookTrigger | undefined =
    compiledWebhooks.length > 0
      ? {
          entryId: hit.entry.id,
          webhooks: compiledWebhooks,
          body,
          params: hit.params,
          query: Object.fromEntries(req.query),
          headers: Object.fromEntries(req.headers),
        }
      : undefined;

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
    const { match: scenarioMatch, scenarioMissReason: missReason } = evaluateScenarios(
      compiledScenarios,
      attrs,
    );
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
      if (hit.entry.response.kind === "static") {
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
      h.set("x-mockstar-matched", hit.entry.id);
      h.set("x-mockstar-scenario", scenarioMatch.id);
      return {
        response: new Response(scenarioResp.body, { status: scenarioResp.status, headers: h }),
        scenarioId,
        ...(webhookTrigger && { webhookTrigger }),
      };
    }
  }

  let response: Response;
  switch (hit.entry.response.kind) {
    case "static": {
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
    case "dynamic":
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
    case "passthrough":
      response = await renderPassThrough(hit.entry, ctx, {
        allowPrivateUpstreams: tenantSnap.allowPrivateUpstreams,
        logger: deps.logger,
      });
      break;
  }

  const headers = new Headers(response.headers);
  headers.set("x-mockstar-matched", hit.entry.id);
  return {
    response: new Response(response.body, { status: response.status, headers }),
    scenarioMissReason,
    ...(webhookTrigger && { webhookTrigger }),
  };
}

function notFoundUnknownTenant(tenant: string, method: string, path: string): Response {
  return new Response(JSON.stringify({ error: "unknown_tenant", tenant, method, path }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

async function safeParseBody(ctx: Context): Promise<unknown> {
  const method = ctx.req.method;
  if (method === "GET" || method === "HEAD") return null;
  const contentType = ctx.req.header("content-type") ?? "";
  if (!contentType.includes("json")) return null;
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
    return `req-${counter.toString().padStart(8, "0")}`;
  };
}
