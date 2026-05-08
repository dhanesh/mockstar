// Validates: INT-1 (--webhook-journal-file JSONL append-on-record), T2 (in-memory primary, file optional)
// @constraint T2 - in-memory ring buffer is primary; file write is best-effort durable

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebhookJournalRegistry } from "../../src/features/webhooks/journal.ts";
import type { WebhookJournalEntry } from "../../src/features/webhooks/types.ts";

const makeEntry = (deliveryId: string, attempt: number): WebhookJournalEntry => ({
  kind: "webhook",
  timestamp: 1700000000000 + attempt * 1000,
  tenant: "default",
  deliveryId,
  entryId: "mock-entry-1",
  webhookId: "wh-test",
  triggerRequestId: "req-001",
  attempt,
  outcome: attempt < 3 ? "success" : "failed",
  durationUs: 1234,
});

describe("INT-1 — WebhookJournalRegistry --webhook-journal-file", () => {
  let workDir: string;
  let logPath: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "mockstar-journal-"));
    logPath = join(workDir, "webhooks.jsonl");
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("without journalFile: ring buffer is the only sink (no file ever opened)", () => {
    const reg = new WebhookJournalRegistry(() => 100);
    reg.record(makeEntry("d1", 1));
    expect(reg.snapshot("default")).toHaveLength(1);
    // No assertion on logPath here — the registry without journalFile MUST NOT touch any path.
  });

  test("with journalFile: every record() appends a JSONL line synchronously", () => {
    const reg = new WebhookJournalRegistry(() => 100, { journalFile: logPath });
    reg.record(makeEntry("d1", 1));
    reg.record(makeEntry("d1", 2));
    reg.record(makeEntry("d2", 1));

    const content = readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line) as WebhookJournalEntry;
      expect(parsed.kind).toBe("webhook");
      expect(parsed.tenant).toBe("default");
    }
    // First line is d1/attempt 1, last is d2/attempt 1.
    expect((JSON.parse(lines[0]!) as WebhookJournalEntry).deliveryId).toBe("d1");
    expect((JSON.parse(lines[2]!) as WebhookJournalEntry).deliveryId).toBe("d2");
  });

  test("file write failure does not throw or break the in-memory journal", () => {
    // Point at a path inside a non-existent dir — appendFileSync will fail.
    const badPath = join(workDir, "no-such-dir", "webhooks.jsonl");
    const reg = new WebhookJournalRegistry(() => 100, { journalFile: badPath });
    // Must not throw — registry's record() is best-effort durable.
    expect(() => reg.record(makeEntry("d99", 1))).not.toThrow();
    // In-memory side still works.
    expect(reg.snapshot("default")).toHaveLength(1);
  });

  test("journal file lines preserve the entry shape including replay flag", () => {
    const replayLogPath = join(workDir, "replay.jsonl");
    const reg = new WebhookJournalRegistry(() => 100, { journalFile: replayLogPath });
    const replayEntry: WebhookJournalEntry = { ...makeEntry("d-replay", 1), replay: true };
    reg.record(replayEntry);
    const parsed = JSON.parse(readFileSync(replayLogPath, "utf8").trim()) as WebhookJournalEntry;
    expect(parsed.replay).toBe(true);
  });
});
