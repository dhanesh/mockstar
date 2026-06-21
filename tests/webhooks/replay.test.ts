// Validates: O4 (admin replay endpoint actually re-enqueues), INT-2 (replay using current snapshot's spec)
// @constraint O4 - replay re-enqueues a fresh delivery for an evicted-or-resident journal entry

import { describe, expect, test } from "bun:test";
import type { Entry } from "../../src/core/config/schema.ts";
import { TenantLimits } from "../../src/core/config/schema.ts";
import { SnapshotHolder } from "../../src/core/config/snapshot.ts";
import type { HandlerRegistry } from "../../src/core/handlers/index.ts";
import { buildMatchIndex } from "../../src/core/matching/index.ts";
import { compileEntryResponses } from "../../src/core/templating/compiler.ts";
import { compileWebhookSpecs } from "../../src/features/webhooks/compile.ts";
import { createServer } from "../../src/server.ts";

const ADMIN_TOKEN = "test-admin-token-32-chars-xxxxxxxx";

const emptyRegistry: HandlerRegistry = Object.freeze({
  get size() {
    return 0;
  },
  has: () => false,
  get: () => undefined,
  names: () => [],
});

function buildSnapshotHolder(entries: Entry[]): SnapshotHolder {
  return new SnapshotHolder({
    version: 1,
    server: {
      host: "127.0.0.1",
      port: 3000,
      tenancyModes: ["path", "header"],
      deterministic: true,
      adminEnabled: true,
      rootToken: ADMIN_TOKEN,
    },
    tenants: new Map([
      [
        "default",
        {
          name: "default",
          entries,
          matchIndex: buildMatchIndex(entries),
          compiledResponses: compileEntryResponses(entries),
          compiledScenarios: new Map(),
          compiledWebhooks: compileWebhookSpecs(entries),
          limits: TenantLimits.parse({}),
          adminToken: ADMIN_TOKEN,
          allowPrivateUpstreams: true,
        },
      ],
    ]),
    handlers: emptyRegistry,
  });
}

const ENTRY_WITH_WEBHOOK: Entry = {
  id: "order-create",
  match: { method: "POST", path: "/orders", priority: 0 },
  response: { kind: "static", status: 201, body: { ok: true } },
  webhooks: [
    {
      id: "wh-order",
      url: "http://127.0.0.1:1", // unbound port — delivery will fail (ECONNREFUSED) but synchronously enough to leave a journal entry
      method: "POST",
      body: { event: "order" },
      headers: {},
      retry: { attempts: 1, backoff: [], jitterRatio: 0 },
      circuit: { failureThreshold: 5, cooldownMs: 30_000 },
      timeoutMs: 100,
      allowHttp: true,
      allowPrivateNetworks: true,
      acceptHeaderOverride: true,
    },
  ],
};

describe("O4 / INT-2 — admin replay endpoint re-enqueues", () => {
  test("replay returns 404 for unknown deliveryId", async () => {
    const holder = buildSnapshotHolder([ENTRY_WITH_WEBHOOK]);
    const server = createServer({
      holder,
      registry: emptyRegistry,
      deterministic: true,
      installCrashHandlers: false,
    });

    const response = await server.hono.fetch(
      new Request("http://localhost/__admin/tenants/default/webhooks/no-such-id/replay", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("delivery_not_in_journal");
  });

  test("replay returns 410 when the webhook spec has been removed from snapshot", async () => {
    // Trigger a delivery, capture its deliveryId from the journal, then swap to a snapshot
    // where the webhook spec is gone, and assert replay returns 410 mock_entry_removed.
    const holder = buildSnapshotHolder([ENTRY_WITH_WEBHOOK]);
    const server = createServer({
      holder,
      registry: emptyRegistry,
      deterministic: true,
      installCrashHandlers: false,
    });

    await server.hono.fetch(
      new Request("http://localhost/orders", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
    );
    // Wait for delivery to journal (microtask + fetch failure).
    await new Promise((r) => setTimeout(r, 250));
    const journal = server.webhookJournal.snapshot("default");
    const original = journal[0];
    expect(original).toBeDefined();
    const deliveryId = original?.deliveryId;

    // Swap to a snapshot with no webhooks.
    const ENTRY_NO_WEBHOOK: Entry = { ...ENTRY_WITH_WEBHOOK, webhooks: undefined };
    const newSnap = buildSnapshotHolder([ENTRY_NO_WEBHOOK]).get();
    holder.swap(newSnap);

    const response = await server.hono.fetch(
      new Request(`http://localhost/__admin/tenants/default/webhooks/${deliveryId}/replay`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
    expect(response.status).toBe(410);
    const body = (await response.json()) as { error: string };
    expect(["mock_entry_removed", "webhook_spec_removed"]).toContain(body.error);
  });

  test("replay returns 202 with new deliveryId when spec still exists", async () => {
    const holder = buildSnapshotHolder([ENTRY_WITH_WEBHOOK]);
    const server = createServer({
      holder,
      registry: emptyRegistry,
      deterministic: true,
      installCrashHandlers: false,
    });

    // Trigger an inbound request to populate the journal.
    await server.hono.fetch(
      new Request("http://localhost/orders", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
    );
    await new Promise((r) => setTimeout(r, 250));
    const original = server.webhookJournal.snapshot("default")[0];
    expect(original).toBeDefined();
    const originalDeliveryId = original!.deliveryId;

    // Replay.
    const response = await server.hono.fetch(
      new Request(`http://localhost/__admin/tenants/default/webhooks/${originalDeliveryId}/replay`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      replayQueued: boolean;
      originalDeliveryId: string;
      newDeliveryId: string;
    };
    expect(body.replayQueued).toBe(true);
    expect(body.originalDeliveryId).toBe(originalDeliveryId);
    expect(body.newDeliveryId).toBeDefined();
    expect(body.newDeliveryId).not.toBe(originalDeliveryId);

    // Wait a tick — the replay delivery should journal a row tagged replay:true.
    await new Promise((r) => setTimeout(r, 250));
    const journal = server.webhookJournal.snapshot("default");
    const replayEntry = journal.find((e) => e.deliveryId === body.newDeliveryId);
    expect(replayEntry).toBeDefined();
    expect(replayEntry?.replay).toBe(true);
    expect(replayEntry?.entryId).toBe(original?.entryId);
    expect(replayEntry?.webhookId).toBe(original?.webhookId);
    // Trigger-request linkage preserved (recovery audit trail).
    expect(replayEntry?.triggerRequestId).toBe(original?.triggerRequestId);
  });

  test("replay endpoint requires tenant-scope auth", async () => {
    const holder = buildSnapshotHolder([ENTRY_WITH_WEBHOOK]);
    const server = createServer({
      holder,
      registry: emptyRegistry,
      deterministic: true,
      installCrashHandlers: false,
    });
    const response = await server.hono.fetch(
      new Request("http://localhost/__admin/tenants/default/webhooks/anything/replay", { method: "POST" }),
    );
    expect([401, 403]).toContain(response.status);
  });
});
