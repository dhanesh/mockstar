// @constraint S5 — per-tenant body size cap
// @constraint G14 — limits test coverage

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Launched, launch } from "../src/index.ts";

describe("body size cap (S5)", () => {
  let launched: Launched | null = null;

  afterEach(async () => {
    await launched?.stop();
    launched = null;
  });

  async function setupWithLimit(maxBodyBytes: number): Promise<Launched> {
    const root = await mkdtemp(join(tmpdir(), "mockstar-limits-"));
    const configRoot = join(root, "mocks");
    const handlersDir = join(root, "handlers");
    await mkdir(join(configRoot, "default"), { recursive: true });
    await mkdir(handlersDir, { recursive: true });
    await writeFile(
      join(configRoot, "default", "tenant.json"),
      JSON.stringify({ limits: { maxBodyBytes, requestsPerSecond: 1000, journalSize: 100 } }),
    );
    await writeFile(
      join(configRoot, "default", "echo.json"),
      JSON.stringify({
        mocks: [
          {
            id: "echo",
            match: { method: "POST", path: "/echo" },
            response: { kind: "static", status: 200, body: "ok" },
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

  it("returns 413 when Content-Length exceeds tenant maxBodyBytes", async () => {
    launched = await setupWithLimit(100); // 100 bytes
    const oversized = "a".repeat(500);
    const res = await launched.server.hono.request("http://localhost/echo", {
      method: "POST",
      headers: {
        "x-mockstar-tenant": "default",
        "content-type": "application/json",
        "content-length": String(oversized.length),
      },
      body: oversized,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; limit: number };
    expect(body.error).toBe("body_too_large");
    expect(body.limit).toBe(100);
  });

  it("allows normal-sized requests through", async () => {
    launched = await setupWithLimit(1000);
    const res = await launched.server.hono.request("http://localhost/echo", {
      method: "POST",
      headers: {
        "x-mockstar-tenant": "default",
        "content-type": "application/json",
        "content-length": "10",
      },
      body: '{"a": 1}',
    });
    expect(res.status).toBe(200);
  });

  /**
   * Builds a POST request with NO Content-Length header — the exact shape a chunked
   * Transfer-Encoding request has once it reaches the server. Tracks how many bytes were
   * actually pulled off the source stream before it stopped, so a test can assert the body
   * was never fully buffered rather than just asserting on the response status.
   */
  function chunkedRequest(
    bodyBytes: number,
    onPull: (totalPulled: number) => void,
  ): { request: Request; totalPulled: () => number } {
    let pulled = 0;
    const chunkSize = 64;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= bodyBytes) {
          controller.close();
          return;
        }
        const size = Math.min(chunkSize, bodyBytes - pulled);
        controller.enqueue(new TextEncoder().encode("a".repeat(size)));
        pulled += size;
        onPull(pulled);
      },
    });
    const request = new Request("http://localhost/echo", {
      method: "POST",
      headers: {
        "x-mockstar-tenant": "default",
        "content-type": "application/json",
        // Deliberately no content-length — this is what makes it "chunked" for our purposes:
        // the server cannot derive a size cap from headers alone.
      },
      body: stream,
      duplex: "half",
    } as RequestInit);
    return { request, totalPulled: () => pulled };
  }

  it("returns 413 for a chunked request over the cap, without buffering the whole body", async () => {
    launched = await setupWithLimit(100); // 100 bytes
    const oversizedBytes = 20 * 1024 * 1024; // 20MB — matches the issue's live repro
    let maxPulled = 0;
    const { request, totalPulled } = chunkedRequest(oversizedBytes, (n) => {
      maxPulled = n;
    });
    expect(request.headers.has("content-length")).toBe(false);

    const res = await launched.server.hono.request(request);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; limit: number };
    expect(body.error).toBe("body_too_large");
    expect(body.limit).toBe(100);

    // The source stream must have been aborted almost immediately after crossing the cap,
    // not drained to completion (20MB) before being measured.
    expect(totalPulled()).toBeLessThan(oversizedBytes);
    expect(maxPulled).toBeLessThan(10_000);
  });

  it("allows a chunked request under the cap through", async () => {
    launched = await setupWithLimit(1000);
    const { request } = chunkedRequest(50, () => {});
    const res = await launched.server.hono.request(request);
    expect(res.status).toBe(200);
  });

  it("allows a chunked request whose body is exactly at the cap", async () => {
    launched = await setupWithLimit(100);
    // Body is a 100-byte JSON string literal so JSON.parse succeeds and length matches the cap
    // (2 quote bytes + 98 'a' bytes).
    const exact = JSON.stringify("a".repeat(100 - 2));
    expect(exact.length).toBe(100);
    let pulled = 0;
    const bytes = new TextEncoder().encode(exact);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= bytes.length) {
          controller.close();
          return;
        }
        const chunk = bytes.slice(pulled, pulled + 16);
        controller.enqueue(chunk);
        pulled += chunk.length;
      },
    });
    const request = new Request("http://localhost/echo", {
      method: "POST",
      headers: {
        "x-mockstar-tenant": "default",
        "content-type": "application/json",
      },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(request.headers.has("content-length")).toBe(false);

    const res = await launched.server.hono.request(request);
    expect(res.status).toBe(200);
  });

  it("still returns 413 via the existing Content-Length fast path", async () => {
    launched = await setupWithLimit(100);
    const oversized = "a".repeat(500);
    const res = await launched.server.hono.request("http://localhost/echo", {
      method: "POST",
      headers: {
        "x-mockstar-tenant": "default",
        "content-type": "application/json",
        "content-length": String(oversized.length),
      },
      body: oversized,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; limit: number };
    expect(body.error).toBe("body_too_large");
    expect(body.limit).toBe(100);
  });
});
