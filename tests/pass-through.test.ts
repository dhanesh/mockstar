// @constraint T9 — per-route pass-through with timeout + diagnostic errors
// @constraint RT-8.2 — URL validation at request time
// @constraint G10 — pass-through test coverage

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Launched, launch } from "../src/index.ts";

describe("pass-through handler (T9)", () => {
  let upstream: { stop: () => void; url: string } | null = null;
  let launched: Launched | null = null;

  let echoCallCount = 0;

  beforeAll(() => {
    // Start a stub upstream on a dynamic port using Bun.serve.
    // biome-ignore lint/suspicious/noExplicitAny: Bun global
    const bun = (globalThis as any).Bun;
    const server = bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/slow")) {
          return new Promise<Response>((resolve) =>
            setTimeout(() => resolve(new Response("too late", { status: 200 })), 2000),
          ) as unknown as Response;
        }
        if (url.pathname.endsWith("/echo-body")) {
          // Echoes the exact bytes it received back to the caller, so a test can assert
          // byte-for-byte fidelity through the whole pass-through round trip (mockstar ->
          // upstream -> mockstar -> test). Tracked separately from other paths so a test
          // can assert the upstream was never even hit (the oversized-body case).
          echoCallCount += 1;
          const buf = await req.arrayBuffer();
          return new Response(buf, {
            status: 200,
            headers: {
              "content-type": req.headers.get("content-type") ?? "application/octet-stream",
              "x-echo-length": String(buf.byteLength),
            },
          });
        }
        return new Response(JSON.stringify({ path: url.pathname, method: req.method }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    upstream = { stop: () => server.stop(), url: `http://127.0.0.1:${server.port}` };
  });

  afterAll(async () => {
    upstream?.stop();
    await launched?.stop();
  });

  async function setupWithUpstream(upstreamUrl: string, extra?: { timeoutMs?: number }): Promise<Launched> {
    const root = await mkdtemp(join(tmpdir(), "mockstar-passthrough-"));
    const configRoot = join(root, "mocks");
    const handlersDir = join(root, "handlers");
    await mkdir(join(configRoot, "default"), { recursive: true });
    await mkdir(handlersDir, { recursive: true });

    // Mark the tenant as allowing private upstreams (stub runs on 127.0.0.1).
    await writeFile(
      join(configRoot, "default", "tenant.json"),
      JSON.stringify({ allowPrivateUpstreams: true }),
    );
    await writeFile(
      join(configRoot, "default", "proxy.json"),
      JSON.stringify({
        mocks: [
          {
            id: "proxy-ok",
            match: { method: "GET", path: "/proxied/hello" },
            response: { kind: "passthrough", upstream: upstreamUrl, timeoutMs: extra?.timeoutMs ?? 30_000 },
          },
          {
            id: "proxy-slow",
            match: { method: "GET", path: "/proxied/slow" },
            response: { kind: "passthrough", upstream: upstreamUrl, timeoutMs: extra?.timeoutMs ?? 100 },
          },
        ],
      }),
    );

    return launch({
      configRoot,
      handlersDir,
      deterministic: true,
      watch: false,
      installCrashHandlers: false,
      server: { tenancyModes: ["header"] },
    });
  }

  it("proxies matched requests to the upstream and returns upstream response", async () => {
    if (!upstream) throw new Error("upstream not started");
    launched = await setupWithUpstream(upstream.url);
    const res = await launched.server.hono.request("http://localhost/proxied/hello", {
      headers: { "x-mockstar-tenant": "default" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; method: string };
    expect(body.path).toBe("/proxied/hello");
    expect(body.method).toBe("GET");
    await launched.stop();
    launched = null;
  });

  it("surfaces upstream timeout as 502 with diagnostic body", async () => {
    if (!upstream) throw new Error("upstream not started");
    launched = await setupWithUpstream(upstream.url, { timeoutMs: 100 });
    const res = await launched.server.hono.request("http://localhost/proxied/slow", {
      headers: { "x-mockstar-tenant": "default" },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; upstream: string; aborted: boolean };
    expect(body.error).toBe("passthrough_upstream");
    expect(body.aborted).toBe(true);
    await launched.stop();
    launched = null;
  });

  it("rejects pass-through with private upstream when tenant has not opted in", async () => {
    if (!upstream) throw new Error("upstream not started");
    const root = await mkdtemp(join(tmpdir(), "mockstar-passthrough-rej-"));
    const configRoot = join(root, "mocks");
    const handlersDir = join(root, "handlers");
    await mkdir(join(configRoot, "default"), { recursive: true });
    await mkdir(handlersDir, { recursive: true });
    // Default tenant (no allowPrivateUpstreams) — the runtime URL validator must refuse at request time.
    await writeFile(
      join(configRoot, "default", "proxy.json"),
      JSON.stringify({
        mocks: [
          {
            id: "proxy-private",
            match: { method: "GET", path: "/proxied/hello" },
            response: { kind: "passthrough", upstream: upstream.url },
          },
        ],
      }),
    );
    launched = await launch({
      configRoot,
      handlersDir,
      deterministic: true,
      watch: false,
      installCrashHandlers: false,
      server: { tenancyModes: ["header"] },
    });
    const res = await launched.server.hono.request("http://localhost/proxied/hello", {
      headers: { "x-mockstar-tenant": "default" },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("passthrough_config");
    await launched.stop();
    launched = null;
  });

  // @constraint S5 — per-tenant body size cap
  // Issue #33 (follow-up): `safeParseBody` (src/server.ts) only caps JSON bodies — it
  // early-returns before touching the stream for anything else. A chunked, non-JSON body
  // routed to a pass-through entry reached `ctx.req.raw.arrayBuffer()` in
  // src/features/pass-through.ts with no cap at all. These tests cover the gap directly.
  describe("request body size cap on pass-through forwarding (S5 / #33)", () => {
    let capLaunched: Launched | null = null;

    afterEach(async () => {
      await capLaunched?.stop();
      capLaunched = null;
      echoCallCount = 0;
    });

    async function setupWithCap(maxBodyBytes: number): Promise<Launched> {
      if (!upstream) throw new Error("upstream not started");
      const root = await mkdtemp(join(tmpdir(), "mockstar-passthrough-cap-"));
      const configRoot = join(root, "mocks");
      const handlersDir = join(root, "handlers");
      await mkdir(join(configRoot, "default"), { recursive: true });
      await mkdir(handlersDir, { recursive: true });
      await writeFile(
        join(configRoot, "default", "tenant.json"),
        JSON.stringify({
          allowPrivateUpstreams: true,
          limits: { maxBodyBytes, requestsPerSecond: 1000, journalSize: 100 },
        }),
      );
      await writeFile(
        join(configRoot, "default", "proxy.json"),
        JSON.stringify({
          mocks: [
            {
              id: "proxy-echo",
              match: { method: "POST", path: "/proxied/echo-body" },
              response: { kind: "passthrough", upstream: upstream.url, timeoutMs: 30_000 },
            },
          ],
        }),
      );
      return launch({
        configRoot,
        handlersDir,
        deterministic: true,
        watch: false,
        installCrashHandlers: false,
        server: { tenancyModes: ["header"] },
      });
    }

    /**
     * Builds a POST request with NO Content-Length header (the shape a chunked
     * Transfer-Encoding request has once it reaches the server) whose bytes are produced
     * lazily, chunk by chunk, from `byteAt`. Mirrors `chunkedRequest` in
     * tests/limits.test.ts, generalized to carry a caller-chosen content-type and
     * arbitrary byte values (not just repeated "a") so it can also build binary payloads.
     */
    function chunkedRequest(
      path: string,
      totalBytes: number,
      byteAt: (offset: number) => number,
      contentType: string,
      onPull?: (totalPulled: number) => void,
    ): { request: Request; totalPulled: () => number } {
      let pulled = 0;
      const chunkSize = 64;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= totalBytes) {
            controller.close();
            return;
          }
          const size = Math.min(chunkSize, totalBytes - pulled);
          const chunk = new Uint8Array(size);
          for (let i = 0; i < size; i++) chunk[i] = byteAt(pulled + i);
          controller.enqueue(chunk);
          pulled += size;
          onPull?.(pulled);
        },
      });
      const request = new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "x-mockstar-tenant": "default", "content-type": contentType },
        body: stream,
        duplex: "half",
      } as RequestInit);
      return { request, totalPulled: () => pulled };
    }

    it("returns 413 for a chunked, non-JSON body over the cap, without buffering the whole body or reaching the upstream", async () => {
      capLaunched = await setupWithCap(100); // 100 bytes
      const oversizedBytes = 20 * 1024 * 1024; // 20MB — matches tests/limits.test.ts's repro size
      let maxPulled = 0;
      const { request, totalPulled } = chunkedRequest(
        "/proxied/echo-body",
        oversizedBytes,
        () => 0x61, // 'a'
        "application/octet-stream",
        (n) => {
          maxPulled = n;
        },
      );
      expect(request.headers.has("content-length")).toBe(false);

      const res = await capLaunched.server.hono.request(request);
      expect(res.status).toBe(413);
      const body = (await res.json()) as { error: string; limit: number };
      // Same 413 shape as the JSON path (src/server.ts's bodyTooLargeResponse) — not a
      // different error invented for this path.
      expect(body.error).toBe("body_too_large");
      expect(body.limit).toBe(100);

      // The source stream must have been aborted almost immediately after crossing the
      // cap, not drained to completion (20MB) before being measured.
      expect(totalPulled()).toBeLessThan(oversizedBytes);
      expect(maxPulled).toBeLessThan(10_000);
      // The cap must reject before ever forwarding to the upstream.
      expect(echoCallCount).toBe(0);
    });

    it("forwards a chunked, non-JSON body under the cap to the upstream byte-for-byte", async () => {
      capLaunched = await setupWithCap(10_000);
      const totalBytes = 500;
      const pattern = (i: number) => (i * 37 + 11) % 256; // varied, non-trivial byte pattern
      const { request } = chunkedRequest(
        "/proxied/echo-body",
        totalBytes,
        pattern,
        "application/octet-stream",
      );
      expect(request.headers.has("content-length")).toBe(false);

      const res = await capLaunched.server.hono.request(request);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-echo-length")).toBe(String(totalBytes));
      const received = new Uint8Array(await res.arrayBuffer());
      expect(received.length).toBe(totalBytes);
      const expected = new Uint8Array(totalBytes);
      for (let i = 0; i < totalBytes; i++) expected[i] = pattern(i);
      expect(received).toEqual(expected);
      expect(echoCallCount).toBe(1);
    });

    it("round-trips a binary (non-UTF8) body under the cap byte-for-byte", async () => {
      // A naive fix that caps the body by reading it as text (e.g. via .text() and
      // re-measuring) would corrupt this: bytes 0x80-0xBF standing alone are invalid UTF-8
      // continuation bytes, so decode-then-re-encode replaces them with U+FFFD (0xEF 0xBF
      // 0xBD) and the byte length no longer matches. Covers the full byte range 0-255.
      capLaunched = await setupWithCap(10_000);
      const totalBytes = 256;
      const { request } = chunkedRequest(
        "/proxied/echo-body",
        totalBytes,
        (i) => i % 256,
        "application/octet-stream",
      );

      const res = await capLaunched.server.hono.request(request);
      expect(res.status).toBe(200);
      const received = new Uint8Array(await res.arrayBuffer());
      const expected = new Uint8Array(totalBytes);
      for (let i = 0; i < totalBytes; i++) expected[i] = i % 256;
      expect(received).toEqual(expected);
    });

    it("still forwards a normal (Content-Length, non-chunked) under-cap body unchanged", async () => {
      // Regression guard: the refactor that shares the cap mechanism between the JSON path
      // and pass-through forwarding must not disturb the ordinary, non-chunked case.
      capLaunched = await setupWithCap(10_000);
      const payload = "plain pass-through body, unchanged";
      const res = await capLaunched.server.hono.request("http://localhost/proxied/echo-body", {
        method: "POST",
        headers: {
          "x-mockstar-tenant": "default",
          "content-type": "text/plain",
          "content-length": String(payload.length),
        },
        body: payload,
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(payload);
      expect(echoCallCount).toBe(1);
    });
  });
});
