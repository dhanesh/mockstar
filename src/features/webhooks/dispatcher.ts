// Satisfies: T4 (post-response microtask delivery), T5 (per-route trigger), T8 (per-attempt timeout)
// Satisfies: S2 (URL re-validation per attempt), S3 (secret resolution at delivery), S4 (admin path skip)
// Satisfies: B2 (URL channels — per-route + header), B5 (header channel server flag + per-route opt-out)
// Satisfies: T7 (templating reuse via CompiledTemplate.render)
// Satisfies: U2 (expectResponse assertion), U4 (journal entry per attempt), TN5 (header value validated, not bypassed)

import type { Metrics } from "../../core/observability/metrics.ts";
import type { TemplateContext } from "../../core/templating/index.ts";
import { validateUpstreamUrl } from "../url-validator.ts";
import type { CircuitBreaker } from "./circuit-breaker.ts";
import type { DeliveryEventRegistry } from "./event-registry.ts";
import type { WebhookJournalRegistry } from "./journal.ts";
import type { AttemptRecord, BoundedRetryQueue } from "./queue.ts";
import { resolveSecret, signPayload } from "./signing.ts";
import type {
  CompiledWebhookSpec,
  DeliverySummary,
  WebhookExpectSpec,
  WebhookJournalEntry,
} from "./types.ts";

/**
 * Internal admin/health paths that MUST NEVER trigger webhooks (S4).
 * Hard-coded — no user override. A too-broad mock match path would otherwise
 * hook the mock server's own health/metrics endpoints and explode delivery volume.
 */
const ADMIN_PATH_PREFIXES = ["/_mockstar", "/__admin", "/health", "/ready", "/metrics"];

export interface DispatcherDeps {
  metrics: Metrics;
  journal: WebhookJournalRegistry;
  events: DeliveryEventRegistry;
  /** Per-tenant queue. Created lazily on first webhook for a tenant. */
  queueForTenant: (tenant: string) => BoundedRetryQueue;
  /** Per-webhook circuit breaker. Created lazily; keyed (tenant, webhookId). */
  circuitFor: (tenant: string, webhookId: string, spec: CompiledWebhookSpec) => CircuitBreaker;
  /** Server-level flag: --allow-webhook-url-header (B5, TN5). When false, header URL is ignored. */
  allowWebhookUrlHeader: boolean;
}

export interface DispatcherTriggerInput {
  tenant: string;
  /** The triggering inbound request's path — used for the admin-skip check. */
  matchPath: string;
  /** The inbound request id (RT-15 — links inbound request to outbound deliveries). */
  triggerRequestId: string;
  /** Mock-entry id whose match scheduled these webhooks (used for journal entry → spec lookup at replay time, INT-2). */
  entryId: string;
  /** Webhook specs attached to the matched mock entry (post-config-load compiled form). */
  webhooks: readonly CompiledWebhookSpec[];
  /** Templating context for rendering URL/body/headers — same shape as response rendering. */
  templateContext: TemplateContext;
  /** Inbound headers, lowercased — for the optional X-Mockstar-Webhook-Url override. */
  requestHeaders: ReadonlyMap<string, string>;
  /** True when this dispatch was triggered by an admin /replay call rather than an inbound match. */
  replay?: boolean;
}

/**
 * Schedule deliveries for all webhooks attached to a matched mock entry.
 *
 * Called from server.ts INSIDE the post-response queueMicrotask block, so this
 * function NEVER adds latency to the served-request flush path (T4).
 *
 * Returns the deliveryIds enqueued — useful for tests that want to await specific deliveries.
 */
export function dispatchWebhooks(deps: DispatcherDeps, input: DispatcherTriggerInput): readonly string[] {
  // S4: hard-coded admin path skip-list. NOT user-configurable.
  if (ADMIN_PATH_PREFIXES.some((p) => input.matchPath === p || input.matchPath.startsWith(`${p}/`))) {
    return [];
  }

  if (input.webhooks.length === 0) return [];

  const queue = deps.queueForTenant(input.tenant);
  const enqueued: string[] = [];

  for (const spec of input.webhooks) {
    const deliveryId = makeDeliveryId();
    enqueued.push(deliveryId);

    const breaker = deps.circuitFor(input.tenant, spec.id, spec);

    queue.enqueue({
      deliveryId,
      tenant: input.tenant,
      webhookId: spec.id,
      triggerRequestId: input.triggerRequestId,
      retry: spec.retry,
      circuitGate: () => breaker.gate(),
      recordCircuitOutcome: (success) => {
        breaker.record(success);
        deps.metrics.setGauge(
          "mockstar_webhook_circuit_state",
          { tenant: input.tenant, webhook: spec.id },
          breaker.metricValue(),
        );
      },
      attempt: () => performAttempt(spec, input, deps),
      onAttempt: (record) => recordAttempt(record, spec, input, deps, deliveryId),
      onTerminal: (summary) => {
        deps.events.publish(summary);
        deps.metrics.incCounter("mockstar_webhook_delivery_total", {
          tenant: input.tenant,
          webhook: spec.id,
          outcome: summary.outcome,
        });
      },
    });
  }

  // Note: webhook_queue_depth gauge is kept in sync via the queue's onSizeChange callback
  // (wired in server.ts). The dispatcher used to call setGauge here directly, but the gauge
  // would then stick at the post-enqueue value instead of decreasing as deliveries completed.

  return enqueued;
}

/**
 * Render and execute a single delivery attempt. Throws on transient failure
 * (caught by the queue's retry loop). Resolves with status/duration on success.
 */
async function performAttempt(
  spec: CompiledWebhookSpec,
  input: DispatcherTriggerInput,
  _deps: DispatcherDeps,
): Promise<{ httpStatus: number; durationUs: number; resolvedUrl: string }> {
  const attemptStart = performance.now();

  // Resolve URL: header override (if allowed) wins, otherwise the per-route template.
  let urlString: string;
  const headerUrl =
    _deps.allowWebhookUrlHeader && spec.acceptHeaderOverride
      ? input.requestHeaders.get("x-mockstar-webhook-url")
      : undefined;
  urlString = headerUrl ?? spec.urlTemplate.render(input.templateContext);

  // S2: re-validate the URL each attempt (it may template differently per request).
  const allowedSchemes = spec.allowHttp ? ["http", "https"] : ["https"];
  validateUpstreamUrl(urlString, {
    allowedSchemes,
    allowPrivateUpstreams: spec.allowPrivateNetworks,
  });
  // validateUpstreamUrl throws on rejection; if we got here, the URL is safe.

  // Render headers and body.
  const renderedHeaders = new Headers();
  for (const [key, tmpl] of spec.headers) {
    renderedHeaders.set(key, tmpl.render(input.templateContext));
  }
  const rawBody = spec.body ? spec.body.render(input.templateContext) : "";

  // Sign if enabled (S1 opt-in).
  if (spec.signing && spec.signing.enabled) {
    const secret = resolveSecret(spec.signing.secretRef);
    const timestampMs = Date.now();
    const signature = signPayload(rawBody, secret, timestampMs);
    renderedHeaders.set(spec.signing.signatureHeader, `${spec.signing.algorithm}=${signature}`);
    renderedHeaders.set(spec.signing.timestampHeader, String(timestampMs));
  }

  // Idempotency-id header — same deliveryId across all retries (B3).
  if (!renderedHeaders.has("x-mockstar-delivery-id")) {
    renderedHeaders.set("x-mockstar-delivery-id", input.triggerRequestId);
  }

  // Per-attempt timeout via AbortSignal.timeout (T8, RT-16).
  const signal = AbortSignal.timeout(spec.timeoutMs);

  let response: Response;
  try {
    response = await fetch(urlString, {
      method: spec.method,
      headers: renderedHeaders,
      body: spec.method === "GET" || spec.method === "DELETE" ? undefined : rawBody,
      signal,
    });
  } catch (err) {
    // Network error / timeout / abort — classified as transient failure.
    throw new Error(`webhook delivery network error: ${(err as Error).message ?? err}`);
  }

  // Default success policy: 2xx counts.
  if (!isSuccessStatus(response.status, spec.expectResponse)) {
    throw new Error(`webhook delivery non-success status: ${response.status}`);
  }

  // expectResponse body assertion (U2): if specified, body must match.
  if (spec.expectResponse?.body !== undefined) {
    const text = await response.text();
    if (!matchesExpectedBody(text, spec.expectResponse.body)) {
      throw new Error(`webhook delivery body assertion failed`);
    }
  }

  return {
    httpStatus: response.status,
    durationUs: Math.round((performance.now() - attemptStart) * 1000),
    resolvedUrl: urlString,
  };
}

function isSuccessStatus(status: number, expect: WebhookExpectSpec | null): boolean {
  if (!expect || expect.status === undefined) {
    return status >= 200 && status < 300;
  }
  if (typeof expect.status === "number") return status === expect.status;
  return expect.status.includes(status);
}

function matchesExpectedBody(actual: string, expected: unknown): boolean {
  if (typeof expected === "string") return actual === expected;
  // Object/partial match — parse actual as JSON, do shallow partial-equal.
  try {
    const parsed = JSON.parse(actual) as Record<string, unknown>;
    if (typeof expected !== "object" || expected === null) return false;
    for (const [key, val] of Object.entries(expected as Record<string, unknown>)) {
      if (parsed[key] !== val) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function recordAttempt(
  record: AttemptRecord,
  spec: CompiledWebhookSpec,
  input: DispatcherTriggerInput,
  deps: DispatcherDeps,
  deliveryId: string,
): void {
  const journalEntry: WebhookJournalEntry = {
    kind: "webhook",
    timestamp: Date.now(),
    tenant: input.tenant,
    deliveryId,
    entryId: input.entryId,
    webhookId: spec.id,
    triggerRequestId: input.triggerRequestId,
    attempt: record.attempt,
    outcome: record.outcome,
    durationUs: record.durationUs,
    ...(record.httpStatus !== undefined && { httpStatus: record.httpStatus }),
    ...(record.resolvedUrl !== undefined && { resolvedUrl: record.resolvedUrl }),
    ...(record.error !== undefined && { error: record.error }),
    ...(input.replay && { replay: true }),
  };
  deps.journal.record(journalEntry);
  deps.metrics.observeLatencyUs(
    "mockstar_webhook_delivery_latency_us",
    { tenant: input.tenant, webhook: spec.id },
    record.durationUs,
  );
}

function makeDeliveryId(): string {
  // Random UUID is fine — not on a hot enough path to need a counter.
  return crypto.randomUUID();
}
