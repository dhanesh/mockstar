// Validates: issue #40 — launch().stop() must not leave webhook retry/await timers running.
// @constraint issue-40 - BoundedRetryQueue.stop() and DeliveryEventRegistry.stop() cancel every
//   live timer AND settle every promise that was waiting on one; nothing is left to keep the
//   event loop (or a caller) alive after stop() returns.
//
// These tests are deliberately BEHAVIOURAL, not flag-checking: each one proves either (a) the
// timer bookkeeping is actually empty after stop(), or (b) a promise that would otherwise hang
// until a real backoff/timeout elapsed instead settles promptly. A test that only asserted an
// internal `#stopped` boolean would prove nothing about hanging handles.

import { afterEach, describe, expect, test } from "bun:test";
import type { Entry } from "../../src/core/config/schema.ts";
import { DeliveryEventRegistry } from "../../src/features/webhooks/event-registry.ts";
import { BoundedRetryQueue, type QueuedDelivery } from "../../src/features/webhooks/queue.ts";
import type { DeliverySummary } from "../../src/features/webhooks/types.ts";
import { makeTestServer, spawnReceiver, tick, webhookSpec } from "./_helpers.ts";

function makeFailingDelivery(
  id: string,
  retry: QueuedDelivery["retry"],
  onTerminal: (s: DeliverySummary) => void,
): QueuedDelivery {
  return {
    deliveryId: id,
    tenant: "default",
    webhookId: "wh1",
    triggerRequestId: `req-${id}`,
    attempt: async () => {
      throw new Error("always fails");
    },
    retry,
    onAttempt: () => undefined,
    onTerminal,
    circuitGate: () => "closed",
    recordCircuitOutcome: () => undefined,
  };
}

describe("BoundedRetryQueue.stop() (issue #40)", () => {
  test("cancels a live backoff timer and settles the pending delivery instead of hanging", async () => {
    const q = new BoundedRetryQueue({ concurrency: 1, cap: 4 });
    const terminal = Promise.withResolvers<DeliverySummary>();

    // Backoff ladder deliberately huge (60s, 60s) — if stop() did NOT cancel the timer,
    // this test would hang for a full minute instead of failing fast.
    q.enqueue(
      makeFailingDelivery("d1", { attempts: 3, backoff: [60_000, 60_000], jitterRatio: 0 }, (s) =>
        terminal.resolve(s),
      ),
    );

    // Let the first attempt run and fail, putting the delivery to sleep in backoff.
    await tick(30);
    expect(q.liveTimerCount()).toBe(1); // one live backoff timer, tracked

    q.stop();

    // The timer bookkeeping must be empty immediately — this IS the "no live handle" proof.
    expect(q.liveTimerCount()).toBe(0);

    // And the promise that was awaiting that timer must settle, not hang forever.
    const summary = await Promise.race([
      terminal.promise,
      tick(500).then(() => {
        throw new Error("onTerminal never fired — stop() left the delivery hanging");
      }),
    ]);
    expect(summary.outcome).toBe("failed");
    expect(summary.totalAttempts).toBe(1); // only the first (real) attempt ran; backoff was cut short
  });

  test("waiting (never-dispatched) deliveries terminate immediately on stop()", async () => {
    const q = new BoundedRetryQueue({ concurrency: 1, cap: 4 });
    const slow = Promise.withResolvers<{ httpStatus: number; durationUs: number; resolvedUrl: string }>();
    const inflightTerminal = Promise.withResolvers<DeliverySummary>();
    const waitingTerminal = Promise.withResolvers<DeliverySummary>();

    q.enqueue({
      deliveryId: "inflight",
      tenant: "default",
      webhookId: "wh1",
      triggerRequestId: "req-inflight",
      attempt: () => slow.promise,
      retry: { attempts: 1, backoff: [], jitterRatio: 0 },
      onAttempt: () => undefined,
      onTerminal: (s) => inflightTerminal.resolve(s),
      circuitGate: () => "closed",
      recordCircuitOutcome: () => undefined,
    });
    q.enqueue(
      makeFailingDelivery("waiting", { attempts: 1, backoff: [], jitterRatio: 0 }, (s) =>
        waitingTerminal.resolve(s),
      ),
    );
    expect(q.waiting()).toBe(1); // concurrency:1 keeps "waiting" queued behind "inflight"

    q.stop();

    const waitingSummary = await waitingTerminal.promise;
    expect(waitingSummary.outcome).toBe("dropped");

    // In-flight attempt is left to settle (issue #40 decision), not aborted.
    slow.resolve({ httpStatus: 200, durationUs: 1, resolvedUrl: "https://ex.com" });
    const inflightSummary = await inflightTerminal.promise;
    expect(inflightSummary.outcome).toBe("success");
  });

  test("stop() is idempotent and enqueue() after stop() drops immediately, no new timer", async () => {
    const q = new BoundedRetryQueue({ concurrency: 1, cap: 4 });
    q.stop();
    q.stop(); // must not throw or double-fire anything

    const terminal = Promise.withResolvers<DeliverySummary>();
    q.enqueue(
      makeFailingDelivery("late", { attempts: 3, backoff: [60_000], jitterRatio: 0 }, (s) =>
        terminal.resolve(s),
      ),
    );
    const summary = await terminal.promise;
    expect(summary.outcome).toBe("dropped");
    expect(q.liveTimerCount()).toBe(0);
  });
});

describe("DeliveryEventRegistry.stop() (issue #40)", () => {
  test("settles a pending await() with null instead of hanging until its timeout", async () => {
    const reg = new DeliveryEventRegistry();
    const pending = reg.await("d1", 60_000); // would otherwise hang up to 60s
    expect(reg.pendingCount()).toBe(1);

    reg.stop();
    expect(reg.pendingCount()).toBe(0); // no live handle left behind

    const got = await Promise.race([
      pending,
      tick(500).then(() => {
        throw new Error("await() never resolved — stop() left the awaiter hanging");
      }),
    ]);
    expect(got).toBeNull();
  });

  test("stop() with no pending awaiters is a safe no-op", () => {
    const reg = new DeliveryEventRegistry();
    expect(() => reg.stop()).not.toThrow();
    expect(reg.pendingCount()).toBe(0);
  });
});

describe("RunningServer.stopWebhooks() / launch().stop() integration (issue #40)", () => {
  let cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
  });

  test("a webhook mid-backoff is settled promptly once the server is stopped", async () => {
    const receiver = spawnReceiver(() => new Response("nope", { status: 500 }));
    cleanups = [receiver.close];

    const entries: Entry[] = [
      {
        id: "mock1",
        match: { method: "POST", path: "/orders", priority: 0 },
        response: { kind: "static", status: 201, body: { ok: true } },
        webhooks: [
          webhookSpec({
            url: receiver.url,
            retry: { attempts: 4, backoff: [60_000, 60_000, 60_000], jitterRatio: 0 },
          }),
        ],
      },
    ];
    const { server } = makeTestServer({ entries });

    await server.hono.fetch(
      new Request("http://localhost/orders", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
    );

    // Let the first attempt fail and the delivery settle into a (long) backoff sleep.
    await tick(100);
    const entriesBefore = server.webhookJournal.snapshot("default");
    expect(entriesBefore.length).toBeGreaterThan(0);
    const deliveryId = entriesBefore[0]?.deliveryId;
    if (!deliveryId) throw new Error("test setup: no deliveryId recorded");

    // This is what launch().stop() calls (issue #40 fix).
    server.stopWebhooks();

    // Without the fix, this await would hang for up to 60s waiting on the cancelled backoff
    // to elapse naturally. With the fix, the delivery is force-terminated at stop() time.
    const summary = await Promise.race([
      server.webhookEvents.await(deliveryId, 2_000),
      tick(1_000).then(() => {
        throw new Error("webhookEvents.await() did not settle promptly after stopWebhooks()");
      }),
    ]);
    expect(summary?.outcome).toBe("failed");

    // No further attempts should have been recorded after stop().
    await tick(150);
    const entriesAfter = server.webhookJournal.snapshot("default");
    const attemptCount = entriesAfter.filter((e) => e.deliveryId === deliveryId).length;
    // 1 real attempt (the one that ran before stop) — stop() must not let a second attempt fire.
    expect(attemptCount).toBe(1);
  });
});
