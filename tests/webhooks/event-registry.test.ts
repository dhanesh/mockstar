// Validates: U1 (sync await), RT-14 (Promise-registry primitive), TN3 (lifecycle separation)
// @constraint U1 - sync await endpoint resolves on terminal state
// @constraint RT-14 - in-process delivery-state event registry

import { describe, expect, test } from "bun:test";
import { DeliveryEventRegistry } from "../../src/features/webhooks/event-registry.ts";
import type { DeliverySummary } from "../../src/features/webhooks/types.ts";

const summary = (id: string, outcome: DeliverySummary["outcome"] = "success"): DeliverySummary => ({
  deliveryId: id,
  outcome,
  totalAttempts: 1,
  totalDurationUs: 100,
});

describe("DeliveryEventRegistry (U1, RT-14)", () => {
  test("await resolves when publish fires", async () => {
    const reg = new DeliveryEventRegistry();
    const pending = reg.await("d1", 1000);
    reg.publish(summary("d1"));
    const got = await pending;
    expect(got?.outcome).toBe("success");
  });

  test("await returns null on timeout", async () => {
    const reg = new DeliveryEventRegistry();
    const got = await reg.await("absent", 50);
    expect(got).toBeNull();
  });

  test("late subscriber within retention sees the cached summary", async () => {
    const reg = new DeliveryEventRegistry({ retentionMs: 5000 });
    reg.publish(summary("d2"));
    // Subscribe AFTER publish — should resolve immediately from cache.
    const got = await reg.await("d2", 1000);
    expect(got?.outcome).toBe("success");
  });

  test("late subscriber after retention expiry returns null", async () => {
    const reg = new DeliveryEventRegistry({ retentionMs: 1 });
    reg.publish(summary("d3"));
    await new Promise((r) => setTimeout(r, 5));
    const got = await reg.await("d3", 50);
    expect(got).toBeNull();
  });

  test("publish resolves any in-flight awaiter", async () => {
    const reg = new DeliveryEventRegistry();
    expect(reg.pendingCount()).toBe(0);
    const pending = reg.await("d4", 1000);
    expect(reg.pendingCount()).toBe(1);
    reg.publish(summary("d4"));
    await pending;
    expect(reg.pendingCount()).toBe(0);
  });

  test("all four terminal outcomes propagate (success, failed, dropped, circuit-open)", async () => {
    const reg = new DeliveryEventRegistry();
    for (const outcome of ["success", "failed", "dropped", "circuit-open"] as const) {
      const id = `d-${outcome}`;
      const pending = reg.await(id, 1000);
      reg.publish(summary(id, outcome));
      const got = await pending;
      expect(got?.outcome).toBe(outcome);
    }
  });
});
