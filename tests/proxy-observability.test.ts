// @constraint O1 — Proxy emits structured JSON log per request with expected fields
// @constraint O2 — Proxy emits Prometheus metrics with correct label set
// @constraint RT-9 — Observability reuses mockstar's Logger + Metrics primitives
// (closes G8)

import { describe, expect, it } from "bun:test";
import { Metrics, createLogger } from "../src/core/observability/index.ts";
import type { HostConfig, ProxyConfig } from "../src/features/proxy/types.ts";
import { forwardToMockstar } from "../src/features/proxy/upstream.ts";

// We can't exercise the full server.ts dispatch without a TLS handshake (integration
// test territory — see G3). Here we verify that the *primitives* mockstar provides
// produce the exact log / metric shapes our observability alerts + dashboard depend on.

interface CapturedLog {
  event: string;
  [k: string]: unknown;
}

function captureLogger(): {
  logger: ReturnType<typeof createLogger>;
  lines: CapturedLog[];
} {
  const lines: CapturedLog[] = [];
  const logger = createLogger({
    deterministic: true,
    stdout: (line) => lines.push(JSON.parse(line) as CapturedLog),
    stderr: (line) => lines.push(JSON.parse(line) as CapturedLog),
  });
  return { logger, lines };
}

describe("proxy observability (O1 / O2 / RT-9 / G8)", () => {
  it("StructuredLogger produces a JSON line with proxy-shaped fields", () => {
    const { logger, lines } = captureLogger();
    logger.info({
      event: "proxy_request",
      host: "api.razorpay.com",
      tenant: "razorpay",
      method: "POST",
      path: "/v1/orders",
      status: 200,
      requestId: "prx-c-1",
      durationUs: 412,
    });
    expect(lines).toHaveLength(1);
    const log = lines[0];
    expect(log?.event).toBe("proxy_request");
    expect(log?.host).toBe("api.razorpay.com");
    expect(log?.tenant).toBe("razorpay");
    expect(log?.method).toBe("POST");
    expect(log?.status).toBe(200);
    expect(log?.requestId).toBe("prx-c-1");
    expect(log?.durationUs).toBe(412);
  });

  it("Metrics counter increments with proxy-shaped labels", () => {
    const metrics = new Metrics();
    metrics.incCounter("mockstar_proxy_requests_total", {
      host: "api.razorpay.com",
      tenant: "razorpay",
      status: "200",
      method: "GET",
    });
    metrics.incCounter("mockstar_proxy_requests_total", {
      host: "api.razorpay.com",
      tenant: "razorpay",
      status: "200",
      method: "GET",
    });
    metrics.incCounter("mockstar_proxy_requests_total", {
      host: "api.razorpay.com",
      tenant: "razorpay",
      status: "502",
      method: "POST",
    });
    const formatted = metrics.format();
    expect(formatted).toMatch(/mockstar_proxy_requests_total\{[^}]*host="api\.razorpay\.com"[^}]*\} 2/);
    expect(formatted).toMatch(/mockstar_proxy_requests_total\{[^}]*status="502"[^}]*\} 1/);
  });

  it("Metrics latency histogram tracks proxy-specific buckets", () => {
    const metrics = new Metrics([100, 500, 1000, 5000]);
    metrics.observeLatencyUs("mockstar_proxy_request_latency_us", { tenant: "razorpay" }, 50);
    metrics.observeLatencyUs("mockstar_proxy_request_latency_us", { tenant: "razorpay" }, 400);
    metrics.observeLatencyUs("mockstar_proxy_request_latency_us", { tenant: "razorpay" }, 3000);
    const formatted = metrics.format();
    expect(formatted).toMatch(/mockstar_proxy_request_latency_us_bucket\{.*le="0\.0001".*\} 1/); // 50us → 100us bucket
    expect(formatted).toMatch(/mockstar_proxy_request_latency_us_bucket\{.*le="\+Inf".*\}/);
    expect(formatted).toMatch(/mockstar_proxy_request_latency_us_sum\{/);
    expect(formatted).toMatch(/mockstar_proxy_request_latency_us_count\{/);
  });

  it("error-level log routes to stderr for upstream-error events", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const logger = createLogger({
      deterministic: true,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    logger.error({
      event: "proxy_upstream_error",
      host: "api.razorpay.com",
      tenant: "razorpay",
      upstream: "http://127.0.0.1:3000",
      requestId: "prx-c-2",
      aborted: false,
      durationMs: 43,
      message: "connection refused",
    });
    expect(stderr).toHaveLength(1);
    expect(stdout).toHaveLength(0);
    const parsed = JSON.parse(stderr[0] ?? "{}") as CapturedLog;
    expect(parsed.level).toBe("error");
    expect(parsed.event).toBe("proxy_upstream_error");
  });

  it("forwardToMockstar emits the expected error log + returns 502 on unreachable upstream", async () => {
    const stderr: string[] = [];
    const logger = {
      info: () => undefined,
      error: (fields: Record<string, unknown>) => {
        stderr.push(JSON.stringify(fields));
      },
    };
    const host: HostConfig = { host: "api.razorpay.com", tenant: "razorpay" };
    const config: ProxyConfig = Object.freeze({
      hosts: [host],
      mockstarUrl: "http://127.0.0.1:1", // unreachable
      listenHost: "127.0.0.1",
      listenPort: 443,
      upstreamTimeoutMs: 500,
      leafTtlHours: 24,
      dnsMode: "dnsmasq",
    }) as unknown as ProxyConfig;

    const req = new Request("https://api.razorpay.com/v1/orders");
    const res = await forwardToMockstar(req, { config, host, requestId: "r-err", logger });
    expect(res.status).toBe(502);
    expect(stderr.length).toBeGreaterThan(0);
    const parsed = JSON.parse(stderr[0] ?? "{}") as Record<string, unknown>;
    expect(parsed.event).toBe("proxy_upstream_error");
    expect(parsed.host).toBe("api.razorpay.com");
    expect(parsed.upstream).toBe("http://127.0.0.1:1");
  });
});
