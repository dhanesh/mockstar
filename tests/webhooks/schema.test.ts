// Validates: RT-8 (Zod schema extension), B2 (URL is a template), B5 (acceptHeaderOverride field), S3 (inline secret rejected)
// @constraint S3 - inline signing secrets rejected at config-load
// @constraint RT-8 - WebhookSpec accepted on MockEntry as additive field

import { describe, expect, test } from "bun:test";
import { MockEntry, WebhookSpec } from "../../src/core/config/schema.ts";

describe("WebhookSpec schema (RT-8, B2, B5, S3)", () => {
  test("parses minimal webhook spec with defaults", () => {
    const parsed = WebhookSpec.parse({ id: "wh1", url: "https://example.com/hook" });
    expect(parsed.method).toBe("POST");
    expect(parsed.retry.attempts).toBe(6);
    expect(parsed.retry.backoff).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(parsed.retry.jitterRatio).toBeCloseTo(0.2);
    expect(parsed.circuit.failureThreshold).toBe(5);
    expect(parsed.circuit.cooldownMs).toBe(30_000);
    expect(parsed.timeoutMs).toBe(5_000);
    expect(parsed.allowHttp).toBe(false);
    expect(parsed.allowPrivateNetworks).toBe(false);
    expect(parsed.acceptHeaderOverride).toBe(true);
    expect(parsed.signing).toBeUndefined();
  });

  test("signing.secretRef accepts {{ env.NAME }} form", () => {
    const parsed = WebhookSpec.parse({
      id: "wh1",
      url: "https://example.com/hook",
      signing: { enabled: true, secretRef: "{{ env.SECRET_X }}" },
    });
    expect(parsed.signing?.secretRef).toBe("{{ env.SECRET_X }}");
  });

  test("signing.secretRef accepts file:// path", () => {
    const parsed = WebhookSpec.parse({
      id: "wh1",
      url: "https://example.com/hook",
      signing: { enabled: true, secretRef: "file:/etc/mockstar/secret" },
    });
    expect(parsed.signing?.secretRef).toBe("file:/etc/mockstar/secret");
  });

  test("signing.secretRef rejects inline string (S3)", () => {
    expect(() =>
      WebhookSpec.parse({
        id: "wh1",
        url: "https://example.com/hook",
        signing: { enabled: true, secretRef: "plain-text-secret" },
      }),
    ).toThrow();
  });

  test("retry.backoff length must equal attempts - 1", () => {
    expect(() =>
      WebhookSpec.parse({
        id: "wh1",
        url: "https://example.com/hook",
        retry: { attempts: 3, backoff: [1000] }, // length 1, expected 2
      }),
    ).toThrow(/backoff length/);
  });

  test("expectResponse status accepts both number and array", () => {
    const single = WebhookSpec.parse({
      id: "wh1",
      url: "https://example.com/hook",
      expectResponse: { status: 202 },
    });
    expect(single.expectResponse?.status).toBe(202);
    const multi = WebhookSpec.parse({
      id: "wh2",
      url: "https://example.com/hook",
      expectResponse: { status: [200, 202] },
    });
    expect(multi.expectResponse?.status).toEqual([200, 202]);
  });
});

describe("MockEntry accepts webhooks[] as additive field (RT-8)", () => {
  test("entry without webhooks parses fine — additive (B4 zero-config)", () => {
    expect(() =>
      MockEntry.parse({
        id: "mock1",
        match: { path: "/api/x" },
        response: { kind: "static", status: 200, body: { ok: true } },
      }),
    ).not.toThrow();
  });

  test("entry with one webhook parses", () => {
    const entry = MockEntry.parse({
      id: "mock1",
      match: { path: "/api/x" },
      response: { kind: "static", status: 200, body: { ok: true } },
      webhooks: [{ id: "wh1", url: "https://api.partner.com/hook" }],
    });
    expect(entry.webhooks).toHaveLength(1);
  });

  test("webhooks ceiling = 10", () => {
    const tenWebhooks = Array.from({ length: 11 }, (_, i) => ({
      id: `wh${i}`,
      url: "https://example.com/hook",
    }));
    expect(() =>
      MockEntry.parse({
        id: "mock1",
        match: { path: "/api/x" },
        response: { kind: "static", status: 200, body: { ok: true } },
        webhooks: tenWebhooks,
      }),
    ).toThrow();
  });
});
