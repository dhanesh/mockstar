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
 *
 * Half-open probe limiting (F2): the canonical pattern (Fowler; Microsoft Azure
 * "Circuit Breaker") admits only a *limited number of trial requests* in half-open
 * so a recovering upstream is not flooded the instant cooldown elapses. `gate()` is
 * therefore an ATOMIC acquire: it hands out at most `halfOpenMaxProbes` (default 1)
 * permits while half-open and returns "open" (deny) to any caller beyond that until a
 * `record()` resolves an outstanding probe. Use `peek()` for non-consuming reads
 * (metrics), which never spend a probe permit.
 */
export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  /** Max concurrent trial requests admitted in half-open before a record() resolves one. Default: 1. */
  halfOpenMaxProbes?: number;
  /** Optional clock injection for deterministic tests. */
  now?: () => number;
}

export type CircuitState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  #state: CircuitState = "closed";
  #consecutiveFailures = 0;
  #openedAt = 0;
  /** Trial requests currently outstanding in half-open (each acquired by gate(), released by record()). */
  #halfOpenProbes = 0;
  readonly #threshold: number;
  readonly #cooldown: number;
  readonly #halfOpenMax: number;
  readonly #now: () => number;

  constructor(opts: CircuitBreakerOptions) {
    this.#threshold = opts.failureThreshold;
    this.#cooldown = opts.cooldownMs;
    this.#halfOpenMax = Math.max(1, opts.halfOpenMaxProbes ?? 1);
    this.#now = opts.now ?? Date.now;
  }

  /** Apply the OPEN→HALF_OPEN transition if the cooldown has elapsed (resets the probe budget). */
  #maybeHalfOpen(): void {
    if (this.#state === "open" && this.#now() - this.#openedAt >= this.#cooldown) {
      this.#state = "half-open";
      this.#halfOpenProbes = 0;
    }
  }

  /**
   * Non-consuming read of the effective state. Triggers the OPEN→HALF_OPEN transition
   * if cooldown elapsed but NEVER spends a half-open probe permit. Use for metrics.
   */
  peek(): CircuitState {
    this.#maybeHalfOpen();
    return this.#state;
  }

  /**
   * Atomic "may I attempt?" acquire. Triggers OPEN→HALF_OPEN if cooldown elapsed.
   * In half-open, hands out at most `halfOpenMaxProbes` permits and returns "open"
   * (deny) once exhausted, so concurrent deliveries can't flood a recovering upstream.
   */
  gate(): CircuitState {
    this.#maybeHalfOpen();
    if (this.#state === "half-open") {
      if (this.#halfOpenProbes < this.#halfOpenMax) {
        this.#halfOpenProbes += 1;
        return "half-open";
      }
      // Probe budget exhausted — hold extra callers back as if the circuit were open.
      return "open";
    }
    return this.#state;
  }

  /** Record an attempt outcome. Releases an outstanding half-open probe and drives transitions. */
  record(success: boolean): void {
    // Release the probe permit this outcome corresponds to (if we were probing).
    if (this.#state === "half-open" && this.#halfOpenProbes > 0) {
      this.#halfOpenProbes -= 1;
    }
    if (success) {
      this.#consecutiveFailures = 0;
      // Any success closes the breaker (covers both half-open->closed and a closed-state success).
      this.#state = "closed";
      this.#halfOpenProbes = 0;
      return;
    }
    this.#consecutiveFailures += 1;
    if (this.#state === "half-open") {
      // A failure in half-open re-trips and restarts the cooldown clock.
      this.#state = "open";
      this.#openedAt = this.#now();
      this.#halfOpenProbes = 0;
      return;
    }
    if (this.#state === "closed" && this.#consecutiveFailures >= this.#threshold) {
      this.#state = "open";
      this.#openedAt = this.#now();
    }
  }

  /** For metrics export — gauge value 0=closed, 1=open, 2=half-open (O2). Non-consuming. */
  metricValue(): 0 | 1 | 2 {
    const s = this.peek(); // sample without spending a probe permit
    return s === "closed" ? 0 : s === "open" ? 1 : 2;
  }
}
