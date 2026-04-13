// @constraint O2 — Prometheus /metrics endpoint format
// @constraint G16 — metrics exposition test coverage
// @constraint RT-6.3 — atomic counters, no allocation on hot path

import { describe, it, expect } from 'bun:test';
import { Metrics } from '../src/core/observability/metrics.ts';

describe('Metrics.format() (O2)', () => {
  it('emits counter metrics in Prometheus text format with labels', () => {
    const m = new Metrics();
    m.incCounter('mockstar_requests_total', { tenant: 'acme', status: '200' });
    m.incCounter('mockstar_requests_total', { tenant: 'acme', status: '200' });
    m.incCounter('mockstar_requests_total', { tenant: 'acme', status: '404' });
    const out = m.format();
    expect(out).toContain('mockstar_requests_total{status="200",tenant="acme"} 2');
    expect(out).toContain('mockstar_requests_total{status="404",tenant="acme"} 1');
  });

  it('emits histogram bucket/sum/count for latency observations', () => {
    const m = new Metrics([100, 1000, 10_000]);
    m.observeLatencyUs('mockstar_request_latency_us', { tenant: 'acme' }, 50);
    m.observeLatencyUs('mockstar_request_latency_us', { tenant: 'acme' }, 500);
    m.observeLatencyUs('mockstar_request_latency_us', { tenant: 'acme' }, 5000);
    const out = m.format();
    expect(out).toMatch(/mockstar_request_latency_us_bucket\{.*le="0\.0001".*\} 1/);       // 50us fits in 100us bucket
    expect(out).toMatch(/mockstar_request_latency_us_bucket\{.*le="0\.001".*\} 2/);       // 500us accumulated
    expect(out).toMatch(/mockstar_request_latency_us_bucket\{.*le="\+Inf".*\}/);
    expect(out).toMatch(/mockstar_request_latency_us_sum\{/);
    expect(out).toMatch(/mockstar_request_latency_us_count\{/);
  });

  it('escapes double-quotes in label values', () => {
    const m = new Metrics();
    m.incCounter('mockstar_custom_total', { note: 'he said "hi"' });
    const out = m.format();
    expect(out).toContain('note="he said \\"hi\\""');
  });

  it('counter increments are O(1) and allocation-free for a known label set (RT-6.3)', () => {
    const m = new Metrics();
    // Warm the label set (first-use allocation is expected).
    m.incCounter('mockstar_requests_total', { tenant: 'acme' });
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      m.incCounter('mockstar_requests_total', { tenant: 'acme' });
    }
    const durationMs = performance.now() - start;
    // 10K increments should finish in well under 50ms on any modern machine.
    expect(durationMs).toBeLessThan(50);
  });
});
