// @constraint T9 — per-route pass-through with timeout + diagnostic errors
// @constraint RT-8.2 — URL validation at request time
// @constraint G10 — pass-through test coverage

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Launched, launch } from "../src/index.ts";

describe("pass-through handler (T9)", () => {
  let upstream: { stop: () => void; url: string } | null = null;
  let launched: Launched | null = null;

  beforeAll(() => {
    // Start a stub upstream on a dynamic port using Bun.serve.
    // biome-ignore lint/suspicious/noExplicitAny: Bun global
    const bun = (globalThis as any).Bun;
    const server = bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req: Request): Response {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/slow")) {
          return new Promise<Response>((resolve) =>
            setTimeout(() => resolve(new Response("too late", { status: 200 })), 2000),
          ) as unknown as Response;
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
});
