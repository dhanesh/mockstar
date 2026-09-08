// Validates: S2/S6 — redirects are revalidated per hop through the REAL dispatcher wiring (#37)
// Validates: journal accuracy — the journaled resolvedUrl reflects the FINAL (post-redirect) URL
// Core SSRF-target-rejected coverage lives in tests/redirect-guard.test.ts (fetchWithRedirectGuard
// unit-integration, where allowPrivateUpstreams:false is actually usable — see that file's header
// comment for why an end-to-end version of that exact case can't be built without real public DNS).
// This file proves dispatcher.ts actually threads validationOpts + the redirect guard through to
// a real delivery.

import { afterEach, describe, expect, test } from "bun:test";
import type { Entry } from "../../src/core/config/schema.ts";
import { DEFAULT_MAX_REDIRECT_HOPS } from "../../src/features/url-validator.ts";
import { makeTestServer, spawnReceiver, tick, webhookSpec } from "./_helpers.ts";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

describe("webhook dispatcher — redirect guard wiring (#37)", () => {
  test("a legitimate redirect is followed end-to-end, delivery succeeds, and the journal records the FINAL URL", async () => {
    let target: ReturnType<typeof spawnReceiver> | null = null;
    const front = spawnReceiver(() => {
      if (!target) throw new Error("target not ready");
      return new Response(null, { status: 302, headers: { location: `${target.url}/landed` } });
    });
    target = spawnReceiver(() => new Response("{}", { status: 200 }));
    cleanups = [front.close, target.close];

    const entries: Entry[] = [
      {
        id: "redirecting-webhook",
        match: { method: "GET", path: "/api/redirect-ok", priority: 0 },
        response: { kind: "static", status: 200, body: { ok: true } },
        webhooks: [
          webhookSpec({
            url: front.url,
            method: "GET",
            body: null,
            retry: { attempts: 1, backoff: [], jitterRatio: 0 },
          }),
        ],
      },
    ];
    const { server } = makeTestServer({ entries });

    const r = await server.hono.fetch(new Request("http://localhost/api/redirect-ok"));
    expect(r.status).toBe(200);
    await tick(300);

    // Delivery reached the redirect TARGET, not just the front.
    expect(target.hits.length).toBe(1);

    const journalEntries = server.webhookJournal.snapshot("default");
    expect(journalEntries.length).toBeGreaterThan(0);
    const last = journalEntries[journalEntries.length - 1];
    expect(last?.outcome).toBe("success");
    // #37: resolvedUrl must be the POST-redirect URL (the actual host reached), not the
    // pre-redirect `front.url` — otherwise a redirect pivot is invisible in the journal.
    expect(last?.resolvedUrl).toBe(`${target.url}/landed`);
    expect(last?.resolvedUrl).not.toBe(front.url);
  });

  test("a relative-path redirect is resolved against the current hop and followed end-to-end", async () => {
    const receiver = spawnReceiver((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/start") {
        return new Response(null, { status: 302, headers: { location: "/landed" } });
      }
      return new Response("{}", { status: 200 });
    });
    cleanups = [receiver.close];

    const entries: Entry[] = [
      {
        id: "relative-redirect-webhook",
        match: { method: "GET", path: "/api/relative-redirect", priority: 0 },
        response: { kind: "static", status: 200, body: { ok: true } },
        webhooks: [
          webhookSpec({
            url: `${receiver.url}/start`,
            method: "GET",
            body: null,
            retry: { attempts: 1, backoff: [], jitterRatio: 0 },
          }),
        ],
      },
    ];
    const { server } = makeTestServer({ entries });

    const r = await server.hono.fetch(new Request("http://localhost/api/relative-redirect"));
    expect(r.status).toBe(200);
    await tick(300);

    expect(receiver.hits.map((h) => new URL(h.url).pathname)).toEqual(["/start", "/landed"]);
    const journalEntries = server.webhookJournal.snapshot("default");
    const last = journalEntries[journalEntries.length - 1];
    expect(last?.outcome).toBe("success");
    expect(last?.resolvedUrl).toBe(`${receiver.url}/landed`);
  });

  test(`hop cap: a receiver that always redirects fails the delivery after ${DEFAULT_MAX_REDIRECT_HOPS} hops instead of looping forever`, async () => {
    const receiver = spawnReceiver(() => new Response(null, { status: 302, headers: { location: "/loop" } }));
    cleanups = [receiver.close];

    const entries: Entry[] = [
      {
        id: "hop-cap-webhook",
        match: { method: "GET", path: "/api/hop-cap", priority: 0 },
        response: { kind: "static", status: 200, body: { ok: true } },
        webhooks: [
          webhookSpec({
            url: `${receiver.url}/loop`,
            method: "GET",
            body: null,
            retry: { attempts: 1, backoff: [], jitterRatio: 0 },
          }),
        ],
      },
    ];
    const { server } = makeTestServer({ entries });

    const r = await server.hono.fetch(new Request("http://localhost/api/hop-cap"));
    expect(r.status).toBe(200);
    await tick(300);

    // Bounded, not unbounded: exactly hop-cap + 1 dials (single retry attempt configured above).
    expect(receiver.hits.length).toBe(DEFAULT_MAX_REDIRECT_HOPS + 1);

    const journalEntries = server.webhookJournal.snapshot("default");
    const last = journalEntries[journalEntries.length - 1];
    expect(last?.outcome).toBe("failed");
    expect(last?.error).toMatch(/redirect rejected/);
    expect(last?.error).toMatch(new RegExp(`redirect chain exceeded ${DEFAULT_MAX_REDIRECT_HOPS} hop`));
  });
});
