// Validates: U3 (INVARIANT — journal never persists secret-bearing URL material; #38)
// Unit coverage for the redaction primitives themselves (WebhookJournalRegistry.record's
// end-to-end wiring across all three sinks is covered by redirect-guard-journal-redaction.test.ts).

import { describe, expect, test } from "bun:test";
import {
  WebhookJournalRegistry,
  redactUrlForJournal,
  redactUrlsInText,
} from "../../src/features/webhooks/journal.ts";
import type { WebhookJournalEntry } from "../../src/features/webhooks/types.ts";

const SECRET = "SUPER-SECRET-TOKEN-DO-NOT-LEAK";

describe("redactUrlForJournal (#38)", () => {
  test("drops the path", () => {
    expect(redactUrlForJournal(`https://hooks.slack.com/services/${SECRET}/T00/B00`)).toBe(
      "https://hooks.slack.com/[redacted]",
    );
  });

  test("drops the query string", () => {
    expect(redactUrlForJournal(`https://api.example.com/hook?token=${SECRET}`)).toBe(
      "https://api.example.com/[redacted]",
    );
  });

  test("drops userinfo (user:pass@)", () => {
    expect(redactUrlForJournal(`https://user:${SECRET}@api.example.com/hook`)).toBe(
      "https://api.example.com/[redacted]",
    );
  });

  test("drops the fragment", () => {
    expect(redactUrlForJournal(`https://api.example.com/hook#${SECRET}`)).toBe(
      "https://api.example.com/[redacted]",
    );
  });

  test("preserves a non-default port", () => {
    expect(redactUrlForJournal(`http://127.0.0.1:4173/services/${SECRET}`)).toBe(
      "http://127.0.0.1:4173/[redacted]",
    );
  });

  test("secret is absent regardless of which URL component carries it", () => {
    for (const url of [
      `https://hooks.slack.com/services/${SECRET}/T00/B00`,
      `https://api.example.com/hook?token=${SECRET}`,
      `https://user:${SECRET}@api.example.com/hook`,
      `https://api.example.com/hook#${SECRET}`,
    ]) {
      expect(redactUrlForJournal(url)).not.toContain(SECRET);
    }
  });

  test("unparseable input redacts to a fixed marker without throwing", () => {
    expect(() => redactUrlForJournal("not a url")).not.toThrow();
    expect(redactUrlForJournal("not a url")).toBe("[redacted:unparseable-url]");
  });
});

describe("redactUrlsInText (#38)", () => {
  test("redacts a URL embedded in a longer error message, preserving the surrounding text", () => {
    const text = `UrlValidationError: URL validation failed for 'https://hooks.slack.com/services/${SECRET}/T00': scheme 'http' not in allowlist (https)`;
    const redacted = redactUrlsInText(text);
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain("scheme 'http' not in allowlist (https)");
    expect(redacted).toContain("https://hooks.slack.com/[redacted]");
  });

  test("redacts multiple embedded URLs in one message", () => {
    const text = `redirected from https://front.example.com/${SECRET} to https://target.example.com/${SECRET}`;
    const redacted = redactUrlsInText(text);
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain("https://front.example.com/[redacted]");
    expect(redacted).toContain("https://target.example.com/[redacted]");
  });

  test("does not swallow trailing punctuation that wraps the URL", () => {
    const text = `webhook delivery redirect rejected: host rejected (https://internal.example.com/${SECRET})`;
    const redacted = redactUrlsInText(text);
    expect(redacted).not.toContain(SECRET);
    expect(redacted.endsWith(")")).toBe(true);
  });

  test("text with no embedded URL is returned unchanged", () => {
    const text = "webhook delivery non-success status: 500";
    expect(redactUrlsInText(text)).toBe(text);
  });
});

describe("WebhookJournalRegistry.record — redaction applied before either sink (#38)", () => {
  const makeEntry = (overrides: Partial<WebhookJournalEntry> = {}): WebhookJournalEntry => ({
    kind: "webhook",
    timestamp: 1_700_000_000_000,
    tenant: "default",
    deliveryId: "d1",
    entryId: "mock-1",
    webhookId: "wh-1",
    triggerRequestId: "req-1",
    attempt: 1,
    outcome: "success",
    durationUs: 100,
    ...overrides,
  });

  test("resolvedUrl is redacted in the in-memory snapshot", () => {
    const reg = new WebhookJournalRegistry(() => 100);
    reg.record(makeEntry({ resolvedUrl: `https://hooks.slack.com/services/${SECRET}/T00` }));
    const [entry] = reg.snapshot("default");
    expect(entry?.resolvedUrl).toBe("https://hooks.slack.com/[redacted]");
    expect(JSON.stringify(entry)).not.toContain(SECRET);
  });

  test("error text is redacted in the in-memory snapshot", () => {
    const reg = new WebhookJournalRegistry(() => 100);
    reg.record(
      makeEntry({
        outcome: "failed",
        error: `UrlValidationError: URL validation failed for 'https://hooks.slack.com/services/${SECRET}': scheme 'http' not in allowlist (https)`,
      }),
    );
    const [entry] = reg.snapshot("default");
    expect(entry?.error).not.toContain(SECRET);
    expect(JSON.stringify(entry)).not.toContain(SECRET);
  });

  test("an entry with neither resolvedUrl nor error is unaffected", () => {
    const reg = new WebhookJournalRegistry(() => 100);
    reg.record(makeEntry({ outcome: "circuit-open" }));
    const [entry] = reg.snapshot("default");
    expect(entry?.resolvedUrl).toBeUndefined();
    expect(entry?.error).toBeUndefined();
  });
});
