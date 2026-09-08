// @constraint S2/S6 — SSRF revalidation must apply to EVERY redirect hop, not just the initial URL (#37)
// Exercises `fetchWithRedirectGuard` directly with real local receivers (Bun.serve) and real
// `fetch()` calls — this is the exact function both src/features/webhooks/dispatcher.ts and
// src/features/pass-through.ts call for every outbound delivery/proxy attempt.
//
// Why not go through the full webhook/pass-through path for the core SSRF case: the real F1
// DNS-resolution guard (assertResolvedHostPublic) resolves hostnames via the OS resolver with no
// test-time override at the dispatcher/pass-through call sites, and a hostname that resolves to
// 127.0.0.1 (the only reachable target in CI) is ALWAYS private per that same guard — so an
// end-to-end "public initial host, private redirect target" setup can't be built without a real
// external network. `fetchWithRedirectGuard` documents that it does NOT re-validate its
// `initialUrl` (the caller already did) — only redirect targets — so we simulate "already-passed
// a public initial URL" by handing it a trusted local receiver directly, then prove the private
// REDIRECT TARGET still gets rejected. End-to-end wiring (dispatcher.ts / pass-through.ts
// threading validationOpts + journaling the final URL) is covered separately in
// tests/webhooks/redirect-guard.integration.test.ts and tests/pass-through-redirect-guard.test.ts.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_REDIRECT_HOPS,
  UrlValidationError,
  fetchWithRedirectGuard,
} from "../src/features/url-validator.ts";
import { spawnReceiver } from "./webhooks/_helpers.ts";

describe("fetchWithRedirectGuard — redirects are revalidated per hop (#37)", () => {
  test("does not follow a redirect to a private/loopback address — the target is never dialed", async () => {
    let metadataReceiver: ReturnType<typeof spawnReceiver> | null = null;
    const frontReceiver = spawnReceiver(() => {
      if (!metadataReceiver) throw new Error("metadataReceiver not ready");
      return new Response(null, {
        status: 302,
        headers: { location: `${metadataReceiver.url}/latest/meta-data/` },
      });
    });
    metadataReceiver = spawnReceiver(() => new Response("SECRET-METADATA", { status: 200 }));

    try {
      await expect(
        fetchWithRedirectGuard(
          new URL(frontReceiver.url),
          { method: "GET", headers: new Headers(), body: null },
          { allowedSchemes: ["http"], allowPrivateUpstreams: false },
        ),
      ).rejects.toThrow(UrlValidationError);

      // The (trusted-by-caller) initial hop was dialed exactly once...
      expect(frontReceiver.hits.length).toBe(1);
      // ...but the redirect target — the SSRF pivot — was NEVER reached.
      expect(metadataReceiver.hits.length).toBe(0);
    } finally {
      frontReceiver.close();
      metadataReceiver.close();
    }
  });

  test("a protocol-relative Location (//host/path) cannot smuggle a disallowed host past validation", async () => {
    let metadataReceiver: ReturnType<typeof spawnReceiver> | null = null;
    const frontReceiver = spawnReceiver(() => {
      if (!metadataReceiver) throw new Error("metadataReceiver not ready");
      // No scheme in the Location — still resolves to a concrete (different) host via the
      // authority component of a protocol-relative reference (RFC 9110 §10.2.2 relative-ref).
      return new Response(null, {
        status: 302,
        headers: { location: `//127.0.0.1:${metadataReceiver.port}/pivot` },
      });
    });
    metadataReceiver = spawnReceiver(() => new Response("SECRET-METADATA", { status: 200 }));

    try {
      await expect(
        fetchWithRedirectGuard(
          new URL(frontReceiver.url),
          { method: "GET", headers: new Headers(), body: null },
          { allowedSchemes: ["http"], allowPrivateUpstreams: false },
        ),
      ).rejects.toThrow(UrlValidationError);
      expect(metadataReceiver.hits.length).toBe(0);
    } finally {
      frontReceiver.close();
      metadataReceiver.close();
    }
  });

  test("a plain relative Location (path-only) is resolved against the CURRENT hop and followed", async () => {
    const receiver = spawnReceiver((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/start") {
        return new Response(null, { status: 302, headers: { location: "/next" } });
      }
      return new Response("landed", { status: 200 });
    });
    try {
      const result = await fetchWithRedirectGuard(
        new URL(`${receiver.url}/start`),
        { method: "GET", headers: new Headers(), body: null },
        { allowedSchemes: ["http"], allowPrivateUpstreams: true },
      );
      expect(result.response.status).toBe(200);
      expect(await result.response.text()).toBe("landed");
      expect(result.finalUrl.pathname).toBe("/next");
      expect(result.redirectsFollowed).toBe(1);
      expect(receiver.hits.map((h) => new URL(h.url).pathname)).toEqual(["/start", "/next"]);
    } finally {
      receiver.close();
    }
  });

  test(`hop cap: a receiver that always redirects is stopped after ${DEFAULT_MAX_REDIRECT_HOPS} hops with a typed error, not an infinite loop`, async () => {
    const receiver = spawnReceiver(() => new Response(null, { status: 302, headers: { location: "/loop" } }));
    try {
      await expect(
        fetchWithRedirectGuard(
          new URL(`${receiver.url}/loop`),
          { method: "GET", headers: new Headers(), body: null },
          { allowedSchemes: ["http"], allowPrivateUpstreams: true },
        ),
      ).rejects.toThrow(new RegExp(`redirect chain exceeded ${DEFAULT_MAX_REDIRECT_HOPS} hop`));
      // Exactly hop-cap + 1 dials: the initial fetch, then one per followed redirect, then the
      // fetch whose redirect gets rejected instead of followed.
      expect(receiver.hits.length).toBe(DEFAULT_MAX_REDIRECT_HOPS + 1);
    } finally {
      receiver.close();
    }
  });

  test("a redirect chain within the hop cap, across two different hosts, succeeds end-to-end", async () => {
    let target: ReturnType<typeof spawnReceiver> | null = null;
    const front = spawnReceiver(() => {
      if (!target) throw new Error("target not ready");
      return new Response(null, { status: 302, headers: { location: target.url } });
    });
    target = spawnReceiver(() => new Response("ok-from-target", { status: 200 }));

    try {
      const result = await fetchWithRedirectGuard(
        new URL(front.url),
        { method: "GET", headers: new Headers(), body: null },
        { allowedSchemes: ["http"], allowPrivateUpstreams: true },
      );
      expect(result.response.status).toBe(200);
      expect(await result.response.text()).toBe("ok-from-target");
      expect(result.finalUrl.href).toBe(new URL(target.url).href);
      expect(target.hits.length).toBe(1);
    } finally {
      front.close();
      target.close();
    }
  });

  test("allowPrivateUpstreams:true carries forward to the redirect target — a route that legitimately allows private upstreams isn't broken by its first redirect", async () => {
    let target: ReturnType<typeof spawnReceiver> | null = null;
    const front = spawnReceiver(() => {
      if (!target) throw new Error("target not ready");
      return new Response(null, { status: 302, headers: { location: target.url } });
    });
    target = spawnReceiver(() => new Response("private-target-ok", { status: 200 }));

    try {
      // Both hosts are 127.0.0.1 (private/loopback) — this only succeeds if the redirect-target
      // validation reused allowPrivateUpstreams:true from `validation`, not a stricter default.
      const result = await fetchWithRedirectGuard(
        new URL(front.url),
        { method: "GET", headers: new Headers(), body: null },
        { allowedSchemes: ["http"], allowPrivateUpstreams: true },
      );
      expect(result.response.status).toBe(200);
      expect(await result.response.text()).toBe("private-target-ok");
    } finally {
      front.close();
      target.close();
    }
  });

  test("303 on a POST switches the next hop to GET with no body", async () => {
    const receiver = spawnReceiver((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/start") {
        return new Response(null, { status: 303, headers: { location: "/final" } });
      }
      return new Response("ok", { status: 200 });
    });
    try {
      await fetchWithRedirectGuard(
        new URL(`${receiver.url}/start`),
        { method: "POST", headers: new Headers({ "content-type": "text/plain" }), body: "original-body" },
        { allowedSchemes: ["http"], allowPrivateUpstreams: true },
      );
      expect(receiver.hits).toHaveLength(2);
      expect(receiver.hits[0]?.method).toBe("POST");
      expect(receiver.hits[0]?.body).toBe("original-body");
      expect(receiver.hits[1]?.method).toBe("GET");
      expect(receiver.hits[1]?.body).toBe("");
    } finally {
      receiver.close();
    }
  });

  test("307 on a POST preserves method and resends the body on the next hop", async () => {
    const receiver = spawnReceiver((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/start") {
        return new Response(null, { status: 307, headers: { location: "/final" } });
      }
      return new Response("ok", { status: 200 });
    });
    try {
      await fetchWithRedirectGuard(
        new URL(`${receiver.url}/start`),
        { method: "POST", headers: new Headers({ "content-type": "text/plain" }), body: "original-body" },
        { allowedSchemes: ["http"], allowPrivateUpstreams: true },
      );
      expect(receiver.hits).toHaveLength(2);
      expect(receiver.hits[0]?.method).toBe("POST");
      expect(receiver.hits[1]?.method).toBe("POST");
      expect(receiver.hits[1]?.body).toBe("original-body");
    } finally {
      receiver.close();
    }
  });

  test("a 3xx with no Location header is returned to the caller untouched (not treated as a redirect)", async () => {
    const receiver = spawnReceiver(() => new Response("no location here", { status: 302 }));
    try {
      const result = await fetchWithRedirectGuard(
        new URL(receiver.url),
        { method: "GET", headers: new Headers(), body: null },
        { allowedSchemes: ["http"], allowPrivateUpstreams: true },
      );
      expect(result.response.status).toBe(302);
      expect(result.redirectsFollowed).toBe(0);
      expect(receiver.hits.length).toBe(1);
    } finally {
      receiver.close();
    }
  });
});
