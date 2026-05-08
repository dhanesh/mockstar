// Satisfies: U1 (sync await endpoint backed by terminal-state events), RT-14 (event registry primitive)
// Satisfies: TN3 (lifecycle separation — await runs on a different request than the trigger)

import type { DeliverySummary } from "./types.ts";

/**
 * Promise-registry for delivery terminal-state subscription.
 *
 * Why a Map<id, Deferred> rather than EventEmitter:
 *   - Single-subscriber-per-id semantics (one await call per deliveryId).
 *   - Terminal-once: each delivery resolves exactly one outcome.
 *   - No leakage risk from forgotten subscribers — the registry self-cleans on resolve.
 *
 * Late subscriber handling:
 *   - If the delivery already terminated before await(deliveryId) is called,
 *     we keep the summary in #completed for a short retention window (default 60s).
 *     This handles the natural test pattern: trigger request returns, then test
 *     calls /webhooks/await — without retention, fast deliveries would race past
 *     the await and never resolve.
 */
export interface DeliveryEventRegistryOptions {
  /** How long to retain terminal summaries for late subscribers. Default: 60_000ms. */
  retentionMs?: number;
}

interface Deferred {
  resolve: (summary: DeliverySummary) => void;
  /** Used by sweep to clear stale waiters on shutdown / TTL. */
  timeout?: ReturnType<typeof setTimeout>;
}

const DEFAULT_RETENTION_MS = 60_000;

export class DeliveryEventRegistry {
  readonly #pending = new Map<string, Deferred>();
  readonly #completed = new Map<string, { summary: DeliverySummary; expiresAt: number }>();
  readonly #retentionMs: number;

  constructor(opts: DeliveryEventRegistryOptions = {}) {
    this.#retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  }

  /**
   * Subscribe to a delivery's terminal-state. Resolves with the summary or null on timeout.
   * If the delivery already terminated within the retention window, resolves immediately.
   */
  async await(deliveryId: string, timeoutMs: number): Promise<DeliverySummary | null> {
    // Fast-path: already terminal and within retention window.
    const cached = this.#completed.get(deliveryId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.summary;
    }

    // Slow-path: register a deferred and wait.
    return new Promise<DeliverySummary | null>((resolve) => {
      const deferred: Deferred = {
        resolve: (summary) => {
          if (deferred.timeout) clearTimeout(deferred.timeout);
          this.#pending.delete(deliveryId);
          resolve(summary);
        },
      };
      deferred.timeout = setTimeout(() => {
        this.#pending.delete(deliveryId);
        resolve(null);
      }, timeoutMs);
      this.#pending.set(deliveryId, deferred);
    });
  }

  /** Called by the queue when a delivery reaches a terminal state. */
  publish(summary: DeliverySummary): void {
    // Resolve any pending awaiter.
    const pending = this.#pending.get(summary.deliveryId);
    if (pending) {
      pending.resolve(summary);
    }
    // Stash the summary for late subscribers within the retention window.
    this.#completed.set(summary.deliveryId, {
      summary,
      expiresAt: Date.now() + this.#retentionMs,
    });
    this.#sweepExpired();
  }

  /** Remove expired completed entries. Called on every publish — amortizes cleanup cost. */
  #sweepExpired(): void {
    const now = Date.now();
    // Iteration order is insertion order; once we hit a non-expired entry, the rest are non-expired.
    for (const [id, entry] of this.#completed) {
      if (entry.expiresAt > now) break;
      this.#completed.delete(id);
    }
  }

  /** Test-helper: number of awaiters currently waiting. */
  pendingCount(): number {
    return this.#pending.size;
  }

  /** Test-helper: number of cached terminal summaries. */
  completedCount(): number {
    return this.#completed.size;
  }
}
