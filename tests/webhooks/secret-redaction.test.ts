// Validates: U3 (INVARIANT — admin /webhooks list redacts signing secrets), S3 (secret never persisted to admin output)
// @constraint U3 - admin endpoints never expose signing secret material
//
// Adversarial test: configure a webhook with signing enabled, set the env-supplied secret,
// hit the admin list endpoint, assert the response contains NO trace of:
//   1. The raw secretRef template (e.g. '{{ env.X }}')
//   2. The resolved secret value (e.g. 'SUPER_SECRET_XYZ')
//   3. The signatureHeader / timestampHeader / replayWindowMs internal config
//   4. Any field named 'secret', 'secretRef', or similar
// Only the SHAPE — { enabled: bool, algorithm: 'sha256' } — should appear.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Entry } from "../../src/core/config/schema.ts";
import { TenantLimits } from "../../src/core/config/schema.ts";
import { SnapshotHolder } from "../../src/core/config/snapshot.ts";
import type { HandlerRegistry } from "../../src/core/handlers/index.ts";
import { buildMatchIndex } from "../../src/core/matching/index.ts";
import { compileEntryResponses } from "../../src/core/templating/compiler.ts";
import { compileWebhookSpecs } from "../../src/features/webhooks/compile.ts";
import { type RunningServer, createServer } from "../../src/server.ts";

const ADMIN_TOKEN = "test-admin-token-32-chars-xxxxxxxx";
const SECRET_VALUE = "SUPER_SECRET_XYZ_DO_NOT_LEAK_42";
const SECRET_REF = "{{ env.MOCKSTAR_TEST_REDACTION_SECRET }}";

const emptyRegistry: HandlerRegistry = Object.freeze({
  get size() {
    return 0;
  },
  has: () => false,
  get: () => undefined,
  names: () => [],
});

let server: RunningServer;

beforeAll(() => {
  process.env.MOCKSTAR_TEST_REDACTION_SECRET = SECRET_VALUE;

  const entries: Entry[] = [
    {
      id: "sensitive-mock",
      match: { method: "POST", path: "/api/sensitive", priority: 0 },
      response: { kind: "static", status: 201, body: { ok: true } },
      webhooks: [
        {
          id: "wh-signed",
          url: "https://api.partner.com/hook",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: { event: "sensitive" },
          retry: { attempts: 6, backoff: [1000, 2000, 4000, 8000, 16000], jitterRatio: 0.2 },
          signing: {
            enabled: true,
            algorithm: "sha256",
            secretRef: SECRET_REF,
            signatureHeader: "x-mockstar-signature",
            timestampHeader: "x-mockstar-timestamp",
            replayWindowMs: 300_000,
          },
          circuit: { failureThreshold: 5, cooldownMs: 30_000 },
          timeoutMs: 5_000,
          allowHttp: false,
          allowPrivateNetworks: false,
          acceptHeaderOverride: true,
        },
      ],
    },
  ];

  const holder = new SnapshotHolder({
    version: 1,
    server: {
      host: "127.0.0.1",
      port: 3000,
      tenancyModes: ["path", "header"],
      deterministic: true,
      adminEnabled: true,
      rootToken: ADMIN_TOKEN,
    },
    tenants: new Map([
      [
        "default",
        {
          name: "default",
          entries,
          matchIndex: buildMatchIndex(entries),
          compiledResponses: compileEntryResponses(entries),
          compiledScenarios: new Map(),
          compiledWebhooks: compileWebhookSpecs(entries),
          limits: TenantLimits.parse({}),
          adminToken: ADMIN_TOKEN,
          allowPrivateUpstreams: false,
        },
      ],
    ]),
    handlers: emptyRegistry,
  });

  server = createServer({
    holder,
    registry: emptyRegistry,
    deterministic: true,
    installCrashHandlers: false,
  });
});

afterAll(() => {
  delete process.env.MOCKSTAR_TEST_REDACTION_SECRET;
});

describe("U3 — admin /webhooks list redacts signing secrets", () => {
  test("GET /__admin/tenants/:tenant/webhooks returns shape-only signing field", async () => {
    const response = await server.hono.fetch(
      new Request("http://localhost/__admin/tenants/default/webhooks", {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
    expect(response.status).toBe(200);
    const text = await response.text();

    // Hard assertion 1: the resolved secret value MUST NOT appear in the response.
    expect(text).not.toContain(SECRET_VALUE);

    // Hard assertion 2: the raw secretRef template MUST NOT appear.
    // (It would leak the env var name to anyone who can read admin output.)
    expect(text).not.toContain("{{ env.MOCKSTAR_TEST_REDACTION_SECRET }}");
    expect(text).not.toContain("MOCKSTAR_TEST_REDACTION_SECRET");

    // Hard assertion 3: keys related to internal signing config MUST NOT appear in the JSON.
    expect(text).not.toMatch(/"secretRef"\s*:/);
    expect(text).not.toMatch(/"signatureHeader"\s*:/);
    expect(text).not.toMatch(/"timestampHeader"\s*:/);
    expect(text).not.toMatch(/"replayWindowMs"\s*:/);

    // Soft assertion: the signing field IS present with shape-only data.
    const body = JSON.parse(text) as { webhooks: Array<{ signing?: Record<string, unknown> }> };
    expect(body.webhooks.length).toBeGreaterThan(0);
    const wh = body.webhooks[0];
    expect(wh?.signing).toBeDefined();
    // Shape-only: only `enabled` and `algorithm` keys.
    expect(Object.keys(wh?.signing!).sort()).toEqual(["algorithm", "enabled"]);
    expect(wh?.signing?.algorithm).toBe("sha256");
    expect(wh?.signing?.enabled).toBe(true);
  });

  test("the listed webhook DOES expose non-sensitive fields (sanity check)", async () => {
    const response = await server.hono.fetch(
      new Request("http://localhost/__admin/tenants/default/webhooks", {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
    const body = (await response.json()) as { webhooks: Array<Record<string, unknown>> };
    const wh = body.webhooks[0];
    expect(wh?.id).toBe("wh-signed");
    expect(wh?.method).toBe("POST");
    expect(wh?.timeoutMs).toBe(5_000);
    expect(wh?.allowHttp).toBe(false);
    expect(wh?.allowPrivateNetworks).toBe(false);
  });

  test("admin list response stringified and substring-scanned for any literal secret leak", async () => {
    const response = await server.hono.fetch(
      new Request("http://localhost/__admin/tenants/default/webhooks", {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
    const text = await response.text();

    // Defense in depth: ANY substring of the secret (even partial leaks via mistruncation).
    for (let i = 0; i < SECRET_VALUE.length - 6; i++) {
      const window = SECRET_VALUE.substring(i, i + 7);
      expect(text).not.toContain(window);
    }
  });

  test("unauthenticated request to /webhooks list is rejected (defense in depth)", async () => {
    // If auth ever regresses, the secret might leak via that path. This guards the guard.
    const response = await server.hono.fetch(
      new Request("http://localhost/__admin/tenants/default/webhooks"),
    );
    expect([401, 403]).toContain(response.status);
  });
});
