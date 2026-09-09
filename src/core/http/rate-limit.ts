// Satisfies: S5 — per-tenant request rate cap.
// Closes: #35 (requestsPerSecond declared in schema but read by no code path).

/**
 * Per-tenant token-bucket rate limiter.
 *
 * ALGORITHM CHOICE — token bucket, not a fixed window counter:
 * A fixed window (count requests in the current N-ms window, reset the counter at the
 * window boundary) 429s a burst that happens to land inside one window even when the
 * caller's AVERAGE rate is far under the configured limit. That is exactly the shape of
 * real traffic this limiter must not punish: a test suite firing 200 assertions against a
 * mock in the same event-loop tick, then going quiet for the rest of the second. A fixed
 * window would see "200 requests in this window" and throttle; a token bucket does not.
 *
 * A token bucket gives each tenant a bucket whose CAPACITY equals its configured
 * requests-per-second, refilled continuously (tokens/ms == rps / 1000, not in discrete
 * per-second steps). A fresh bucket starts full, so a burst of up to `rps` requests in a
 * single tick — however tightly packed — always succeeds immediately. Only once the whole
 * one-second allowance has actually been spent does the bucket run dry and start
 * returning 429s; it then refills smoothly as time passes, so recovery is gradual rather
 * than an abrupt reset back to full at a window edge.
 *
 * MEMORY (issue #34 class of bug): this class does no tenant bucketing of its own — it
 * trusts the `tenant` key it is given. The caller (`src/server.ts`) is responsible for
 * mapping an unresolved tenant (one with no config snapshot — which, in header-mode
 * tenancy, is an attacker-controlled string never checked against configured tenants) to
 * the single shared `UNKNOWN_TENANT_BUCKET` sentinel BEFORE calling `tryAcquire`. Do that
 * and this map's size is bounded by the configured tenant count plus one, never by the
 * number of distinct header values a caller can send.
 */
export interface RateLimitResult {
  allowed: boolean;
  /** Seconds to report in `Retry-After`. 0 when `allowed` is true. */
  retryAfterSeconds: number;
}

export interface TenantRateLimiterOptions {
  /**
   * Overridable time source (ms epoch), defaults to `Date.now`. Tests inject a fake clock
   * here so the token-bucket window can be advanced deterministically — no wall-clock
   * sleeps required for the behavioural test matrix.
   */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class TenantRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(opts: TenantRateLimiterOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Number of distinct tenant buckets currently tracked. Exposed for memory-bound tests (mirrors #34). */
  get bucketCount(): number {
    return this.buckets.size;
  }

  /**
   * Attempt to consume one token from `tenant`'s bucket, whose capacity/refill rate is
   * `limitPerSecond`. O(1), no allocation on the hit path once the tenant's bucket exists.
   */
  tryAcquire(tenant: string, limitPerSecond: number): RateLimitResult {
    const nowMs = this.now();
    let bucket = this.buckets.get(tenant);
    if (!bucket) {
      // A fresh bucket starts FULL — this is what makes an initial burst of up to
      // `limitPerSecond` requests succeed instantly, satisfying the burst-tolerance
      // requirement without needing any elapsed time first.
      bucket = { tokens: limitPerSecond, lastRefillMs: nowMs };
      this.buckets.set(tenant, bucket);
    } else {
      const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
      if (elapsedMs > 0) {
        const refill = (elapsedMs * limitPerSecond) / 1000;
        bucket.tokens = Math.min(limitPerSecond, bucket.tokens + refill);
        bucket.lastRefillMs = nowMs;
      }
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const deficitMs = ((1 - bucket.tokens) / limitPerSecond) * 1000;
    const retryAfterSeconds = Math.max(1, Math.ceil(deficitMs / 1000));
    return { allowed: false, retryAfterSeconds };
  }
}

/** The one 429 shape used everywhere a tenant exceeds its request rate cap. Mirrors `bodyTooLargeResponse`. */
export function rateLimitedResponse(limit: number, retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: "rate_limited", limit }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(retryAfterSeconds),
    },
  });
}
