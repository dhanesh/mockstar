// #53 — webhook payloads are seeded like the response that triggered them: by the mock
// entry's deterministic hit number. Before, fan-out and replay built `idHelpers` with
// `requestCounter: 0`, so every delivery of an entry minted the SAME `{{id()}}` values.

import { afterEach, describe, expect, test } from "bun:test";
import type { Entry } from "../../src/core/config/schema.ts";
import { ADMIN_TOKEN, makeTestServer, spawnReceiver, tick, webhookSpec } from "./_helpers.ts";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function entries(url: string): Entry[] {
  return [
    {
      id: "order-create",
      match: { method: "POST", path: "/orders", priority: 0 },
      response: { kind: "static", status: 201, body: { ok: true } },
      webhooks: [
        webhookSpec({
          url,
          // String body: an object body is JSON.stringify'd before compiling, which escapes the
          // quotes inside `id("evt_", 14)` and breaks the token (separate, pre-existing bug).
          body: '{"evt":"{{id("evt_", 14)}}","uuid":"{{faker.uuid}}"}',
          headers: { "content-type": "application/json" },
        }),
      ],
    },
    {
      id: "noise",
      match: { method: "GET", path: "/noise", priority: 0 },
      response: { kind: "static", status: 200, body: { ok: true } },
    },
  ];
}

const post = async (server: ReturnType<typeof makeTestServer>["server"]): Promise<Response> =>
  server.hono.fetch(
    new Request("http://localhost/orders", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    }),
  );

describe("#53 webhook seeding follows the triggering hit", () => {
  test("each delivery of an entry gets its own id() values", async () => {
    const receiver = spawnReceiver(() => new Response("{}", { status: 200 }));
    cleanups = [receiver.close];
    const { server } = makeTestServer({ entries: entries(receiver.url) });

    for (let i = 0; i < 3; i++) await post(server);
    await tick(250);

    const evts = receiver.hits.map((h) => (JSON.parse(h.body) as { evt: string }).evt);
    expect(evts).toHaveLength(3);
    expect(new Set(evts).size).toBe(3);
  });

  test("other traffic does not change a delivery's payload", async () => {
    const rA = spawnReceiver(() => new Response("{}", { status: 200 }));
    const rB = spawnReceiver(() => new Response("{}", { status: 200 }));
    cleanups = [rA.close, rB.close];
    const a = makeTestServer({ entries: entries(rA.url) }).server;
    const b = makeTestServer({ entries: entries(rB.url) }).server;

    await a.hono.fetch(new Request("http://localhost/noise"));
    await post(a);
    await post(b);
    await tick(250);

    expect(rA.hits[0]?.body).toBe(rB.hits[0]?.body);
  });

  test("replay of the 2nd delivery reproduces the 2nd payload", async () => {
    const receiver = spawnReceiver(() => new Response("{}", { status: 200 }));
    cleanups = [receiver.close];
    const { server } = makeTestServer({ entries: entries(receiver.url) });

    await post(server);
    await post(server);
    await tick(250);
    expect(receiver.hits).toHaveLength(2);
    const second = receiver.hits[1]?.body;

    const triggerOfSecond = server.webhookJournal
      .snapshot("default")
      .filter((e) => e.triggerRequestId === "req-00000002");
    const deliveryId = triggerOfSecond[0]?.deliveryId;
    expect(deliveryId).toBeDefined();

    const res = await server.hono.fetch(
      new Request(`http://localhost/__admin/tenants/default/webhooks/${deliveryId}/replay`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
    expect(res.status).toBeLessThan(300);
    await tick(250);

    expect(receiver.hits).toHaveLength(3);
    expect(receiver.hits[2]?.body).toBe(second);
  });
});
