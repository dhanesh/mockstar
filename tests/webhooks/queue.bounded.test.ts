// Validates: RT-1 (binding constraint), O1 (queue cap drop-oldest), TN2 (drops resolve via onTerminal, not reject)
// @constraint O1 - per-tenant queue depth cap with drop-oldest
// @constraint TN2 - drop is observable via onTerminal('dropped'), never silent

import { describe, expect, test } from 'bun:test';
import { BoundedRetryQueue, type QueuedDelivery } from '../../src/features/webhooks/queue.ts';

function makeDelivery(
  id: string,
  attemptFn: () => Promise<{ httpStatus: number; durationUs: number; resolvedUrl: string }>,
  capture: { onTerminal: ReturnType<typeof Promise.withResolvers<unknown>> },
): QueuedDelivery {
  return {
    deliveryId: id,
    tenant: 'default',
    webhookId: 'wh1',
    triggerRequestId: `req-${id}`,
    attempt: attemptFn,
    retry: { attempts: 1, backoff: [], jitterRatio: 0 },
    onAttempt: () => undefined,
    onTerminal: (summary) => capture.onTerminal.resolve(summary),
    circuitGate: () => 'closed',
    recordCircuitOutcome: () => undefined,
  };
}

describe('BoundedRetryQueue', () => {
  test('runs a delivery to terminal success', async () => {
    const q = new BoundedRetryQueue({ concurrency: 1, cap: 4 });
    const cap = { onTerminal: Promise.withResolvers<unknown>() };
    q.enqueue(
      makeDelivery(
        'd1',
        async () => ({ httpStatus: 200, durationUs: 100, resolvedUrl: 'https://ex.com' }),
        cap,
      ),
    );
    const summary = (await cap.onTerminal.promise) as { outcome: string; totalAttempts: number };
    expect(summary.outcome).toBe('success');
    expect(summary.totalAttempts).toBe(1);
  });

  test('on cap overflow drops OLDEST waiting entry, not newest (O1)', async () => {
    // Concurrency=1 keeps one in flight (slow); cap=2 means queue can hold 1 more before drop.
    const q = new BoundedRetryQueue({ concurrency: 1, cap: 2 });
    const slow = Promise.withResolvers<{ httpStatus: number; durationUs: number; resolvedUrl: string }>();
    const captures = ['d1', 'd2', 'd3', 'd4'].map(() => ({
      onTerminal: Promise.withResolvers<{ deliveryId: string; outcome: string }>(),
    }));
    q.enqueue(makeDelivery('d1', () => slow.promise, captures[0]!));      // takes the in-flight slot
    q.enqueue(makeDelivery('d2', async () => ({ httpStatus: 200, durationUs: 1, resolvedUrl: 'x' }), captures[1]!)); // waiting
    q.enqueue(makeDelivery('d3', async () => ({ httpStatus: 200, durationUs: 1, resolvedUrl: 'x' }), captures[2]!)); // evicts d2
    q.enqueue(makeDelivery('d4', async () => ({ httpStatus: 200, durationUs: 1, resolvedUrl: 'x' }), captures[3]!)); // evicts d3

    // d2 and d3 should both have terminated as 'dropped'.
    const d2 = await captures[1]!.onTerminal.promise;
    const d3 = await captures[2]!.onTerminal.promise;
    expect(d2.outcome).toBe('dropped');
    expect(d3.outcome).toBe('dropped');

    // Now release d1 and d4 — they should both succeed.
    slow.resolve({ httpStatus: 200, durationUs: 1, resolvedUrl: 'x' });
    const d1 = await captures[0]!.onTerminal.promise;
    const d4 = await captures[3]!.onTerminal.promise;
    expect(d1.outcome).toBe('success');
    expect(d4.outcome).toBe('success');
  });

  test('drops resolve via onTerminal, do NOT reject (TN2)', async () => {
    // The contract is: every terminal state resolves through the same callback.
    // If a drop rejected, callers (await endpoint) would need try/catch — explicitly out of scope.
    const q = new BoundedRetryQueue({ concurrency: 1, cap: 1 });
    const slow = Promise.withResolvers<{ httpStatus: number; durationUs: number; resolvedUrl: string }>();
    const captureSlow = { onTerminal: Promise.withResolvers<unknown>() };
    const captureDrop = { onTerminal: Promise.withResolvers<{ outcome: string }>() };
    q.enqueue(makeDelivery('slow', () => slow.promise, captureSlow));
    q.enqueue(makeDelivery('dropme', async () => ({ httpStatus: 200, durationUs: 1, resolvedUrl: 'x' }), captureDrop));

    // Should resolve as 'dropped' via the resolve path.
    const summary = await captureDrop.onTerminal.promise;
    expect(summary.outcome).toBe('dropped');
    slow.resolve({ httpStatus: 200, durationUs: 1, resolvedUrl: 'x' });
  });

  test('retries with explicit backoff ladder (T3)', async () => {
    const q = new BoundedRetryQueue({ concurrency: 1, cap: 4 });
    const cap = { onTerminal: Promise.withResolvers<{ outcome: string; totalAttempts: number }>() };
    let attempts = 0;
    const start = Date.now();
    q.enqueue({
      deliveryId: 'r1',
      tenant: 'default',
      webhookId: 'wh1',
      triggerRequestId: 'req-r1',
      attempt: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('transient');
        return { httpStatus: 200, durationUs: 1, resolvedUrl: 'https://ex.com' };
      },
      retry: { attempts: 3, backoff: [10, 20], jitterRatio: 0 },  // ~30ms total minimum
      onAttempt: () => undefined,
      onTerminal: (s) => cap.onTerminal.resolve(s),
      circuitGate: () => 'closed',
      recordCircuitOutcome: () => undefined,
    });
    const summary = await cap.onTerminal.promise;
    const elapsed = Date.now() - start;
    expect(summary.outcome).toBe('success');
    expect(summary.totalAttempts).toBe(3);
    expect(elapsed).toBeGreaterThanOrEqual(25); // 10ms + 20ms - jitter slack
  });

  test('open circuit short-circuits attempt (O3)', async () => {
    const q = new BoundedRetryQueue({ concurrency: 1, cap: 4 });
    const cap = { onTerminal: Promise.withResolvers<{ outcome: string }>() };
    let attempts = 0;
    q.enqueue({
      deliveryId: 'co1',
      tenant: 'default',
      webhookId: 'wh1',
      triggerRequestId: 'req-co1',
      attempt: async () => {
        attempts += 1;
        return { httpStatus: 200, durationUs: 1, resolvedUrl: 'https://ex.com' };
      },
      retry: { attempts: 3, backoff: [1, 1], jitterRatio: 0 },
      onAttempt: () => undefined,
      onTerminal: (s) => cap.onTerminal.resolve(s),
      circuitGate: () => 'open',
      recordCircuitOutcome: () => undefined,
    });
    const summary = await cap.onTerminal.promise;
    expect(summary.outcome).toBe('circuit-open');
    expect(attempts).toBe(0); // no HTTP attempt was made
  });

  test('size accounting reflects waiting + inflight', async () => {
    const q = new BoundedRetryQueue({ concurrency: 1, cap: 4 });
    const slow = Promise.withResolvers<{ httpStatus: number; durationUs: number; resolvedUrl: string }>();
    const captures = ['a', 'b', 'c'].map(() => ({ onTerminal: Promise.withResolvers<unknown>() }));
    q.enqueue(makeDelivery('a', () => slow.promise, captures[0]!));
    q.enqueue(makeDelivery('b', () => slow.promise, captures[1]!));
    q.enqueue(makeDelivery('c', () => slow.promise, captures[2]!));
    expect(q.size()).toBe(3);
    expect(q.inflight()).toBe(1);
    expect(q.waiting()).toBe(2);
    slow.resolve({ httpStatus: 200, durationUs: 1, resolvedUrl: 'x' });
    await Promise.all(captures.map((c) => c.onTerminal.promise));
  });
});
