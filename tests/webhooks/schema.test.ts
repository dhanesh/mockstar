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

describe("signing schemes (#30) — discriminated union on mode", () => {
  test("a config with no `mode` still parses, and defaults reproduce v0.2.x behaviour", () => {
    const parsed = MockEntry.parse({
      id: "m",
      match: { method: "POST", path: "/x" },
      response: { kind: "static", status: 200, body: {} },
      webhooks: [
        {
          id: "w",
          url: "https://example.test/hook",
          signing: { enabled: true, secretRef: "{{ env.SECRET_X }}" },
        },
      ],
    });
    const signing = parsed.webhooks?.[0]?.signing;
    expect(signing?.mode).toBe("hmac");
    expect(signing?.signedPayload).toBe("{timestamp}.{body}");
    expect(signing?.signatureTemplate).toBe("{algorithm}={signature}");
    expect(signing?.digestEncoding).toBe("hex");
  });

  test("an explicit mode: 'hmac' parses identically", () => {
    const parsed = MockEntry.parse({
      id: "m",
      match: { method: "POST", path: "/x" },
      response: { kind: "static", status: 200, body: {} },
      webhooks: [
        {
          id: "w",
          url: "https://example.test/hook",
          signing: { mode: "hmac", enabled: true, secretRef: "{{ env.SECRET_X }}" },
        },
      ],
    });
    expect(parsed.webhooks?.[0]?.signing?.mode).toBe("hmac");
  });

  test("a GitHub-shaped scheme round-trips", () => {
    const parsed = MockEntry.parse({
      id: "m",
      match: { method: "POST", path: "/x" },
      response: { kind: "static", status: 200, body: {} },
      webhooks: [
        {
          id: "w",
          url: "https://example.test/hook",
          signing: {
            enabled: true,
            secretRef: "{{ env.SECRET_X }}",
            signedPayload: "{body}",
            signatureHeader: "x-hub-signature-256",
          },
        },
      ],
    });
    const signing = parsed.webhooks?.[0]?.signing;
    expect(signing?.signedPayload).toBe("{body}");
    expect(signing?.signatureHeader).toBe("x-hub-signature-256");
  });

  test("digestEncoding accepts base64 (Shopify)", () => {
    const parsed = MockEntry.parse({
      id: "m",
      match: { method: "POST", path: "/x" },
      response: { kind: "static", status: 200, body: {} },
      webhooks: [
        {
          id: "w",
          url: "https://example.test/hook",
          signing: { enabled: true, secretRef: "{{ env.SECRET_X }}", digestEncoding: "base64" },
        },
      ],
    });
    expect(parsed.webhooks?.[0]?.signing?.digestEncoding).toBe("base64");
  });

  test("an unknown placeholder in signedPayload is rejected, and the message names it", () => {
    const build = () =>
      MockEntry.parse({
        id: "m",
        match: { method: "POST", path: "/x" },
        response: { kind: "static", status: 200, body: {} },
        webhooks: [
          {
            id: "w",
            url: "https://example.test/hook",
            signing: { enabled: true, secretRef: "{{ env.SECRET_X }}", signedPayload: "{nonce}.{body}" },
          },
        ],
      });
    expect(build).toThrow(/\{nonce\}/);
  });

  test("a signatureTemplate that omits {signature} is rejected", () => {
    const build = () =>
      MockEntry.parse({
        id: "m",
        match: { method: "POST", path: "/x" },
        response: { kind: "static", status: 200, body: {} },
        webhooks: [
          {
            id: "w",
            url: "https://example.test/hook",
            signing: { enabled: true, secretRef: "{{ env.SECRET_X }}", signatureTemplate: "sha256=" },
          },
        ],
      });
    expect(build).toThrow(/\{signature\}/);
  });

  test("an unknown mode is rejected", () => {
    const build = () =>
      MockEntry.parse({
        id: "m",
        match: { method: "POST", path: "/x" },
        response: { kind: "static", status: 200, body: {} },
        webhooks: [
          {
            id: "w",
            url: "https://example.test/hook",
            signing: { mode: "ed25519", enabled: true, secretRef: "{{ env.SECRET_X }}" },
          },
        ],
      });
    expect(build).toThrow();
  });

  test("{{ body }} (spaced double-brace) in signedPayload is rejected with guidance to use single-brace", () => {
    const build = () =>
      MockEntry.parse({
        id: "m",
        match: { method: "POST", path: "/x" },
        response: { kind: "static", status: 200, body: {} },
        webhooks: [
          {
            id: "w",
            url: "https://example.test/hook",
            signing: { enabled: true, secretRef: "{{ env.SECRET_X }}", signedPayload: "{{ body }}" },
          },
        ],
      });
    expect(build).toThrow(/single-brace/);
  });

  test("{{body}} (tight double-brace) in signedPayload is rejected, not silently accepted as {body}", () => {
    const build = () =>
      MockEntry.parse({
        id: "m",
        match: { method: "POST", path: "/x" },
        response: { kind: "static", status: 200, body: {} },
        webhooks: [
          {
            id: "w",
            url: "https://example.test/hook",
            signing: { enabled: true, secretRef: "{{ env.SECRET_X }}", signedPayload: "{{body}}" },
          },
        ],
      });
    expect(build).toThrow(/single-brace/);
  });

  test("{{signature}} in signatureTemplate is rejected with guidance to use single-brace", () => {
    const build = () =>
      MockEntry.parse({
        id: "m",
        match: { method: "POST", path: "/x" },
        response: { kind: "static", status: 200, body: {} },
        webhooks: [
          {
            id: "w",
            url: "https://example.test/hook",
            signing: { enabled: true, secretRef: "{{ env.SECRET_X }}", signatureTemplate: "{{signature}}" },
          },
        ],
      });
    expect(build).toThrow(/single-brace/);
  });

  test("legitimate single-brace forms still parse (signedPayload and signatureTemplate)", () => {
    const parsed = MockEntry.parse({
      id: "m",
      match: { method: "POST", path: "/x" },
      response: { kind: "static", status: 200, body: {} },
      webhooks: [
        {
          id: "w",
          url: "https://example.test/hook",
          signing: {
            enabled: true,
            secretRef: "{{ env.SECRET_X }}",
            signedPayload: "{timestamp}.{body}",
            signatureTemplate: "{algorithm}={signature}",
          },
        },
      ],
    });
    const signing = parsed.webhooks?.[0]?.signing;
    expect(signing?.signedPayload).toBe("{timestamp}.{body}");
    expect(signing?.signatureTemplate).toBe("{algorithm}={signature}");
  });

  test("v0:{timestampSeconds}:{body} (Slack shape) is accepted", () => {
    const parsed = MockEntry.parse({
      id: "m",
      match: { method: "POST", path: "/x" },
      response: { kind: "static", status: 200, body: {} },
      webhooks: [
        {
          id: "w",
          url: "https://example.test/hook",
          signing: {
            enabled: true,
            secretRef: "{{ env.SECRET_X }}",
            signedPayload: "v0:{timestampSeconds}:{body}",
          },
        },
      ],
    });
    expect(parsed.webhooks?.[0]?.signing?.signedPayload).toBe("v0:{timestampSeconds}:{body}");
  });

  test('a JSON-envelope signedPayload ({"t":{timestamp},"b":{body}}) is accepted — {{ guard is {{ only, not }}', () => {
    const parsed = MockEntry.parse({
      id: "m",
      match: { method: "POST", path: "/x" },
      response: { kind: "static", status: 200, body: {} },
      webhooks: [
        {
          id: "w",
          url: "https://example.test/hook",
          signing: {
            enabled: true,
            secretRef: "{{ env.SECRET_X }}",
            signedPayload: '{"t":{timestamp},"b":{body}}',
          },
        },
      ],
    });
    expect(parsed.webhooks?.[0]?.signing?.signedPayload).toBe('{"t":{timestamp},"b":{body}}');
  });

  test("{ body } (spaced single-brace) in signedPayload is rejected as an unknown placeholder", () => {
    const build = () =>
      MockEntry.parse({
        id: "m",
        match: { method: "POST", path: "/x" },
        response: { kind: "static", status: 200, body: {} },
        webhooks: [
          {
            id: "w",
            url: "https://example.test/hook",
            signing: { enabled: true, secretRef: "{{ env.SECRET_X }}", signedPayload: "{ body }" },
          },
        ],
      });
    expect(build).toThrow(/unknown placeholder/);
    // Must NOT be reported as a {{ }} double-brace mistake — it is single-brace, just spaced.
    expect(build).not.toThrow(/single-brace/);
  });

  test("{time_stamp}.{body} (typo'd placeholder name) in signedPayload is rejected as unknown", () => {
    const build = () =>
      MockEntry.parse({
        id: "m",
        match: { method: "POST", path: "/x" },
        response: { kind: "static", status: 200, body: {} },
        webhooks: [
          {
            id: "w",
            url: "https://example.test/hook",
            signing: { enabled: true, secretRef: "{{ env.SECRET_X }}", signedPayload: "{time_stamp}.{body}" },
          },
        ],
      });
    expect(build).toThrow(/unknown placeholder\(s\) \{time_stamp\}/);
  });

  test("a signedPayload that never references {body} is rejected (#30 finding 2)", () => {
    const build = () =>
      MockEntry.parse({
        id: "m",
        match: { method: "POST", path: "/x" },
        response: { kind: "static", status: 200, body: {} },
        webhooks: [
          {
            id: "w",
            url: "https://example.test/hook",
            signing: { enabled: true, secretRef: "{{ env.SECRET_X }}", signedPayload: "static-nothing" },
          },
        ],
      });
    expect(build).toThrow(/signedPayload must contain \{body\}/);
  });

  test("inline secrets are still rejected under the union (S3 unchanged)", () => {
    const build = () =>
      MockEntry.parse({
        id: "m",
        match: { method: "POST", path: "/x" },
        response: { kind: "static", status: 200, body: {} },
        webhooks: [
          { id: "w", url: "https://example.test/hook", signing: { enabled: true, secretRef: "plain" } },
        ],
      });
    expect(build).toThrow();
  });
});
