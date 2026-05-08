// Validates: O2 (Prometheus metrics for webhooks), RT-12 (gauge support in Metrics module)
// @constraint O2 - webhook_delivery_total / _latency_us / _queue_depth / _circuit_state emitted

import { afterEach, describe, expect, test } from "bun:test";
import type { Entry } from "../../src/core/config/schema.ts";
import { ADMIN_TOKEN, makeTestServer, spawnReceiver, tick, webhookSpec } from "./_helpers.ts";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

describe("O2 — Prometheus metrics for webhook delivery cycle", () => {
  test("successful delivery increments delivery_total{outcome=success} and emits latency histogram", async () => {
    const receiver = spawnReceiver(
      () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    cleanups = [receiver.close];

    const entries: Entry[] = [
      {
        id: "mock1",
        match: { method: "POST", path: "/trigger", priority: 0 },
        response: { kind: "static", status: 200, body: { ok: true } },
        webhooks: [
          webhookSpec({
            url: receiver.url,
            retry: { attempts: 1, backoff: [], jitterRatio: 0 },
            timeoutMs: 1000,
          }),
        ],
      },
    ];
    const { server } = makeTestServer({ entries });

    await server.hono.fetch(
      new Request("http://localhost/trigger", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
    );
    await tick(300); // allow microtask + delivery + journal

    const metricsResponse = await server.hono.fetch(
      new Request("http://localhost/metrics", {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
    expect(metricsResponse.status).toBe(200);
    const text = await metricsResponse.text();

    // Counter for the success outcome.
    expect(text).toMatch(/mockstar_webhook_delivery_total\{[^}]*outcome="success"[^}]*\}\s+1/);
    // Histogram for delivery latency — at least the bucket lines should exist after one observation.
    expect(text).toContain("mockstar_webhook_delivery_latency_us_bucket");
    // Gauge for queue depth (RT-12) is now refreshed on every state mutation (enqueue,
    // task completion). After delivery completes, depth must be 0 — the gauge tracks
    // reality, not the high-water mark.
    expect(text).toMatch(/mockstar_webhook_queue_depth\{[^}]*tenant="default"[^}]*\}\s+0/);
  });

  test("failed delivery increments _delivery_total{outcome=failed} and surfaces circuit state gauge", async () => {
    const receiver = spawnReceiver(() => new Response("boom", { status: 500 }));
    cleanups = [receiver.close];

    const entries: Entry[] = [
      {
        id: "mock1",
        match: { method: "POST", path: "/trigger", priority: 0 },
        response: { kind: "static", status: 200, body: { ok: true } },
        webhooks: [
          webhookSpec({
            url: receiver.url,
            retry: { attempts: 1, backoff: [], jitterRatio: 0 },
            circuit: { failureThreshold: 1, cooldownMs: 30_000 }, // trip immediately
            timeoutMs: 1000,
          }),
        ],
      },
    ];
    const { server } = makeTestServer({ entries });

    await server.hono.fetch(
      new Request("http://localhost/trigger", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
    );
    await tick(400);

    const metricsResponse = await server.hono.fetch(
      new Request("http://localhost/metrics", {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
    const text = await metricsResponse.text();

    // Failed delivery counter incremented.
    expect(text).toMatch(/mockstar_webhook_delivery_total\{[^}]*outcome="failed"[^}]*\}/);
    // Circuit state gauge present (value 0=closed, 1=open, 2=half-open). At threshold=1 + 1 failure, expect open=1.
    expect(text).toMatch(/mockstar_webhook_circuit_state\{[^}]*\}\s+1/);
  });
});
