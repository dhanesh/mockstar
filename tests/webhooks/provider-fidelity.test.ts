// Validates: B3 (industry contract), S1 (signing opt-in)
// @constraint B3 - a delivery signed for provider X verifies under X's documented algorithm
// @constraint S1 - signing is opt-in per webhook
//
// Each case reimplements the receiver-side check from the named provider's docs and asserts
// mockstar's delivered header passes it. Closing evidence for #30.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { Entry } from "../../src/core/config/schema.ts";
import { makeTestServer, spawnReceiver, tick, webhookSpec } from "./_helpers.ts";

const SECRET = "provider-shared-secret";

beforeAll(() => {
  process.env.MOCKSTAR_TEST_PROVIDER_SECRET = SECRET;
});

afterAll(() => {
  delete process.env.MOCKSTAR_TEST_PROVIDER_SECRET;
});

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

/** Fire one request at a mock configured with `signing`, return the captured delivery. */
async function deliverWith(signing: Record<string, unknown>) {
  const receiver = spawnReceiver(() => new Response("{}", { status: 200 }));
  cleanups.push(receiver.close);

  const entries: Entry[] = [
    {
      id: "mock1",
      match: { method: "POST", path: "/orders", priority: 0 },
      response: { kind: "static", status: 201, body: { ok: true } },
      webhooks: [
        webhookSpec({
          url: receiver.url,
          body: { event: "order.created", id: "ord_1" },
          signing: {
            // Complete fixture on purpose: makeTestServer compiles raw Entry objects with no
            // Zod step, so schema defaults are NOT applied here — every field must be spelled
            // out or the dispatcher receives undefined.
            // The wire values are literals rather than imports of DEFAULT_SIGNED_PAYLOAD /
            // DEFAULT_SIGNATURE_TEMPLATE because this is the fidelity suite: it must pin the
            // expected bytes independently of the constants in the code under test.
            mode: "hmac",
            enabled: true,
            algorithm: "sha256",
            secretRef: "{{ env.MOCKSTAR_TEST_PROVIDER_SECRET }}",
            signedPayload: "{timestamp}.{body}",
            signatureTemplate: "{algorithm}={signature}",
            digestEncoding: "hex",
            signatureHeader: "x-mockstar-signature",
            timestampHeader: "x-mockstar-timestamp",
            replayWindowMs: 300_000,
            ...signing,
          },
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

  expect(receiver.hits.length).toBe(1);
  const hit = receiver.hits[0];
  if (!hit) throw new Error("no delivery captured");
  return hit;
}

describe("B3 — mockstar default (unchanged from v0.2.x)", () => {
  test("timestamped payload, sha256= prefix, hex", async () => {
    const hit = await deliverWith({});
    const ts = hit.headers["x-mockstar-timestamp"];
    expect(ts).toMatch(/^\d{13}$/);
    const expected = createHmac("sha256", SECRET).update(`${ts}.${hit.body}`, "utf8").digest("hex");
    expect(hit.headers["x-mockstar-signature"]).toBe(`sha256=${expected}`);
  });
});

describe("B3 — GitHub (x-hub-signature-256)", () => {
  test("HMAC over the raw body, sha256= prefix, hex", async () => {
    const hit = await deliverWith({
      signedPayload: "{body}",
      signatureHeader: "x-hub-signature-256",
    });
    // Receiver code from GitHub's "Validating webhook deliveries" docs.
    const expected = `sha256=${createHmac("sha256", SECRET).update(hit.body, "utf8").digest("hex")}`;
    expect(hit.headers["x-hub-signature-256"]).toBe(expected);
    // A body-only scheme carries no timestamp, so none is advertised.
    expect(hit.headers["x-mockstar-timestamp"]).toBeUndefined();
  });
});

describe("B3 — Slack (x-slack-signature)", () => {
  test("v0:{ts}:{body} basestring, v0= prefix, seconds timestamp", async () => {
    const hit = await deliverWith({
      signedPayload: "v0:{timestampSeconds}:{body}",
      signatureTemplate: "v0={signature}",
      signatureHeader: "x-slack-signature",
      timestampHeader: "x-slack-request-timestamp",
    });
    const ts = hit.headers["x-slack-request-timestamp"];
    expect(ts).toMatch(/^\d{10}$/);
    const basestring = `v0:${ts}:${hit.body}`;
    const expected = `v0=${createHmac("sha256", SECRET).update(basestring, "utf8").digest("hex")}`;
    expect(hit.headers["x-slack-signature"]).toBe(expected);
  });
});

describe("B3 — Stripe (stripe-signature)", () => {
  test("t=,v1= comma header with a seconds-based signed payload", async () => {
    const hit = await deliverWith({
      signedPayload: "{timestampSeconds}.{body}",
      signatureTemplate: "t={timestampSeconds},v1={signature}",
      signatureHeader: "stripe-signature",
      // Stripe carries its timestamp inside the signature header itself (the `t=` field) —
      // it has no separate timestamp header, so the cookbook suppresses the standalone one.
      timestampHeader: null,
    });
    // Receiver code from Stripe's signature-verification docs: split the header, rebuild
    // signed_payload as `${t}.${body}`, compare v1.
    const header = hit.headers["stripe-signature"] ?? "";
    const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
    expect(parts.t).toMatch(/^\d{10}$/);
    const expected = createHmac("sha256", SECRET).update(`${parts.t}.${hit.body}`, "utf8").digest("hex");
    expect(parts.v1).toBe(expected);
    // No separate x-mockstar-timestamp — the timestamp lives only inside stripe-signature.
    expect(hit.headers["x-mockstar-timestamp"]).toBeUndefined();
  });
});

describe("B3 — Shopify (x-shopify-hmac-sha256)", () => {
  test("HMAC over the raw body, bare base64 digest", async () => {
    const hit = await deliverWith({
      signedPayload: "{body}",
      signatureTemplate: "{signature}",
      digestEncoding: "base64",
      signatureHeader: "x-shopify-hmac-sha256",
    });
    const expected = createHmac("sha256", SECRET).update(hit.body, "utf8").digest("base64");
    expect(hit.headers["x-shopify-hmac-sha256"]).toBe(expected);
    expect(hit.headers["x-shopify-hmac-sha256"]).not.toContain("sha256=");
  });
});

describe("B3 — Razorpay (x-razorpay-signature)", () => {
  test("HMAC over the raw body, bare hex digest", async () => {
    const hit = await deliverWith({
      signedPayload: "{body}",
      signatureTemplate: "{signature}",
      signatureHeader: "x-razorpay-signature",
    });
    const expected = createHmac("sha256", SECRET).update(hit.body, "utf8").digest("hex");
    expect(hit.headers["x-razorpay-signature"]).toBe(expected);
    expect(hit.headers["x-razorpay-signature"]).toMatch(/^[0-9a-f]{64}$/);
  });
});
