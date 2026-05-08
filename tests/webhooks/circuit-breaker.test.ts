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
});
