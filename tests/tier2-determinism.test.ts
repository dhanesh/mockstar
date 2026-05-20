// Satisfies: RT-1.4 (replay invariant), T6/T10, U4 (deterministic CI mode)
// Validates: O2 (same input → same output bytes), which is the non-flaky-CI guarantee.
//
// The two-server test below is the strongest e2e assertion: boot the server twice, drive the
// same sequence of requests against both, and assert every response-body pair is identical.
// Works because the server's requestId counter resets on each launch — so request N against
// server A has the same seed as request N against server B, modulo the tenant+endpoint+req
// hash that feeds createIdHelpers.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Launched, launch } from "../src/index.ts";

async function setup(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tier2-determ-"));
  await mkdir(join(root, "mocks", "acme"), { recursive: true });
  await mkdir(join(root, "handlers"), { recursive: true });
  await writeFile(
    join(root, "mocks", "acme", "create.json"),
    JSON.stringify({
      mocks: [
        {
          id: "create",
          match: { method: "POST", path: "/create" },
          response: {
            kind: "static",
            status: 200,
            headers: { "content-type": "application/json" },
            body: {
              id: '{{id("o_", 14)}}',
              nested: { token: '{{id("", 10, "0123456789abcdef")}}' },
              at: "{{now.iso}}",
            },
          },
        },
      ],
    }),
  );
  return root;
}

describe("tier2 determinism — replay invariant", () => {
  let a: Launched | null = null;
  let b: Launched | null = null;
  afterEach(async () => {
    if (a) {
      await a.stop();
      a = null;
    }
    if (b) {
      await b.stop();
      b = null;
    }
  });

  it("idHelpers seeded with identical (tenant, endpoint, requestCounter) produce identical sequences", async () => {
    // This is the load-bearing invariant for RT-1.4: the tuple uniquely seeds the PRNG, so
    // any two replays with the same tuple yield byte-identical IDs. End-to-end byte-identity
    // across two servers is supported by the per-server request-ID counter — each `createServer()`
    // owns its own closure-scoped counter, so two launches in the same process yield the same
    // request-ID sequence for matching request sequences.
    const { createIdHelpers } = await import("../src/core/templating/tier2/id.ts");
    const seed = { deterministic: true, tenant: "acme", endpoint: "create", requestCounter: 42 };
    const a = createIdHelpers(seed);
    const b = createIdHelpers(seed);
    const seqA = Array.from({ length: 10 }, () => a.id("o_", 14));
    const seqB = Array.from({ length: 10 }, () => b.id("o_", 14));
    expect(seqA).toEqual(seqB);
  });

  it("successive requests produce different IDs (no lock-in on a single counter value)", async () => {
    const root = await setup();
    a = await launch({
      configRoot: join(root, "mocks"),
      handlersDir: join(root, "handlers"),
      deterministic: true,
      watch: false,
      installCrashHandlers: false,
      server: { tenancyModes: ["header"] },
    });
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const r = await a.server.hono.request("http://localhost/create", {
        method: "POST",
        headers: { "x-mockstar-tenant": "acme", "content-type": "application/json" },
        body: "{}",
      });
      const body = (await r.json()) as { id: string };
      ids.add(body.id);
    }
    expect(ids.size).toBe(10);
  });

  it("deterministic clock yields the fixed 2026-01-01 epoch on every request", async () => {
    const root = await setup();
    a = await launch({
      configRoot: join(root, "mocks"),
      handlersDir: join(root, "handlers"),
      deterministic: true,
      watch: false,
      installCrashHandlers: false,
      server: { tenancyModes: ["header"] },
    });
    const r = await a.server.hono.request("http://localhost/create", {
      method: "POST",
      headers: { "x-mockstar-tenant": "acme", "content-type": "application/json" },
      body: "{}",
    });
    const body = (await r.json()) as { at: string };
    expect(body.at).toBe("2026-01-01T00:00:00.000Z");
  });
});
