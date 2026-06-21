// Satisfies: RT-1 (request-derived responses), RT-2 (type preservation end-to-end),
//            RT-8 (tenant × endpoint × request isolation)
// Validates: B1, B2, T2, U1 — every request-scope token resolves at render time
//            through a live server, not a unit stub.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Launched, launch } from "../src/index.ts";

async function setupTenant(mocks: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mockstar-tier2-echo-"));
  await mkdir(join(root, "mocks", "acme"), { recursive: true });
  await mkdir(join(root, "handlers"), { recursive: true });
  await writeFile(join(root, "mocks", "acme", "echo.json"), JSON.stringify(mocks));
  return root;
}

describe("tier2 echo — request-derived responses end-to-end", () => {
  let launched: Launched | null = null;
  afterEach(async () => {
    if (launched) {
      await launched.stop();
      launched = null;
    }
  });

  async function boot(mocks: unknown): Promise<Launched> {
    const root = await setupTenant(mocks);
    return launch({
      configRoot: join(root, "mocks"),
      handlersDir: join(root, "handlers"),
      deterministic: true,
      watch: false,
      installCrashHandlers: false,
      server: { tenancyModes: ["header"] },
    });
  }

  it("echoes request.body fields with type preservation (number stays number, object stays object)", async () => {
    launched = await boot({
      mocks: [
        {
          id: "echo",
          match: { method: "POST", path: "/echo" },
          response: {
            kind: "static",
            status: 200,
            headers: { "content-type": "application/json" },
            body: {
              amount: "{{request.body.amount}}",
              notes: "{{request.body.notes}}",
              label: "prefix-{{request.body.label}}-suffix",
            },
          },
        },
      ],
    });
    const res = await launched.server.hono.request("http://localhost/echo", {
      method: "POST",
      headers: { "x-mockstar-tenant": "acme", "content-type": "application/json" },
      body: JSON.stringify({ amount: 4200, notes: { a: 1, b: [2, 3] }, label: "x" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { amount: unknown; notes: unknown; label: unknown };
    expect(body.amount).toBe(4200);
    expect(typeof body.amount).toBe("number");
    expect(body.notes).toEqual({ a: 1, b: [2, 3] });
    expect(body.label).toBe("prefix-x-suffix");
  });

  it("echoes request.query, request.params, and request.headers", async () => {
    launched = await boot({
      mocks: [
        {
          id: "echo-all",
          match: { method: "GET", path: "/echo/:id" },
          response: {
            kind: "static",
            status: 200,
            body: {
              id: "{{request.params.id}}",
              page: "{{request.query.page}}",
              ua: "{{request.headers.user-agent}}",
            },
          },
        },
      ],
    });
    const res = await launched.server.hono.request("http://localhost/echo/42?page=7", {
      headers: { "x-mockstar-tenant": "acme", "user-agent": "mockstar-test/1.0" },
    });
    const body = (await res.json()) as { id: string; page: string; ua: string };
    expect(body.id).toBe("42");
    expect(body.page).toBe("7");
    expect(body.ua).toBe("mockstar-test/1.0");
  });

  it("substitutes {{id()}} with a provider-shape value and {{now.iso}} with a deterministic timestamp", async () => {
    launched = await boot({
      mocks: [
        {
          id: "create",
          match: { method: "POST", path: "/create" },
          response: {
            kind: "static",
            status: 200,
            body: {
              id: '{{id("order_", 14)}}',
              created_at: "{{now.iso}}",
            },
          },
        },
      ],
    });
    const res = await launched.server.hono.request("http://localhost/create", {
      method: "POST",
      headers: { "x-mockstar-tenant": "acme", "content-type": "application/json" },
      body: "{}",
    });
    const body = (await res.json()) as { id: string; created_at: string };
    expect(body.id).toMatch(/^order_[A-Za-z0-9]{14}$/);
    expect(body.created_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("each request gets an independent id (per-request seed, no shared PRNG state)", async () => {
    launched = await boot({
      mocks: [
        {
          id: "create",
          match: { method: "POST", path: "/create" },
          response: {
            kind: "static",
            status: 200,
            body: { id: '{{id("x_", 10)}}' },
          },
        },
      ],
    });
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const res = await launched.server.hono.request("http://localhost/create", {
        method: "POST",
        headers: { "x-mockstar-tenant": "acme", "content-type": "application/json" },
        body: "{}",
      });
      const body = (await res.json()) as { id: string };
      ids.add(body.id);
    }
    expect(ids.size).toBe(20);
  });

  it("unknown request-scope fields render as empty string, never crash", async () => {
    launched = await boot({
      mocks: [
        {
          id: "echo-missing",
          match: { method: "GET", path: "/missing" },
          response: {
            kind: "static",
            status: 200,
            body: {
              value: "{{request.body.nonexistent}}",
              label: "head-{{request.body.nonexistent}}-tail",
            },
          },
        },
      ],
    });
    const res = await launched.server.hono.request("http://localhost/missing", {
      headers: { "x-mockstar-tenant": "acme" },
    });
    const body = (await res.json()) as { value: unknown; label: string };
    expect(res.status).toBe(200);
    expect(body.label).toBe("head--tail");
  });
});
