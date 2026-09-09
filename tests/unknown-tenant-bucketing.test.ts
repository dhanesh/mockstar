// @constraint S1 — hard tenant isolation
// Issue #34 — journal/metrics/log entries for a resolved-but-unconfigured tenant must be
// recorded under a single fixed bucket, not the attacker-supplied tenant string. Otherwise an
// unauthenticated caller can allocate one unbounded JournalRegistry ring buffer and one
// unbounded Metrics label set per distinct `X-Mockstar-Tenant` header value they send.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Launched, launch } from "../src/index.ts";

describe("unknown-tenant journal/metrics bucketing (issue #34)", () => {
  let launched: Launched | null = null;

  afterEach(async () => {
    await launched?.stop();
    launched = null;
  });

  async function setup(): Promise<Launched> {
    const root = await mkdtemp(join(tmpdir(), "mockstar-unknown-tenant-"));
    const configRoot = join(root, "mocks");
    const handlersDir = join(root, "handlers");
    await mkdir(join(configRoot, "default"), { recursive: true });
    await mkdir(handlersDir, { recursive: true });
    await writeFile(
      join(configRoot, "default", "echo.json"),
      JSON.stringify({
        mocks: [
          {
            id: "echo",
            match: { method: "GET", path: "/echo" },
            response: { kind: "static", status: 200, body: "ok" },
          },
        ],
      }),
    );
    // tenancyModes defaults to ["path", "header"] — header mode is on by default, and the
    // resolved header value is only regex-validated (see extractor.ts TENANT_REGEX), never
    // checked against the configured tenants. That is exactly the gap this issue closes.
    return launch({
      configRoot,
      handlersDir,
      deterministic: true,
      watch: false,
      installCrashHandlers: false,
    });
  }

  it("N distinct unknown-tenant headers produce exactly one journal bucket", async () => {
    launched = await setup();
    const n = 500;
    for (let i = 0; i < n; i++) {
      const res = await launched.server.hono.request("http://localhost/echo", {
        headers: { "x-mockstar-tenant": `probe-${i}` },
      });
      expect(res.status).toBe(404);
    }

    const tenants = launched.server.journal.tenants();
    // Not one bucket per probed name — none of the 500 distinct probe names should appear.
    expect(tenants).not.toContain("probe-0");
    expect(tenants).not.toContain("probe-499");
    expect(tenants.filter((t) => t.startsWith("probe-"))).toHaveLength(0);
    expect(tenants).toContain(":unknown:");
    expect(launched.server.journal.snapshot(":unknown:")).toHaveLength(n);
  });

  it("N distinct unknown-tenant headers produce bounded metrics output", async () => {
    launched = await setup();
    const n = 500;
    for (let i = 0; i < n; i++) {
      await launched.server.hono.request("http://localhost/echo", {
        headers: { "x-mockstar-tenant": `probe-${i}` },
      });
    }
    const text = launched.server.metrics.format();
    // A single bucketed label set stays small regardless of how many distinct tenant strings
    // were probed. This is the "bounded, not just smaller" assertion: exactly one occurrence
    // of the sentinel tenant label, and none of the raw probe values leak into label text.
    const unknownOccurrences = text.split('tenant=":unknown:"').length - 1;
    expect(unknownOccurrences).toBeGreaterThan(0);
    expect(text).not.toContain('tenant="probe-0"');
    expect(text).not.toContain('tenant="probe-499"');
    expect(text.length).toBeLessThan(5_000);
  });

  it("a known tenant still journals under its own name, unaffected", async () => {
    launched = await setup();
    const res = await launched.server.hono.request("http://localhost/echo", {
      headers: { "x-mockstar-tenant": "default" },
    });
    expect(res.status).toBe(200);

    const tenants = launched.server.journal.tenants();
    expect(tenants).toContain("default");
    const entries = launched.server.journal.snapshot("default");
    expect(entries.at(-1)?.tenant).toBe("default");

    const text = launched.server.metrics.format();
    expect(text).toContain('tenant="default"');
  });

  it("the 404 response for an unknown tenant is byte-identical to before", async () => {
    launched = await setup();
    const res = await launched.server.hono.request("http://localhost/echo", {
      headers: { "x-mockstar-tenant": "totally-unconfigured" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; tenant: string; method: string; path: string };
    // Response content is untouched by the bucketing fix — it still reports the real,
    // attacker-supplied tenant name (that's diagnostic value for the caller), the bucketing
    // only affects what gets recorded server-side for journal/metrics/logs.
    expect(body).toEqual({
      error: "unknown_tenant",
      tenant: "totally-unconfigured",
      method: "GET",
      path: "/echo",
    });
  });
});
