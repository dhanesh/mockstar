// #59 — `X-Mockstar-Delivery-Id` used to carry the TRIGGERING REQUEST id, so every webhook one
// request fired shared it and a receiver that deduplicates on it dropped all but the first.
// It now carries the delivery's own id (the journal `deliveryId`, the one replay takes): one
// value per delivery, the same across that delivery's retries. The request id moved to
// `X-Mockstar-Request-Id`.

import { afterEach, describe, expect, test } from "bun:test";
import type { Entry } from "../../src/core/config/schema.ts";
import { ADMIN_TOKEN, makeTestServer, spawnReceiver, tick, webhookSpec } from "./_helpers.ts";

type Server = ReturnType<typeof makeTestServer>["server"];

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function entries(url: string, specs: Array<Record<string, unknown>> = [{}]): Entry[] {
  return [
    {
      id: "order-create",
      match: { method: "POST", path: "/orders", priority: 0 },
      response: { kind: "static", status: 201, body: { ok: true } },
      webhooks: specs.map((s, i) => webhookSpec({ id: `wh-${i}`, url, ...s })),
    },
  ];
}

const post = (server: Server): Promise<Response> =>
  Promise.resolve(server.hono.fetch(new Request("http://localhost/orders", { method: "POST", body: "{}" })));

async function replay(server: Server, deliveryId: string): Promise<string> {
  const res = await server.hono.fetch(
    new Request(`http://localhost/__admin/tenants/default/webhooks/${deliveryId}/replay`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    }),
  );
  expect(res.status).toBeLessThan(300);
  return ((await res.json()) as { newDeliveryId: string }).newDeliveryId;
}

const deliveryHeader = (h: { headers: Record<string, string> }): string =>
  h.headers["x-mockstar-delivery-id"] ?? "";
const requestHeader = (h: { headers: Record<string, string> }): string =>
  h.headers["x-mockstar-request-id"] ?? "";

describe("#59 X-Mockstar-Delivery-Id is per delivery", () => {
  test("two webhooks fired by one request get different delivery ids", async () => {
    const r = spawnReceiver(() => new Response("{}", { status: 200 }));
    cleanups = [r.close];
    const { server } = makeTestServer({ entries: entries(r.url, [{}, {}]) });

    await post(server);
    await tick(250);

    expect(r.hits).toHaveLength(2);
    const ids = r.hits.map(deliveryHeader);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  test("retries of one delivery send the same delivery id", async () => {
    let n = 0;
    const r = spawnReceiver(() => new Response("{}", { status: ++n < 3 ? 503 : 200 }));
    cleanups = [r.close];
    const { server } = makeTestServer({
      entries: entries(r.url, [{ retry: { attempts: 3, backoff: [1, 1], jitterRatio: 0 } }]),
    });

    await post(server);
    await tick(400);

    expect(r.hits).toHaveLength(3);
    expect(new Set(r.hits.map(deliveryHeader)).size).toBe(1);
  });

  test("the header is the journal deliveryId, so a receiver can replay what it saw", async () => {
    const r = spawnReceiver(() => new Response("{}", { status: 200 }));
    cleanups = [r.close];
    const { server } = makeTestServer({ entries: entries(r.url) });

    await post(server);
    await tick(250);

    const seen = deliveryHeader(r.hits[0] ?? { headers: {} });
    const journal = server.webhookJournal.snapshot("default");
    expect(journal.map((e) => e.deliveryId)).toContain(seen);
    // The id the receiver saw works on the await and replay endpoints.
    const awaited = await server.hono.fetch(
      new Request(`http://localhost/__admin/tenants/default/webhooks/await?id=${seen}&timeoutMs=500`, {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
    expect(awaited.status).toBe(200);
    await replay(server, seen);
  });

  test("non-deterministic mode: UUID delivery ids, distinct per webhook, matching the journal", async () => {
    const r = spawnReceiver(() => new Response("{}", { status: 200 }));
    cleanups = [r.close];
    const { server } = makeTestServer({
      entries: entries(r.url, [{}, {}]),
      serverOpts: { deterministic: false },
    });

    await post(server);
    await tick(250);

    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const ids = r.hits.map(deliveryHeader);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => uuid.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(2);
    const journal = server.webhookJournal.snapshot("default");
    expect(new Set(journal.map((e) => e.deliveryId))).toEqual(new Set(ids));
    expect(r.hits.map(requestHeader)).toEqual(journal.map((e) => e.triggerRequestId));
  });

  test("a replay is a new delivery: its header is the new deliveryId; request id is kept", async () => {
    const r = spawnReceiver(() => new Response("{}", { status: 200 }));
    cleanups = [r.close];
    const { server } = makeTestServer({ entries: entries(r.url) });

    await post(server);
    await tick(250);
    const original = r.hits[0] ?? { headers: {} };
    const newId = await replay(server, deliveryHeader(original));
    await tick(250);

    const replayed = r.hits[1] ?? { headers: {} };
    expect(deliveryHeader(replayed)).toBe(newId);
    expect(deliveryHeader(replayed)).not.toBe(deliveryHeader(original));
    expect(requestHeader(replayed)).toBe(requestHeader(original));
  });

  test("X-Mockstar-Request-Id carries the triggering request id", async () => {
    const r = spawnReceiver(() => new Response("{}", { status: 200 }));
    cleanups = [r.close];
    const { server } = makeTestServer({ entries: entries(r.url, [{}, {}]) });

    await post(server);
    await tick(250);

    const reqIds = r.hits.map(requestHeader);
    expect(reqIds).toEqual(["req-00000001", "req-00000001"]);
    expect(
      server.webhookJournal.snapshot("default").every((e) => e.triggerRequestId === "req-00000001"),
    ).toBe(true);
  });

  test("a delivery-id header set in the webhook spec still wins", async () => {
    const r = spawnReceiver(() => new Response("{}", { status: 200 }));
    cleanups = [r.close];
    const { server } = makeTestServer({
      entries: entries(r.url, [{ headers: { "x-mockstar-delivery-id": "evt-{{tenant}}" } }]),
    });

    await post(server);
    await tick(250);

    expect(deliveryHeader(r.hits[0] ?? { headers: {} })).toBe("evt-default");
  });

  test("deterministic mode: same request sequence gives the same delivery ids across servers", async () => {
    const rA = spawnReceiver(() => new Response("{}", { status: 200 }));
    const rB = spawnReceiver(() => new Response("{}", { status: 200 }));
    cleanups = [rA.close, rB.close];
    const a = makeTestServer({ entries: entries(rA.url, [{}, {}]) }).server;
    const b = makeTestServer({ entries: entries(rB.url, [{}, {}]) }).server;

    for (let i = 0; i < 2; i++) {
      await post(a);
      await post(b);
    }
    await tick(300);

    const ids = (hits: typeof rA.hits): string[] => hits.map(deliveryHeader).sort();
    expect(ids(rA.hits)).toHaveLength(4);
    expect(new Set(ids(rA.hits)).size).toBe(4);
    expect(ids(rA.hits)).toEqual(ids(rB.hits));
  });
});
