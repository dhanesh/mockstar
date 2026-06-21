// Validates: T7 (templating reuse), RT-9 (env namespace)
// @constraint T7 - {{ request.body.x }}, {{ tenant }}, {{ env.X }} render in webhook URL/body/headers

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Entry } from "../../src/core/config/schema.ts";
import { makeTestServer, spawnReceiver, tick, webhookSpec } from "./_helpers.ts";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

describe("T7 / RT-9 — templating in webhook URL, body, and headers", () => {
  beforeEach(() => {
    process.env.MOCKSTAR_TEST_PARTNER_PATH = "/v1/orders";
  });

  test("URL template resolves {{ env.X }} at delivery time", async () => {
    const receiver = spawnReceiver(() => new Response("{}", { status: 200 }));
    cleanups = [receiver.close];

    const entries: Entry[] = [
      {
        id: "mock1",
        match: { method: "POST", path: "/orders", priority: 0 },
        response: { kind: "static", status: 201, body: { ok: true } },
        webhooks: [
          webhookSpec({
            url: `${receiver.url}{{ env.MOCKSTAR_TEST_PARTNER_PATH }}`,
            retry: { attempts: 1, backoff: [], jitterRatio: 0 },
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
    await tick(200);

    expect(receiver.hits.length).toBeGreaterThan(0);
    expect(receiver.hits[0]?.url).toContain("/v1/orders");
  });

  test("body template reflects request.body.x", async () => {
    const receiver = spawnReceiver(() => new Response("{}", { status: 200 }));
    cleanups = [receiver.close];

    const entries: Entry[] = [
      {
        id: "mock1",
        match: { method: "POST", path: "/orders", priority: 0 },
        response: { kind: "static", status: 201, body: { ok: true } },
        webhooks: [
          webhookSpec({
            url: receiver.url,
            body: { received_id: "{{ request.body.id }}", tenant: "{{ tenant }}" },
            headers: { "content-type": "application/json" },
            retry: { attempts: 1, backoff: [], jitterRatio: 0 },
          }),
        ],
      },
    ];
    const { server } = makeTestServer({ entries });

    await server.hono.fetch(
      new Request("http://localhost/orders", {
        method: "POST",
        body: JSON.stringify({ id: "order-42" }),
        headers: { "content-type": "application/json" },
      }),
    );
    await tick(200);

    expect(receiver.hits.length).toBeGreaterThan(0);
    const sentBody = receiver.hits[0]?.body ?? "";
    expect(sentBody).toContain("order-42");
    expect(sentBody).toContain("default"); // tenant token
  });

  test("header template resolves {{ env.X }}", async () => {
    process.env.MOCKSTAR_TEST_AUTH = "Bearer abc-secret";
    const receiver = spawnReceiver(() => new Response("{}", { status: 200 }));
    cleanups = [receiver.close];

    const entries: Entry[] = [
      {
        id: "mock1",
        match: { method: "POST", path: "/orders", priority: 0 },
        response: { kind: "static", status: 201, body: { ok: true } },
        webhooks: [
          webhookSpec({
            url: receiver.url,
            headers: { authorization: "{{ env.MOCKSTAR_TEST_AUTH }}" },
            retry: { attempts: 1, backoff: [], jitterRatio: 0 },
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
    await tick(200);

    expect(receiver.hits.length).toBeGreaterThan(0);
    expect(receiver.hits[0]?.headers.authorization).toBe("Bearer abc-secret");
    delete process.env.MOCKSTAR_TEST_AUTH;
  });
});
