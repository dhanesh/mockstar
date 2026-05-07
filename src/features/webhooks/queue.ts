// Satisfies: RT-1 (binding constraint — in-process queue with depth cap and concurrency control)
// Satisfies: B1 (no external broker), T1 (in-process only), T2 (in-memory only)
// Satisfies: O1 (per-tenant queue depth cap with drop-oldest), TN2 (drops are observable, not silent)
// Satisfies: T3 (default retry curve via explicit backoff ladder; per-webhook overrides accepted)
// Satisfies: B4 (no Redis required), TN6 (in-flight retries scoped to process lifetime)

import PQueue from 'p-queue';
import type { DeliveryOutcome, DeliverySummary } from './types.ts';

/**
 * One delivery as the queue sees it. The queue does NOT know how to make HTTP calls,
 * sign, or render templates — the dispatcher hands in an `attempt` closure and a
 * terminal-state callback. This keeps the queue pure FIFO + retry mechanics.
 */
export interface QueuedDelivery {
  /** Stable id, identical across all retry attempts of one delivery (B3 idempotency). */
  deliveryId: string;
  /** Tenant this delivery belongs to. Each tenant has its own BoundedRetryQueue instance (per-tenant isolation). */
  tenant: string;
  /** Webhook config id (mock-entry id) for journal/metrics labelling. */
  webhookId: string;
  /** Inbound request id that triggered the delivery — captured at schedule time (U4, RT-15). */
  triggerRequestId: string;
  /** Single delivery attempt. Throws on transient failure (caught and retried). */
  attempt: () => Promise<{ httpStatus: number; durationUs: number; resolvedUrl: string }>;
  /** Retry config: explicit backoff ladder; length = attempts - 1. */
  retry: { attempts: number; backoff: readonly number[]; jitterRatio: number };
  /** Per-attempt callback for journalling/metrics — fires for EVERY attempt, terminal or not. */
  onAttempt: (record: AttemptRecord) => void;
  /** Terminal-state callback — fires exactly once per delivery, for the await endpoint (RT-14). */
  onTerminal: (summary: DeliverySummary) => void;
  /** Circuit gate — checked before each HTTP attempt; if it returns 'open', delivery short-circuits (O3). */
  circuitGate: () => 'closed' | 'open' | 'half-open';
  /** Attempt success/failure feeds back into the circuit. */
  recordCircuitOutcome: (success: boolean) => void;
}

export interface AttemptRecord {
  attempt: number;
  outcome: DeliveryOutcome;
  httpStatus?: number;
  durationUs: number;
  resolvedUrl?: string;
  error?: string;
}

export interface BoundedRetryQueueOptions {
  /** Max simultaneous in-flight deliveries for this tenant. Default: 8. */
  concurrency: number;
  /** Total cap (waiting + in-flight). Default: 1024 (O1). */
  cap: number;
  /** Counter increment hook — wired to Metrics.incCounter for observability (O2). */
  onDropped?: (dropped: QueuedDelivery) => void;
  /**
   * Fires AFTER every state mutation that could change `size()` — enqueue, drop,
   * waiting→inflight transition, terminal completion. Receiver sees the post-mutation
   * size. Used by the dispatcher to keep the `webhook_queue_depth` gauge in sync
   * with reality (instead of sampling only at enqueue time).
   */
  onSizeChange?: (size: number) => void;
}

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_CAP = 1024;

/**
 * Per-tenant bounded retry queue.
 *
 * Why a wrapper around p-queue and not p-queue alone:
 *   - p-queue caps in-flight (`concurrency`) but its internal queue is UNBOUNDED.
 *   - O1 demands a total depth cap with drop-oldest eviction on overflow.
 *   - p-queue does not expose its internal queue for eviction.
 *   - So we maintain our own FIFO (#waiting) and only push tasks to p-queue
 *     when there is in-flight slack — meaning p-queue's internal queue stays
 *     empty in steady state. Eviction happens on OUR FIFO before delegation.
 *
 * Drop semantics (TN2 resolution):
 *   - Evicted entries' onTerminal fires with outcome:'dropped' (DOES NOT reject).
 *     This preserves the await endpoint's terminal-state contract: every delivery
 *     terminates via the same callback path. The await endpoint never has to
 *     try/catch — every terminal state is `resolve()`-shaped.
 */
export class BoundedRetryQueue {
  readonly #pq: PQueue;
  readonly #waiting: QueuedDelivery[] = [];
  readonly #cap: number;
  readonly #onDropped?: (dropped: QueuedDelivery) => void;
  readonly #onSizeChange?: (size: number) => void;

  constructor(opts: Partial<BoundedRetryQueueOptions> = {}) {
    this.#pq = new PQueue({ concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY });
    this.#cap = opts.cap ?? DEFAULT_CAP;
    this.#onDropped = opts.onDropped;
    this.#onSizeChange = opts.onSizeChange;
  }

  /** Fire the size-change callback. Wrapped so we never throw from a hook. */
  #fireSizeChange(): void {
    if (!this.#onSizeChange) return;
    try {
      this.#onSizeChange(this.size());
    } catch (err) {
      // Hook failure must NOT break the delivery loop. Best-effort observability only.
      console.warn(`[mockstar] onSizeChange hook threw: ${(err as Error).message ?? err}`);
    }
  }

  /** Total deliveries occupying a slot (waiting + in-flight). */
  size(): number {
    return this.#waiting.length + this.#pq.pending;
  }

  /** Count of waiting (not yet dispatched) deliveries. */
  waiting(): number {
    return this.#waiting.length;
  }

  /** Count of in-flight (currently executing) deliveries. */
  inflight(): number {
    return this.#pq.pending;
  }

  /**
   * Enqueue a delivery. If queue is at cap, evict OLDEST waiting entries first
   * (resolved with outcome:'dropped'). If still no slack — i.e. cap entries are
   * all in-flight — the new entry itself drops (we cannot abort in-flight tasks).
   */
  enqueue(req: QueuedDelivery): void {
    while (this.size() >= this.#cap) {
      const oldest = this.#waiting.shift();
      if (oldest) {
        // Eviction: waiting--, then we'll re-loop or push, so a fire happens at
        // the end either way. No need to fire mid-loop.
        this.#dropDelivery(oldest);
      } else {
        // All slots in-flight; cannot evict in-flight tasks — drop the incoming.
        // Size is unchanged but the incoming delivery's terminal callback fired
        // synchronously inside #dropDelivery. Skip onSizeChange — nothing changed.
        this.#dropDelivery(req);
        return;
      }
    }
    this.#waiting.push(req);
    // Size definitely changed: +1 at minimum. (Eviction loop above kept us at-or-below cap.)
    this.#fireSizeChange();
    this.#drain();
  }

  /**
   * Move waiting → in-flight up to the concurrency cap. Does NOT change total size
   * (waiting decreases, in-flight increases by the same amount), so no onSizeChange
   * is fired from drain itself — only from enqueue (size+1) and task completion (size-1).
   */
  #drain(): void {
    while (this.#waiting.length > 0 && this.#pq.pending < this.#pq.concurrency) {
      const next = this.#waiting.shift();
      if (!next) break;
      // Fire-and-forget; #pq.add returns a Promise we don't need to await.
      void this.#pq.add(() => this.#runWithRetry(next)).then(() => {
        // After the task settles, p-queue's `pending` has decremented — size went down.
        this.#fireSizeChange();
        this.#drain();
      });
    }
  }

  /**
   * Execute one delivery with the per-webhook retry curve.
   *
   * Hand-rolled (rather than p-retry) because T3's contract is an EXPLICIT backoff
   * ladder per webhook (e.g. [1000, 2000, 4000, 8000, 16000, 32000]). p-retry only
   * supports exponential factor + min/max bounds — it doesn't accept arbitrary
   * arrays. ~25 LOC of retry loop is cleaner than wrapping p-retry's onFailedAttempt
   * to inject custom delays.
   */
  async #runWithRetry(req: QueuedDelivery): Promise<void> {
    const totalStart = performance.now();
    let lastHttpStatus: number | undefined;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= req.retry.attempts; attempt++) {
      // Backoff before retry attempts (skip before first attempt).
      if (attempt > 1) {
        const baseMs = req.retry.backoff[attempt - 2] ?? 0;
        const delayMs = applyJitter(baseMs, req.retry.jitterRatio);
        await sleep(delayMs);
      }

      // Circuit gate check immediately before HTTP — covers the case where another
      // delivery in the same window tripped the circuit while we were sleeping.
      const gate = req.circuitGate();
      if (gate === 'open') {
        const summary: DeliverySummary = {
          deliveryId: req.deliveryId,
          outcome: 'circuit-open',
          totalAttempts: attempt - 1,  // we never made this attempt
          lastHttpStatus,
          totalDurationUs: Math.round((performance.now() - totalStart) * 1000),
        };
        req.onAttempt({
          attempt,
          outcome: 'circuit-open',
          durationUs: 0,
        });
        req.onTerminal(summary);
        return;
      }

      try {
        const result = await req.attempt();
        lastHttpStatus = result.httpStatus;
        req.onAttempt({
          attempt,
          outcome: 'success',
          httpStatus: result.httpStatus,
          durationUs: result.durationUs,
          resolvedUrl: result.resolvedUrl,
        });
        req.recordCircuitOutcome(true);
        req.onTerminal({
          deliveryId: req.deliveryId,
          outcome: 'success',
          totalAttempts: attempt,
          lastHttpStatus,
          totalDurationUs: Math.round((performance.now() - totalStart) * 1000),
        });
        return;
      } catch (err) {
        lastError = errorToString(err);
        req.onAttempt({
          attempt,
          outcome: attempt === req.retry.attempts ? 'failed' : 'success',  // 'success' here means "we'll retry" — actual semantics handled by outcome on terminal
          durationUs: 0,
          error: lastError,
        });
        req.recordCircuitOutcome(false);
      }
    }

    // All attempts exhausted.
    req.onTerminal({
      deliveryId: req.deliveryId,
      outcome: 'failed',
      totalAttempts: req.retry.attempts,
      lastHttpStatus,
      totalDurationUs: Math.round((performance.now() - totalStart) * 1000),
    });
  }

  #dropDelivery(req: QueuedDelivery): void {
    this.#onDropped?.(req);
    req.onAttempt({
      attempt: 0,
      outcome: 'dropped',
      durationUs: 0,
    });
    req.onTerminal({
      deliveryId: req.deliveryId,
      outcome: 'dropped',
      totalAttempts: 0,
      totalDurationUs: 0,
    });
  }
}

function applyJitter(baseMs: number, ratio: number): number {
  if (baseMs <= 0) return 0;
  if (ratio <= 0) return baseMs;
  const delta = baseMs * ratio;
  // ±ratio uniform jitter
  return Math.max(0, Math.round(baseMs - delta + Math.random() * 2 * delta));
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorToString(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
