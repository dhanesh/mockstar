// Satisfies: O3 (circuit breaker per webhook), RT-4 (per-webhook state machine)
// Satisfies: TN2 partial (circuit-open is observable, not silent)

/**
 * Three-state breaker per webhook. State transitions:
 *
 *   CLOSED  --(failureThreshold consecutive failures)-->  OPEN
 *   OPEN    --(cooldownMs elapsed)-->                     HALF_OPEN
 *   HALF_OPEN --(one success)-->                          CLOSED
 *   HALF_OPEN --(one failure)-->                          OPEN (cooldown restarts)
 *
 * Pure state machine; no HTTP, no timers. The queue calls `gate()` before each
 * attempt and `record()` after. Time is sampled from `Date.now()` for cooldown
 * comparisons — deterministic given a clock.
 */
export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  /** Optional clock injection for deterministic tests. */
  now?: () => number;
}

export type CircuitState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  #state: CircuitState = "closed";
  #consecutiveFailures = 0;
  #openedAt = 0;
  readonly #threshold: number;
  readonly #cooldown: number;
  readonly #now: () => number;

  constructor(opts: CircuitBreakerOptions) {
    this.#threshold = opts.failureThreshold;
    this.#cooldown = opts.cooldownMs;
    this.#now = opts.now ?? Date.now;
  }

  /** Read current effective state. Triggers OPEN→HALF_OPEN transition if cooldown elapsed. */
  gate(): CircuitState {
    if (this.#state === "open" && this.#now() - this.#openedAt >= this.#cooldown) {
      this.#state = "half-open";
    }
    return this.#state;
  }

  /** Record an attempt outcome. Drives state transitions. */
  record(success: boolean): void {
    if (success) {
      this.#consecutiveFailures = 0;
      // Any success closes the breaker (covers both half-open->closed and a closed-state success).
      this.#state = "closed";
      return;
    }
    this.#consecutiveFailures += 1;
    if (this.#state === "half-open") {
      // A failure in half-open re-trips and restarts the cooldown clock.
      this.#state = "open";
      this.#openedAt = this.#now();
      return;
    }
    if (this.#state === "closed" && this.#consecutiveFailures >= this.#threshold) {
      this.#state = "open";
      this.#openedAt = this.#now();
    }
  }

  /** For metrics export — gauge value 0=closed, 1=open, 2=half-open (O2). */
  metricValue(): 0 | 1 | 2 {
    const s = this.gate(); // sample (may transition open->half-open)
    return s === "closed" ? 0 : s === "open" ? 1 : 2;
  }
}
