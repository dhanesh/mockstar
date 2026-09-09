// Validates: U3 (INVARIANT — webhook journal never persists secret-bearing URL material; #38)
// @constraint U3 - the journal must not leak `{{ env.NAME }}`-templated secrets in resolvedUrl
//
// dispatcher.ts:268 (pre-fix) journaled the POST-template `resolvedUrl`. Provider webhook URLs
// (Slack/Discord/Teams) carry a bearer secret in their PATH, and templating supports
// `{{ env.NAME }}` in any position — so a URL built from an env secret was persisted in
// cleartext to three places: the in-memory ring buffer, the admin journal endpoint response,
// and --webhook-journal-file. Assert the secret VALUE is absent from all three, not merely that
// the shape looks redacted (a wrong-but-plausible redaction could still leak the value).

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entry } from "../../src/core/config/schema.ts";
import { ADMIN_TOKEN, makeTestServer, spawnReceiver, tick, webhookSpec } from "./_helpers.ts";

const SECRET_VALUE = "xoxb-SUPER-SECRET-WEBHOOK-BEARER-TOKEN-42";
const SECRET_ENV_VAR = "MOCKSTAR_TEST_JOURNAL_SECRET";

describe("webhook journal redacts secret-bearing URLs (#38)", () => {
  let workDir: string;
  let journalFilePath: string;
  let receiver: ReturnType<typeof spawnReceiver>;

  beforeAll(() => {
    process.env[SECRET_ENV_VAR] = SECRET_VALUE;
    workDir = mkdtempSync(join(tmpdir(), "mockstar-journal-redaction-"));
    journalFilePath = join(workDir, "webhooks.jsonl");
    receiver = spawnReceiver(() => new Response("{}", { status: 200 }));
  });

  afterAll(() => {
    delete process.env[SECRET_ENV_VAR];
    receiver.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  let cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
  });

  test("secret value is absent from the in-memory journal, the admin endpoint, and the journal file", async () => {
    const entries: Entry[] = [
      {
        id: "secret-in-path",
        match: { method: "GET", path: "/api/trigger-secret", priority: 0 },
        response: { kind: "static", status: 200, body: { ok: true } },
        webhooks: [
          webhookSpec({
            // Secret embedded in the PATH — the realistic Slack/Discord/Teams shape.
            url: `${receiver.url}/services/{{ env.${SECRET_ENV_VAR} }}/T00/B00`,
            method: "GET",
            body: null,
            retry: { attempts: 1, backoff: [], jitterRatio: 0 },
          }),
        ],
      },
    ];
    const { server } = makeTestServer({
      entries,
      serverOpts: { webhookJournalFile: journalFilePath },
    });

    const r = await server.hono.fetch(new Request("http://localhost/api/trigger-secret"));
    expect(r.status).toBe(200);
    await tick(300);

    // Sanity: the delivery actually happened and actually carried the secret over the wire
    // (proves this test isn't trivially "passing" because nothing fired).
    expect(receiver.hits.length).toBe(1);
    expect(receiver.hits[0]?.url).toContain(SECRET_VALUE);

    // --- Sink 1: in-memory ring buffer ---
    const journalEntries = server.webhookJournal.snapshot("default");
    expect(journalEntries.length).toBeGreaterThan(0);
    const last = journalEntries[journalEntries.length - 1];
    expect(last?.outcome).toBe("success");
    expect(JSON.stringify(last)).not.toContain(SECRET_VALUE);
    // Positive check: the redaction didn't throw the baby out with the bathwater — the
    // journal is still useful for "which webhook fired, to which host, with what outcome".
    expect(last?.resolvedUrl).toBe(`${new URL(receiver.url).origin}/[redacted]`);
    expect(last?.webhookId).toBe("wh-test");
    expect(last?.entryId).toBe("secret-in-path");

    // --- Sink 2: admin journal endpoint ---
    const adminRes = await server.hono.fetch(
      new Request("http://localhost/__admin/tenants/default/webhooks/journal", {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
    expect(adminRes.status).toBe(200);
    const adminText = await adminRes.text();
    expect(adminText).not.toContain(SECRET_VALUE);
    // Defense in depth: any 8+ char substring of the secret (partial-truncation leaks).
    for (let i = 0; i < SECRET_VALUE.length - 8; i++) {
      expect(adminText).not.toContain(SECRET_VALUE.substring(i, i + 9));
    }
    expect(adminText).toContain(new URL(receiver.url).origin);

    // --- Sink 3: --webhook-journal-file ---
    // Synchronous append in WebhookJournalRegistry.record — file should already be flushed.
    const fileContent = readFileSync(journalFilePath, "utf8");
    expect(fileContent.length).toBeGreaterThan(0);
    expect(fileContent).not.toContain(SECRET_VALUE);
    expect(fileContent).toContain(new URL(receiver.url).origin);
  });

  test("secret embedded via userinfo or query string is also absent from every sink", async () => {
    const entries: Entry[] = [
      {
        id: "secret-in-query",
        match: { method: "GET", path: "/api/trigger-secret-query", priority: 0 },
        response: { kind: "static", status: 200, body: { ok: true } },
        webhooks: [
          webhookSpec({
            url: `${receiver.url}/hook?token={{ env.${SECRET_ENV_VAR} }}`,
            method: "GET",
            body: null,
            retry: { attempts: 1, backoff: [], jitterRatio: 0 },
          }),
        ],
      },
    ];
    const { server } = makeTestServer({
      entries,
      serverOpts: { webhookJournalFile: journalFilePath },
    });

    const r = await server.hono.fetch(new Request("http://localhost/api/trigger-secret-query"));
    expect(r.status).toBe(200);
    await tick(300);

    expect(receiver.hits.some((h) => h.url.includes(SECRET_VALUE))).toBe(true);

    const journalEntries = server.webhookJournal.snapshot("default");
    const last = journalEntries[journalEntries.length - 1];
    expect(JSON.stringify(last)).not.toContain(SECRET_VALUE);
    expect(last?.resolvedUrl).toBe(`${new URL(receiver.url).origin}/[redacted]`);

    const adminRes = await server.hono.fetch(
      new Request("http://localhost/__admin/tenants/default/webhooks/journal", {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
    const adminText = await adminRes.text();
    expect(adminText).not.toContain(SECRET_VALUE);

    const fileContent = readFileSync(journalFilePath, "utf8");
    expect(fileContent).not.toContain(SECRET_VALUE);
  });

  test("a secret leaked into an error message (URL rejected by the validator) is also redacted", async () => {
    // Force initial-validation failure: allowHttp:false (https-only) against a plain-http
    // receiver whose URL embeds the secret. The pre-fix code let a UrlValidationError's raw
    // message (which embeds the full rejected URL) propagate straight into AttemptRecord.error.
    const entries: Entry[] = [
      {
        id: "secret-in-rejected-url",
        match: { method: "GET", path: "/api/trigger-secret-rejected", priority: 0 },
        response: { kind: "static", status: 200, body: { ok: true } },
        webhooks: [
          webhookSpec({
            url: `${receiver.url}/services/{{ env.${SECRET_ENV_VAR} }}/T00/B00`,
            method: "GET",
            body: null,
            retry: { attempts: 1, backoff: [], jitterRatio: 0 },
            allowHttp: false, // receiver is http:// — initial validation must reject
          }),
        ],
      },
    ];
    const { server } = makeTestServer({
      entries,
      serverOpts: { webhookJournalFile: journalFilePath },
    });

    const r = await server.hono.fetch(new Request("http://localhost/api/trigger-secret-rejected"));
    expect(r.status).toBe(200);
    await tick(300);

    const journalEntries = server.webhookJournal.snapshot("default");
    const last = journalEntries[journalEntries.length - 1];
    expect(last?.outcome).toBe("failed");
    expect(last?.error).toBeDefined();
    expect(last?.error).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(last)).not.toContain(SECRET_VALUE);

    const adminRes = await server.hono.fetch(
      new Request("http://localhost/__admin/tenants/default/webhooks/journal", {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
    const adminText = await adminRes.text();
    expect(adminText).not.toContain(SECRET_VALUE);

    const fileContent = readFileSync(journalFilePath, "utf8");
    expect(fileContent).not.toContain(SECRET_VALUE);
  });
});
