// @constraint RT-8 — mockstar upstream health + diagnostic 502
// @constraint T9 — header passthrough
// @constraint T10 — 502 + structured body on upstream failure

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { forwardToMockstar, probeMockstarHealth } from "../src/features/proxy/upstream.ts";
import type { ProxyConfig, HostConfig } from "../src/features/proxy/types.ts";

interface UpstreamStub {
  stop: () => void;
  url: string;
  requests: Array<{ method: string; path: string; headers: Record<string, string>; body: string }>;
}

function startStub(opts: { delayMs?: number; status?: number } = {}): UpstreamStub {
  // biome-ignore lint/suspicious/noExplicitAny: Bun global
  const bun = (globalThis as any).Bun;
  const requests: UpstreamStub["requests"] = [];
  const server = bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const u = new URL(req.url);
      const body = await req.text();
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      requests.push({ method: req.method, path: u.pathname, headers, body });
      if (u.pathname === "/health") return new Response('{"status":"ok"}', { status: 200 });
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return new Response(JSON.stringify({ echoed: body, path: u.pathname }), {
        status: opts.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  }) as { port: number; hostname: string; stop: () => void };
  return {
    stop: () => server.stop(),
    url: `http://127.0.0.1:${server.port}`,
    requests,
  };
}

function makeConfig(upstreamUrl: string, timeoutMs = 5000): ProxyConfig {
  return Object.freeze({
    hosts: [{ host: "api.razorpay.com", tenant: "razorpay" }],
    mockstarUrl: upstreamUrl,
    listenHost: "127.0.0.1",
    listenPort: 443,
    upstreamTimeoutMs: timeoutMs,
    leafTtlHours: 24,
    dnsMode: "dnsmasq",
  }) as unknown as ProxyConfig;
}

const host: HostConfig = { host: "api.razorpay.com", tenant: "razorpay" };
const logger = {
  info: () => undefined,
  error: () => undefined,
};

describe("probeMockstarHealth (RT-8.1)", () => {
  let stub: UpstreamStub;
  beforeAll(() => {
    stub = startStub();
  });
  afterAll(() => {
    stub.stop();
  });

  it("returns true when upstream /health responds", async () => {
    expect(await probeMockstarHealth(makeConfig(stub.url))).toBe(true);
  });

  it("returns false for a dead upstream", async () => {
    expect(await probeMockstarHealth(makeConfig("http://127.0.0.1:1"))).toBe(false);
  });
});

describe("forwardToMockstar (T9, T10)", () => {
  let stub: UpstreamStub;
  beforeAll(() => {
    stub = startStub();
  });
  afterAll(() => {
    stub.stop();
  });

  it("forwards method + path + body; injects x-mockstar-tenant", async () => {
    const req = new Request("https://api.razorpay.com/v1/orders?foo=bar", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Basic abc" },
      body: JSON.stringify({ amount: 100 }),
    });
    const res = await forwardToMockstar(req, {
      config: makeConfig(stub.url),
      host,
      requestId: "r1",
      logger,
    });
    expect(res.status).toBe(200);
    const last = stub.requests[stub.requests.length - 1];
    expect(last?.path).toBe("/v1/orders");
    expect(last?.method).toBe("POST");
    expect(last?.headers["x-mockstar-tenant"]).toBe("razorpay");
    expect(last?.headers["x-mockstar-proxy-request-id"]).toBe("r1");
    expect(last?.headers.authorization).toBe("Basic abc");
  });

  it("overwrites client-supplied x-mockstar-tenant and passes through authorization (T9)", async () => {
    // We can't directly assert "connection header is stripped" — Bun's underlying fetch
    // adds its own connection header at the socket level (out of our control). We instead
    // validate what IS under our control: the tenant is authoritatively set by the proxy,
    // and custom / auth headers pass through.
    const req = new Request("https://api.razorpay.com/x", {
      headers: {
        authorization: "Bearer secret",
        "x-mockstar-tenant": "leaked-from-client",
        "x-custom-app": "kept",
      },
    });
    await forwardToMockstar(req, { config: makeConfig(stub.url), host, requestId: "r2", logger });
    const last = stub.requests[stub.requests.length - 1];
    expect(last?.headers["x-mockstar-tenant"]).toBe("razorpay");
    expect(last?.headers.authorization).toBe("Bearer secret");
    expect(last?.headers["x-custom-app"]).toBe("kept");
  });

  it("returns 502 with diagnostic body when upstream is unreachable", async () => {
    const req = new Request("https://api.razorpay.com/v1/orders");
    const res = await forwardToMockstar(req, {
      config: makeConfig("http://127.0.0.1:1"),
      host,
      requestId: "r3",
      logger,
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; cause: string; hint: string };
    expect(body.error).toBe("mockstar_unreachable");
    expect(body.cause).toBe("connection_error");
    expect(body.hint).toContain("127.0.0.1:1");
  });

  it("returns 502 with cause=timeout when upstream exceeds timeout", async () => {
    const slow = startStub({ delayMs: 500 });
    try {
      const req = new Request("https://api.razorpay.com/slow");
      const res = await forwardToMockstar(req, {
        config: makeConfig(slow.url, 50),
        host,
        requestId: "r4",
        logger,
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { cause: string };
      expect(body.cause).toBe("timeout");
    } finally {
      slow.stop();
    }
  });
});
