// Validates: O3 (circuit breaker per webhook), RT-4 (state machine)
// @constraint O3 - circuit opens after threshold consecutive failures, half-open after cooldown

import { describe, expect, test } from "bun:test";
import { CircuitBreaker } from "../../src/features/webhooks/circuit-breaker.ts";

describe("CircuitBreaker (O3, RT-4)", () => {
  test("starts closed", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    expect(cb.gate()).toBe("closed");
  });

  test("stays closed below threshold", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    cb.record(false);
    cb.record(false);
    expect(cb.gate()).toBe("closed");
  });

  test("opens at threshold", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    cb.record(false);
    cb.record(false);
    cb.record(false);
    expect(cb.gate()).toBe("open");
  });

  test("success resets failure counter (closed state)", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    cb.record(false);
    cb.record(false);
    cb.record(true); // resets
    cb.record(false);
    cb.record(false);
    expect(cb.gate()).toBe("closed"); // 2 failures after reset, still under threshold
  });

  test("transitions open -> half-open after cooldown", () => {
    let now = 1000;
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500, now: () => now });
    cb.record(false);
    expect(cb.gate()).toBe("open");
    now += 500;
    expect(cb.gate()).toBe("half-open");
  });

  test("half-open -> closed on success", () => {
    let now = 1000;
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500, now: () => now });
    cb.record(false);
    now += 500;
    expect(cb.gate()).toBe("half-open");
    cb.record(true);
    expect(cb.gate()).toBe("closed");
  });

  test("half-open -> open on failure (cooldown restarts)", () => {
    let now = 1000;
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500, now: () => now });
    cb.record(false);
    now += 500;
    expect(cb.gate()).toBe("half-open");
    cb.record(false); // half-open + failure
    expect(cb.gate()).toBe("open");
    // Cooldown should restart from this moment.
    now += 499;
    expect(cb.gate()).toBe("open");
    now += 1;
    expect(cb.gate()).toBe("half-open");
  });

  test("metricValue maps states for Prometheus gauge (O2)", () => {
    let now = 1000;
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500, now: () => now });
    expect(cb.metricValue()).toBe(0);
    cb.record(false);
    expect(cb.metricValue()).toBe(1);
    now += 500;
    expect(cb.metricValue()).toBe(2);
  });

  // F2: half-open must admit only a bounded number of trial probes (default 1) so a
  // still-unhealthy upstream is not flooded by a burst the instant cooldown elapses.
  test("half-open admits only one trial probe by default; extra concurrent probes are denied", () => {
    let now = 1000;
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500, now: () => now });
    cb.record(false);
    now += 500;
    // First gate() in half-open hands out the single probe permit.
    expect(cb.gate()).toBe("half-open");
    // A concurrent caller (before the first probe's record()) is denied — treated as open.
    expect(cb.gate()).toBe("open");
    expect(cb.gate()).toBe("open");
  });

  test("metricValue / peek do NOT consume the half-open probe permit", () => {
    let now = 1000;
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500, now: () => now });
    cb.record(false);
    now += 500;
    // Scraping metrics repeatedly must not starve the real probe budget.
    expect(cb.metricValue()).toBe(2);
    expect(cb.peek()).toBe("half-open");
    expect(cb.metricValue()).toBe(2);
    // The probe permit is still available for a real delivery.
    expect(cb.gate()).toBe("half-open");
    // ...and now exhausted for the next concurrent caller.
    expect(cb.gate()).toBe("open");
  });

  test("a probe's record() releases the permit for the next trial while still half-open", () => {
    let now = 1000;
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 500,
      halfOpenMaxProbes: 1,
      now: () => now,
    });
    cb.record(false);
    cb.record(false); // opens (threshold 2)
    expect(cb.gate()).toBe("open");
    now += 500;
    expect(cb.gate()).toBe("half-open"); // probe 1 acquired
    expect(cb.gate()).toBe("open"); // permit exhausted
    // Probe 1 fails → re-opens, cooldown restarts (does not stay half-open).
    cb.record(false);
    expect(cb.gate()).toBe("open");
  });

  test("respects a configurable halfOpenMaxProbes > 1", () => {
    let now = 1000;
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 500,
      halfOpenMaxProbes: 2,
      now: () => now,
    });
    cb.record(false);
    now += 500;
    expect(cb.gate()).toBe("half-open"); // probe 1
    expect(cb.gate()).toBe("half-open"); // probe 2
    expect(cb.gate()).toBe("open"); // exhausted
  });
});
