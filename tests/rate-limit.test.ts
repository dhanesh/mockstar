// @constraint S5 — per-tenant request rate cap
// Closes: #35 (requestsPerSecond declared in schema but read by no code path)
//
// Deterministic by construction: every behavioural test below injects `rateLimiterNow`
// (CreateServerOptions, src/server.ts) as the token bucket's time source, so the window
// is advanced by mutating a plain variable — no wall-clock sleeps, no flakiness. One real
// end-to-end test at the bottom uses the real clock as a sanity check that the wiring
// through `launch()` (not just the low-level `createServer` used everywhere else here)
// actually works.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entry } from "../src/core/config/schema.ts";
import { TenantLimits } from "../src/core/config/schema.ts";
import { SnapshotHolder } from "../src/core/config/snapshot.ts";
import type { HandlerRegistry } from "../src/core/handlers/index.ts";
import { buildMatchIndex } from "../src/core/matching/index.ts";
import { compileEntryResponses } from "../src/core/templating/compiler.ts";
import { type Launched, launch } from "../src/index.ts";
import type { RunningServer } from "../src/server.ts";
import { createServer } from "../src/server.ts";

const emptyRegistry: HandlerRegistry = Object.freeze({
  get size() {
    return 0;
  },
  has: () => false,
  get: () => undefined,
  names: () => [],
});

const pingEntry: Entry = {
  id: "ping",
  match: { method: "GET", path: "/ping", priority: 0 },
  response: { kind: "static", status: 200, body: "ok" },
};

/**
 * Builds a server with one or more header-mode tenants, each with its own configured
 * `requestsPerSecond`, sharing one deterministic clock (`nowRef`) that tests advance by
 * mutating `nowRef.ms` directly.
 */
function makeServer(tenantLimits: Record<string, number | undefined>, nowRef: { ms: number }): RunningServer {
  const matchIndex = buildMatchIndex([pingEntry]);
  const compiledResponses = compileEntryResponses([pingEntry]);

  const tenants = new Map(
    Object.entries(tenantLimits).map(([name, rps]) => [
      name,
      {
        name,
        entries: [pingEntry],
        matchIndex,
        compiledResponses,
        compiledScenarios: new Map(),
        compiledWebhooks: new Map(),
        limits: TenantLimits.parse(rps === undefined ? {} : { requestsPerSecond: rps }),
        allowPrivateUpstreams: false,
      },
    ]),
  );

  const holder = new SnapshotHolder({
    version: 1,
    server: {
      host: "127.0.0.1",
      port: 3000,
      tenancyModes: ["header"],
      deterministic: true,
      adminEnabled: false,
    },
    // biome-ignore lint/suspicious/noExplicitAny: test fixture, matches scenarios-integration.test.ts's shim
    tenants: tenants as any,
    handlers: emptyRegistry,
  });

  return createServer({
    holder,
    registry: emptyRegistry,
    deterministic: true,
    installCrashHandlers: false,
    rateLimiterNow: () => nowRef.ms,
  });
}

async function ping(server: RunningServer, tenant: string): Promise<Response> {
  return server.hono.request("http://localhost/ping", { headers: { "x-mockstar-tenant": tenant } });
}

describe("per-tenant rate limiting (S5 / #35)", () => {
  it("the schema default is 10_000 rps", () => {
    expect(TenantLimits.parse({}).requestsPerSecond).toBe(10_000);
  });

  it("a configured value overrides the default", () => {
    expect(TenantLimits.parse({ requestsPerSecond: 3 }).requestsPerSecond).toBe(3);
  });

  it("under the limit: all requests get 200", async () => {
    const nowRef = { ms: 0 };
    const server = makeServer({ default: 10 }, nowRef);
    for (let i = 0; i < 5; i++) {
      const res = await ping(server, "default");
      expect(res.status).toBe(200);
    }
  });

  it("exceeding the limit returns 429 with the rate_limited shape and Retry-After", async () => {
    const nowRef = { ms: 0 };
    const server = makeServer({ default: 3 }, nowRef);
    for (let i = 0; i < 3; i++) {
      const res = await ping(server, "default");
      expect(res.status).toBe(200);
    }
    const res = await ping(server, "default");
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; limit: number };
    expect(body).toEqual({ error: "rate_limited", limit: 3 });
    const retryAfter = res.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
  });

  it("burst tolerance: a large burst within one tick, under the limit, is not throttled", async () => {
    // A naive fixed-window counter would 429 some of these — 200 requests fired
    // concurrently (no `await` between them, clock frozen: zero elapsed time) with a
    // budget of 250 is squarely the "burst that lands in one window" case a fixed window
    // gets wrong. The token bucket starts every fresh tenant bucket FULL (== the
    // configured rps), so this succeeds outright.
    const nowRef = { ms: 0 };
    const server = makeServer({ default: 250 }, nowRef);
    const results = await Promise.all(Array.from({ length: 200 }, () => ping(server, "default")));
    for (const res of results) expect(res.status).toBe(200);
  });

  it("the window recovers after the clock advances", async () => {
    const nowRef = { ms: 0 };
    const server = makeServer({ default: 3 }, nowRef);
    for (let i = 0; i < 3; i++) {
      expect((await ping(server, "default")).status).toBe(200);
    }
    expect((await ping(server, "default")).status).toBe(429);

    // Advance the injected clock by a full second — the bucket refills to capacity.
    nowRef.ms += 1000;

    expect((await ping(server, "default")).status).toBe(200);
  });

  it("per-tenant isolation: tenant A exhausting its budget does not affect tenant B", async () => {
    const nowRef = { ms: 0 };
    const server = makeServer({ tenantA: 2, tenantB: 2 }, nowRef);
    expect((await ping(server, "tenantA")).status).toBe(200);
    expect((await ping(server, "tenantA")).status).toBe(200);
    expect((await ping(server, "tenantA")).status).toBe(429); // A is exhausted...

    // ...B is untouched.
    expect((await ping(server, "tenantB")).status).toBe(200);
    expect((await ping(server, "tenantB")).status).toBe(200);
  });

  it("unknown tenants share one bucket and do not allocate unbounded state (mirrors #34)", async () => {
    const nowRef = { ms: 0 };
    const server = makeServer({ default: 10_000 }, nowRef);

    const n = 50;
    for (let i = 0; i < n; i++) {
      const res = await ping(server, `probe-${i}`);
      expect(res.status).toBe(404); // unresolved tenant — under the shared bucket's ample fallback capacity
    }
    // Exactly one bucket for every one of the 50 distinct probed tenant names — not 50.
    expect(server.rateLimiter.bucketCount).toBe(1);

    // A request from a KNOWN tenant gets its own bucket, on top of the shared one.
    expect((await ping(server, "default")).status).toBe(200);
    expect(server.rateLimiter.bucketCount).toBe(2);
  });
});

describe("rate limiting end-to-end via launch() (real clock sanity check)", () => {
  let launched: Launched | null = null;

  afterEach(async () => {
    await launched?.stop();
    launched = null;
  });

  it("a tight per-tenant limit throttles a rapid-fire pair of requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "mockstar-ratelimit-"));
    const configRoot = join(root, "mocks");
    const handlersDir = join(root, "handlers");
    await mkdir(join(configRoot, "default"), { recursive: true });
    await mkdir(handlersDir, { recursive: true });
    await writeFile(
      join(configRoot, "default", "tenant.json"),
      JSON.stringify({ limits: { requestsPerSecond: 1 } }),
    );
    await writeFile(
      join(configRoot, "default", "ping.json"),
      JSON.stringify({
        mocks: [
          {
            id: "ping",
            match: { method: "GET", path: "/ping", priority: 0 },
            response: { kind: "static", status: 200, body: "ok" },
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

    const first = await launched.server.hono.request("http://localhost/ping", {
      headers: { "x-mockstar-tenant": "default" },
    });
    const second = await launched.server.hono.request("http://localhost/ping", {
      headers: { "x-mockstar-tenant": "default" },
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).not.toBeNull();
  });
});
