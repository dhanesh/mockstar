// Validates: T5 (per-route trigger across response.kind values), T4 (post-response delivery)
// @constraint T5 - webhooks attached to static responses fire post-response

import { afterEach, describe, expect, test } from "bun:test";
import type { Entry } from "../../src/core/config/schema.ts";
import { makeTestServer, spawnReceiver, tick, webhookSpec } from "./_helpers.ts";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

describe("T5 — webhook trigger surface across response.kind", () => {
  test("static response → webhook fires after response flush", async () => {
    const receiver = spawnReceiver(() => new Response("{}", { status: 200 }));
    cleanups = [receiver.close];

    const entries: Entry[] = [
      {
        id: "static-mock",
        match: { method: "GET", path: "/api/static", priority: 0 },
        response: { kind: "static", status: 200, body: { kind: "static-resp" } },
        webhooks: [webhookSpec({ url: receiver.url, retry: { attempts: 1, backoff: [], jitterRatio: 0 } })],
      },
    ];
    const { server } = makeTestServer({ entries });

    const r = await server.hono.fetch(new Request("http://localhost/api/static"));
    expect(r.status).toBe(200);
    await tick(200);
    expect(receiver.hits.length).toBeGreaterThan(0);
  });

  test("multiple webhooks attached to one entry — all fire", async () => {
    const receiver1 = spawnReceiver(() => new Response("{}", { status: 200 }));
    const receiver2 = spawnReceiver(() => new Response("{}", { status: 200 }));
    cleanups = [receiver1.close, receiver2.close];

    const entries: Entry[] = [
      {
        id: "fan-out",
        match: { method: "POST", path: "/api/fanout", priority: 0 },
        response: { kind: "static", status: 201, body: { ok: true } },
        webhooks: [
          webhookSpec({
            id: "wh-1",
            url: receiver1.url,
            retry: { attempts: 1, backoff: [], jitterRatio: 0 },
          }),
          webhookSpec({
            id: "wh-2",
            url: receiver2.url,
            retry: { attempts: 1, backoff: [], jitterRatio: 0 },
          }),
        ],
      },
    ];
    const { server } = makeTestServer({ entries });

    await server.hono.fetch(
      new Request("http://localhost/api/fanout", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
    );
    await tick(300);

    expect(receiver1.hits.length).toBeGreaterThan(0);
    expect(receiver2.hits.length).toBeGreaterThan(0);
  });

  test("entry with NO webhooks attached: response served, no delivery, no journal entry", async () => {
    const entries: Entry[] = [
      {
        id: "no-hook",
        match: { method: "GET", path: "/api/no-hook", priority: 0 },
        response: { kind: "static", status: 200, body: { ok: true } },
      },
    ];
    const { server } = makeTestServer({ entries });

    const r = await server.hono.fetch(new Request("http://localhost/api/no-hook"));
    expect(r.status).toBe(200);
    await tick(150);
    expect(server.webhookJournal.snapshot("default")).toHaveLength(0);
  });

  test("unmatched request — no webhooks fire (404 path)", async () => {
    const receiver = spawnReceiver(() => new Response("{}", { status: 200 }));
    cleanups = [receiver.close];

    const entries: Entry[] = [
      {
        id: "mock1",
        match: { method: "GET", path: "/api/specific", priority: 0 },
        response: { kind: "static", status: 200, body: { ok: true } },
        webhooks: [webhookSpec({ url: receiver.url })],
      },
    ];
    const { server } = makeTestServer({ entries });

    const r = await server.hono.fetch(new Request("http://localhost/api/different"));
    expect(r.status).toBe(404);
    await tick(150);
    expect(receiver.hits.length).toBe(0);
  });
});
