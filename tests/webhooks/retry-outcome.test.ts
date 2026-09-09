// Validates: issue #44 — non-final failed attempts must NOT journal as outcome:"success".
// @constraint issue-44 - U4's whole purpose is an honest assertion surface: a delivery that
//   has not (yet) succeeded must never satisfy `entries.some(e => e.outcome === "success")`.
//
// Before the fix, src/features/webhooks/queue.ts:234 recorded every failed-but-will-retry
// attempt as outcome:"success" (with an `error` field populated) — the inline comment admitted
// "'success' here means we'll retry". These tests prove the real per-tenant journal (not just
// the queue's callback) now records 'retrying' for those rows and 'success' ONLY for an attempt
// that actually succeeded.

import { afterEach, describe, expect, test } from "bun:test";
import type { Entry } from "../../src/core/config/schema.ts";
import type { AttemptRecord } from "../../src/features/webhooks/queue.ts";
import { BoundedRetryQueue, type QueuedDelivery } from "../../src/features/webhooks/queue.ts";
import type { DeliverySummary } from "../../src/features/webhooks/types.ts";
import { makeTestServer, spawnReceiver, tick, webhookSpec } from "./_helpers.ts";

describe("BoundedRetryQueue per-attempt outcome (issue #44, unit-level)", () => {
  test("fails twice then succeeds: first two attempts journal 'retrying', third journals 'success'", async () => {
    const q = new BoundedRetryQueue({ concurrency: 1, cap: 4 });
    const attempts: AttemptRecord[] = [];
    const terminal = Promise.withResolvers<DeliverySummary>();
    let calls = 0;

    const delivery: QueuedDelivery = {
      deliveryId: "d1",
      tenant: "default",
      webhookId: "wh1",
      triggerRequestId: "req-d1",
      attempt: async () => {
        calls += 1;
        if (calls < 3) throw new Error("transient");
        return { httpStatus: 200, durationUs: 1, resolvedUrl: "https://ex.com" };
      },
      retry: { attempts: 3, backoff: [1, 1], jitterRatio: 0 },
      onAttempt: (record) => attempts.push(record),
      onTerminal: (s) => terminal.resolve(s),
      circuitGate: () => "closed",
      recordCircuitOutcome: () => undefined,
    };
    q.enqueue(delivery);
    const summary = await terminal.promise;

    expect(summary.outcome).toBe("success");
    expect(attempts).toHaveLength(3);
    expect(attempts[0]?.outcome).toBe("retrying");
    expect(attempts[1]?.outcome).toBe("retrying");
    expect(attempts[2]?.outcome).toBe("success");
    // Never a "success" mislabel on a failed attempt (the exact #44 false-green case).
    expect(attempts.filter((a) => a.outcome === "success")).toHaveLength(1);
  });

  test("exhausts all retries: no attempt EVER journals as 'success' — all-but-last are 'retrying', last is 'failed'", async () => {
    const q = new BoundedRetryQueue({ concurrency: 1, cap: 4 });
    const attempts: AttemptRecord[] = [];
    const terminal = Promise.withResolvers<DeliverySummary>();

    const delivery: QueuedDelivery = {
      deliveryId: "d2",
      tenant: "default",
      webhookId: "wh1",
      triggerRequestId: "req-d2",
      attempt: async () => {
        throw new Error("permanent failure");
      },
      retry: { attempts: 3, backoff: [1, 1], jitterRatio: 0 },
      onAttempt: (record) => attempts.push(record),
      onTerminal: (s) => terminal.resolve(s),
      circuitGate: () => "closed",
      recordCircuitOutcome: () => undefined,
    };
    q.enqueue(delivery);
    const summary = await terminal.promise;

    expect(summary.outcome).toBe("failed");
    expect(attempts).toHaveLength(3);
    expect(attempts[0]?.outcome).toBe("retrying");
    expect(attempts[1]?.outcome).toBe("retrying");
    expect(attempts[2]?.outcome).toBe("failed");
    // This is the exact false-green case from issue #44: an exhausted delivery must
    // never have ANY attempt journaled as 'success'.
    expect(attempts.some((a) => a.outcome === "success")).toBe(false);
  });
});

describe("Webhook journal outcome via the real dispatcher (issue #44, integration)", () => {
  let cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
  });

  test("real journal: fails twice then succeeds — journal rows are retrying, retrying, success", async () => {
    let hitCount = 0;
    const receiver = spawnReceiver(() => {
      hitCount += 1;
      if (hitCount < 3) return new Response("nope", { status: 500 });
      return new Response("{}", { status: 200 });
    });
    cleanups = [receiver.close];

    const entries: Entry[] = [
      {
        id: "mock1",
        match: { method: "POST", path: "/orders", priority: 0 },
        response: { kind: "static", status: 201, body: { ok: true } },
        webhooks: [
          webhookSpec({
            url: receiver.url,
            retry: { attempts: 3, backoff: [10, 10], jitterRatio: 0 },
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
    await tick(300); // long enough for 2 backoff sleeps (10ms each) + 3 real HTTP round trips

    const rows = server.webhookJournal.snapshot("default");
    expect(rows).toHaveLength(3);
    const byAttempt = [...rows].sort((a, b) => a.attempt - b.attempt);
    expect(byAttempt[0]?.outcome).toBe("retrying");
    expect(byAttempt[1]?.outcome).toBe("retrying");
    expect(byAttempt[2]?.outcome).toBe("success");
    // The exact false-green assertion from issue #44 must now be true only once, on the
    // attempt that actually succeeded — never on either of the two that failed.
    expect(rows.filter((r) => r.outcome === "success")).toHaveLength(1);
  });

  test("real journal: exhausts retries — no row is ever journaled as 'success' (the false-green case)", async () => {
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
            retry: { attempts: 3, backoff: [10, 10], jitterRatio: 0 },
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
    await tick(300);

    const rows = server.webhookJournal.snapshot("default");
    expect(rows).toHaveLength(3);
    // THIS is the assertion from the issue text: `entries.some(e => e.outcome === "success")`
    // must be false for a webhook that never actually succeeded.
    expect(rows.some((r) => r.outcome === "success")).toBe(false);
    const byAttempt = [...rows].sort((a, b) => a.attempt - b.attempt);
    expect(byAttempt[0]?.outcome).toBe("retrying");
    expect(byAttempt[1]?.outcome).toBe("retrying");
    expect(byAttempt[2]?.outcome).toBe("failed");
  });
});
