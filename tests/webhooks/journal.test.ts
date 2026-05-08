// Validates: U4 (delivery rows), RT-11 (per-tenant journal), TN7 (replay scope = ring-resident)
// @constraint U4 - WebhookJournalRegistry stores delivery attempts as discrete entries

import { describe, expect, test } from "bun:test";
import { WebhookJournalRegistry } from "../../src/features/webhooks/journal.ts";
import type { WebhookJournalEntry } from "../../src/features/webhooks/types.ts";

const make = (deliveryId: string, attempt: number, tenant = "default"): WebhookJournalEntry => ({
  kind: "webhook",
  timestamp: 1700000000000 + attempt,
  tenant,
  deliveryId,
  entryId: "mock-1",
  webhookId: "wh-1",
  triggerRequestId: `req-${deliveryId}`,
  attempt,
  outcome: "success",
  durationUs: 100,
});

describe("WebhookJournalRegistry (U4, RT-11)", () => {
  test("records and returns entries oldest-first", () => {
    const reg = new WebhookJournalRegistry(() => 100);
    reg.record(make("d1", 1));
    reg.record(make("d1", 2));
    reg.record(make("d2", 1));
    const snap = reg.snapshot("default");
    expect(snap).toHaveLength(3);
    expect(snap[0]?.deliveryId).toBe("d1");
    expect(snap[0]?.attempt).toBe(1);
    expect(snap[2]?.deliveryId).toBe("d2");
  });

  test("per-tenant isolation — entries do not cross tenant lines", () => {
    const reg = new WebhookJournalRegistry(() => 100);
    reg.record(make("d1", 1, "tenantA"));
    reg.record(make("d2", 1, "tenantB"));
    expect(reg.snapshot("tenantA")).toHaveLength(1);
    expect(reg.snapshot("tenantB")).toHaveLength(1);
    expect(reg.snapshot("absent")).toHaveLength(0);
  });

  test("ring-buffer eviction at capacity — oldest dropped (TN7)", () => {
    const reg = new WebhookJournalRegistry(() => 4); // tiny cap
    for (let i = 1; i <= 6; i++) reg.record(make("d", i));
    const snap = reg.snapshot("default");
    expect(snap).toHaveLength(4);
    // Oldest two should have evicted; remaining are attempts 3..6.
    expect(snap[0]?.attempt).toBe(3);
    expect(snap[3]?.attempt).toBe(6);
  });

  test("findLatestByDeliveryId returns the newest matching attempt", () => {
    const reg = new WebhookJournalRegistry(() => 100);
    reg.record(make("d1", 1));
    reg.record(make("d1", 2));
    reg.record(make("d2", 1));
    reg.record(make("d1", 3));
    const found = reg.findLatestByDeliveryId("default", "d1");
    expect(found?.attempt).toBe(3);
  });

  test("findLatestByDeliveryId returns null for evicted (TN7 scope = ring-resident)", () => {
    const reg = new WebhookJournalRegistry(() => 2);
    reg.record(make("evicted", 1));
    reg.record(make("alive", 1));
    reg.record(make("alive", 2)); // pushes 'evicted' out
    expect(reg.findLatestByDeliveryId("default", "evicted")).toBeNull();
    expect(reg.findLatestByDeliveryId("default", "alive")).not.toBeNull();
  });

  test("findLatestByDeliveryId returns null for unknown tenant", () => {
    const reg = new WebhookJournalRegistry(() => 100);
    reg.record(make("d1", 1));
    expect(reg.findLatestByDeliveryId("other-tenant", "d1")).toBeNull();
  });
});
