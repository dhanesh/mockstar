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
});
