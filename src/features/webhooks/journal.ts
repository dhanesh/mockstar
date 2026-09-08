// Satisfies: U4 (delivery rows in journal), RT-11 (per-tenant journal accommodates webhook rows)
// Satisfies: O4 (admin replay endpoint reads from this), TN7 (replay scope = ring-buffer-resident)
// Satisfies: T2 (in-memory only) + INT-1 (--webhook-journal-file optional JSONL append)
// Satisfies: U3 (INVARIANT — secret material never persisted; #38)

import { appendFileSync } from "node:fs";
import { RingBuffer } from "../../core/journal/ring-buffer.ts";
import type { WebhookJournalEntry } from "./types.ts";

/**
 * Redact a single URL down to `<origin>/[redacted]` for persistence (#38).
 *
 * Webhook URLs support `{{ env.NAME }}` templating in any position, and provider
 * webhook URLs (Slack, Discord, Teams, ...) carry a bearer secret in their PATH —
 * not just the query string or userinfo. `URL.origin` never includes userinfo,
 * path, query, or fragment, so keeping only it and replacing everything else with
 * a fixed marker strips all three secret-bearing components in one step, while
 * still recording exactly which host/port/scheme was actually reached — the part
 * an SDET asserting "which webhook fired, to which host" actually needs.
 *
 * Unparseable input (should not happen for a URL that already passed `fetch()`,
 * but the journal must never throw) redacts to a fixed marker with no host at all.
 */
export function redactUrlForJournal(rawUrl: string): string {
  try {
    return `${new URL(rawUrl).origin}/[redacted]`;
  } catch {
    return "[redacted:unparseable-url]";
  }
}

// Matches an http(s) URL up to (but excluding) whitespace, quotes, or common
// enclosing/punctuation characters an error message might wrap it in — e.g.
// "... rejected (https://host/secret-path)" must not swallow the trailing ')'
// into the redacted span (cosmetic only; under- vs over-matching that
// punctuation can't cause a leak either way since only `.origin` is kept below).
const EMBEDDED_URL_PATTERN = /\bhttps?:\/\/[^\s'"()<>[\]{}]+/gi;

/**
 * Redact every http(s) URL embedded in free-form text (e.g. an `error` message
 * that happened to interpolate a rejected/failed URL) down to its origin (#38).
 * Belt-and-suspenders alongside the structured `resolvedUrl` redaction above —
 * closes the same secret-in-URL leak for any error text that embeds a URL,
 * present or future, without requiring every throw site to remember to redact.
 */
export function redactUrlsInText(text: string): string {
  return text.replace(EMBEDDED_URL_PATTERN, (match) => redactUrlForJournal(match));
}

/**
 * Redact the secret-bearing fields of a webhook journal entry before it reaches
 * ANY sink (#38). Applied once, here, so the in-memory ring buffer, the
 * `--webhook-journal-file` JSONL append, and (since the admin endpoint reads
 * straight from the ring buffer) the admin journal response all inherit the
 * same redaction — there is no separate code path that could forget it.
 */
function redactEntry(entry: WebhookJournalEntry): WebhookJournalEntry {
  return {
    ...entry,
    ...(entry.resolvedUrl !== undefined && { resolvedUrl: redactUrlForJournal(entry.resolvedUrl) }),
    ...(entry.error !== undefined && { error: redactUrlsInText(entry.error) }),
  };
}

export interface WebhookJournalOptions {
  /**
   * Optional path for an append-only JSONL log (INT-1). When set, every record() call
   * synchronously appends `JSON.stringify(entry) + "\n"`. Loss model: at most the
   * last attempt if the process is killed mid-syscall — acceptable for a mock server,
   * not acceptable for a production broker (which Mockstar isn't claiming to be).
   *
   * Typical use: post-restart forensic replay via `cat <file> | jq` or a future
   * `mockstar webhooks replay-file` subcommand.
   */
  journalFile?: string;
}

/**
 * Per-tenant ring buffer of webhook delivery attempts.
 *
 * Why a sibling registry (not a discriminated journal entry on the existing
 * RingBuffer<JournalEntry>): the request-side JournalEntry is request-shaped
 * (method, path, status, matchedMockId, …); webhook rows are delivery-shaped
 * (deliveryId, attempt, outcome, …). Mixing them as a discriminated union would
 * push every consumer of the request journal to handle a 'kind' field that
 * never existed before. A sibling registry has zero ripple cost.
 */
export class WebhookJournalRegistry {
  readonly #buffers = new Map<string, RingBuffer<WebhookJournalEntry>>();
  readonly #capacityFor: (tenant: string) => number;
  readonly #journalFile?: string;

  constructor(capacityFor: (tenant: string) => number, opts: WebhookJournalOptions = {}) {
    this.#capacityFor = capacityFor;
    this.#journalFile = opts.journalFile;
  }

  record(entry: WebhookJournalEntry): void {
    // #38: redact BEFORE it reaches any sink — the ring buffer push and the file
    // append below both read from `redacted`, never the raw `entry`.
    const redacted = redactEntry(entry);
    const buf = this.#bufferFor(redacted.tenant);
    buf.push(redacted);
    if (this.#journalFile) {
      // Synchronous append. Errors are intentionally swallowed and logged once
      // — we don't want a failed disk write to bubble up into the delivery loop
      // and disrupt other tenants. (The journal is best-effort durable.)
      try {
        appendFileSync(this.#journalFile, `${JSON.stringify(redacted)}\n`);
      } catch (err) {
        // Use console.warn rather than the structured logger to keep this path dep-free
        // and to avoid recursion via observability writes.
        console.warn(`[mockstar] webhook journal file write failed: ${(err as Error).message ?? err}`);
      }
    }
  }

  snapshot(tenant: string): readonly WebhookJournalEntry[] {
    const buf = this.#buffers.get(tenant);
    if (!buf) return [];
    return buf.snapshot();
  }

  /** Look up the most recent entry for a deliveryId — used by the replay endpoint (O4). */
  findLatestByDeliveryId(tenant: string, deliveryId: string): WebhookJournalEntry | null {
    const entries = this.snapshot(tenant);
    // Iterate newest-first; entries are oldest-first per RingBuffer contract.
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry && entry.deliveryId === deliveryId) return entry;
    }
    return null;
  }

  #bufferFor(tenant: string): RingBuffer<WebhookJournalEntry> {
    let buf = this.#buffers.get(tenant);
    if (!buf) {
      buf = new RingBuffer<WebhookJournalEntry>(this.#capacityFor(tenant));
      this.#buffers.set(tenant, buf);
    }
    return buf;
  }
}
