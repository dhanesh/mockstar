// Satisfies: U4 (delivery rows in journal), RT-11 (per-tenant journal accommodates webhook rows)
// Satisfies: O4 (admin replay endpoint reads from this), TN7 (replay scope = ring-buffer-resident)
// Satisfies: T2 (in-memory only) + INT-1 (--webhook-journal-file optional JSONL append)

import { appendFileSync } from "node:fs";
import { RingBuffer } from "../../core/journal/ring-buffer.ts";
import type { WebhookJournalEntry } from "./types.ts";

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
    const buf = this.#bufferFor(entry.tenant);
    buf.push(entry);
    if (this.#journalFile) {
      // Synchronous append. Errors are intentionally swallowed and logged once
      // — we don't want a failed disk write to bubble up into the delivery loop
      // and disrupt other tenants. (The journal is best-effort durable.)
      try {
        appendFileSync(this.#journalFile, `${JSON.stringify(entry)}\n`);
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
