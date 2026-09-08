// @constraint T9/RT-8.2 — pass-through re-validates every redirect hop, not just the initial URL (#37)
// Core SSRF-target-rejected coverage lives in tests/redirect-guard.test.ts (fetchWithRedirectGuard
// unit-integration — see that file's header for why the "public initial host, private redirect
// target" scenario can't be reproduced end-to-end without real public DNS). This file proves
// src/features/pass-through.ts actually threads the guard through a real forwarded request.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_REDIRECT_HOPS } from "../src/features/url-validator.ts";
import { type Launched, launch } from "../src/index.ts";

describe("pass-through — redirect guard wiring (#37)", () => {
  let launched: Launched | null = null;

  afterEach(async () => {
    await launched?.stop();
    launched = null;
  });

  async function setupWithUpstream(upstreamUrl: string): Promise<Launched> {
    const root = await mkdtemp(join(tmpdir(), "mockstar-passthrough-redirect-"));
    const configRoot = join(root, "mocks");
    const handlersDir = join(root, "handlers");
    await mkdir(join(configRoot, "default"), { recursive: true });
    await mkdir(handlersDir, { recursive: true });
    await writeFile(
      join(configRoot, "default", "tenant.json"),
      JSON.stringify({ allowPrivateUpstreams: true }),
    );
    await writeFile(
      join(configRoot, "default", "proxy.json"),
      JSON.stringify({
        mocks: [
          {
            id: "proxy-redirect",
            match: { method: "GET", path: "/proxied/hello" },
            response: { kind: "passthrough", upstream: upstreamUrl, timeoutMs: 30_000 },
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

  it("follows a legitimate redirect end-to-end and returns the target's response verbatim", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: Bun global
    const Bun = (globalThis as any).Bun;
    let target: { url: string; port: number; stop: () => void } | null = null;
    const front = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(): Response {
        if (!target) throw new Error("target not ready");
        return new Response(null, { status: 302, headers: { location: `${target.url}/landed` } });
      },
    });
    let targetHits = 0;
    const targetServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(): Response {
        targetHits += 1;
        return new Response(JSON.stringify({ from: "target" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    target = {
      url: `http://127.0.0.1:${targetServer.port}`,
      port: targetServer.port,
      stop: () => targetServer.stop(),
    };

    try {
      launched = await setupWithUpstream(`http://127.0.0.1:${front.port}`);
      const res = await launched.server.hono.request("http://localhost/proxied/hello", {
        headers: { "x-mockstar-tenant": "default" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { from: string };
      expect(body.from).toBe("target");
      expect(targetHits).toBe(1);
    } finally {
      front.stop();
      target.stop();
    }
  });

  it(`fails closed with a 502 when the upstream redirect chain exceeds the ${DEFAULT_MAX_REDIRECT_HOPS}-hop cap, instead of looping forever`, async () => {
    // biome-ignore lint/suspicious/noExplicitAny: Bun global
    const Bun = (globalThis as any).Bun;
    let hitCount = 0;
    const looping = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(): Response {
        hitCount += 1;
        // Relative Location — always redirects back to the same path on the same host.
        return new Response(null, { status: 302, headers: { location: "/proxied/hello" } });
      },
    });

    try {
      launched = await setupWithUpstream(`http://127.0.0.1:${looping.port}`);
      const res = await launched.server.hono.request("http://localhost/proxied/hello", {
        headers: { "x-mockstar-tenant": "default" },
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string; reason?: string };
      expect(body.error).toBe("passthrough_upstream");
      expect(body.reason).toBe("upstream redirected to a URL rejected by validator");
      // Exactly hop-cap + 1 dials: bounded, not unbounded.
      expect(hitCount).toBe(DEFAULT_MAX_REDIRECT_HOPS + 1);
    } finally {
      looping.stop();
    }
  });
});
