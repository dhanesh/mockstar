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

const BODY = '{"evt":"{{id("evt_", 14)}}","uuid":"{{faker.uuid}}"}';

async function replay(
  server: ReturnType<typeof makeTestServer>["server"],
  deliveryId: string,
): Promise<void> {
  const res = await server.hono.fetch(
    new Request(`http://localhost/__admin/tenants/default/webhooks/${deliveryId}/replay`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    }),
  );
  expect(res.status).toBeLessThan(300);
}

function entries(url: string): Entry[] {
  return [
    {
      id: "order-create",
      match: { method: "POST", path: "/orders", priority: 0 },
      response: { kind: "static", status: 201, body: { ok: true } },
      webhooks: [
        webhookSpec({
          url,
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

    expect(rA.hits).toHaveLength(1);
    expect(rB.hits).toHaveLength(1);
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

  test("replay of the 2nd webhook on an entry reproduces that webhook, not the 1st", async () => {
    const receiver = spawnReceiver(() => new Response("{}", { status: 200 }));
    cleanups = [receiver.close];
    const twoHooks: Entry[] = [
      {
        id: "order-create",
        match: { method: "POST", path: "/orders", priority: 0 },
        response: { kind: "static", status: 201, body: { ok: true } },
        webhooks: [
          webhookSpec({ id: "wh-1", url: `${receiver.url}/one`, body: BODY }),
          webhookSpec({ id: "wh-2", url: `${receiver.url}/two`, body: BODY }),
        ],
      },
    ];
    const { server } = makeTestServer({ entries: twoHooks });

    await post(server);
    await tick(250);
    expect(receiver.hits).toHaveLength(2);
    const bodyOf = (suffix: string): string | undefined =>
      receiver.hits.find((h) => h.url.endsWith(suffix))?.body;
    const one = bodyOf("/one");
    const two = bodyOf("/two");
    expect(one).not.toBe(two); // each spec has its own stream

    const wh2 = server.webhookJournal.snapshot("default").find((e) => e.webhookId === "wh-2");
    expect(wh2?.triggerSeq).toBe(1);
    await replay(server, wh2?.deliveryId ?? "");
    await tick(250);
    expect(receiver.hits).toHaveLength(3);
    expect(receiver.hits[2]?.url.endsWith("/two")).toBe(true);
    expect(receiver.hits[2]?.body).toBe(two);
  });

  test("a retried delivery sends the same payload, and replay reproduces it", async () => {
    let calls = 0;
    const receiver = spawnReceiver(() => new Response("{}", { status: calls++ === 0 ? 500 : 200 }));
    cleanups = [receiver.close];
    const retrying: Entry[] = [
      {
        id: "order-create",
        match: { method: "POST", path: "/orders", priority: 0 },
        response: { kind: "static", status: 201, body: { ok: true } },
        webhooks: [
          webhookSpec({
            url: receiver.url,
            body: BODY,
            retry: { attempts: 2, backoff: [10], jitterRatio: 0 },
          }),
        ],
      },
    ];
    const { server } = makeTestServer({ entries: retrying });

    await post(server);
    await tick(400);
    expect(receiver.hits).toHaveLength(2);
    expect(receiver.hits[1]?.body).toBe(receiver.hits[0]?.body);

    const deliveryId = server.webhookJournal.snapshot("default")[0]?.deliveryId ?? "";
    await replay(server, deliveryId);
    await tick(250);
    expect(receiver.hits).toHaveLength(3);
    expect(receiver.hits[2]?.body).toBe(receiver.hits[0]?.body);
  });

  test("non-deterministic mode does not journal triggerSeq", async () => {
    const receiver = spawnReceiver(() => new Response("{}", { status: 200 }));
    cleanups = [receiver.close];
    const { server } = makeTestServer({
      entries: entries(receiver.url),
      serverOpts: { deterministic: false },
    });
    await post(server);
    await tick(250);
    const rows = server.webhookJournal.snapshot("default");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.triggerSeq).toBeUndefined();
  });
});
