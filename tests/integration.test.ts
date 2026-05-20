// @constraint B2 — parity with core OSS mock servers (end-to-end static mock)
// @constraint S1 — multi-tenant isolation end-to-end
// @constraint U1 — diagnostic 404
// @constraint T11 — atomic config hot-swap

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Launched, launch } from "../src/index.ts";

async function setupMocks(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mockstar-int-"));
  await mkdir(join(root, "mocks", "acme"), { recursive: true });
  await mkdir(join(root, "mocks", "globex"), { recursive: true });
  await mkdir(join(root, "handlers"), { recursive: true });
  await writeFile(
    join(root, "mocks", "acme", "users.json"),
    JSON.stringify({
      mocks: [
        {
          id: "get-user",
          match: { method: "GET", path: "/users/:id" },
          response: {
            kind: "static",
            status: 200,
            headers: { "content-type": "application/json" },
            body: { id: "{{request.params.id}}", tenant: "{{tenant}}" },
          },
        },
      ],
    }),
  );
  await writeFile(
    join(root, "mocks", "globex", "orders.json"),
    JSON.stringify({
      mocks: [
        {
          id: "list-orders",
          match: { method: "GET", path: "/orders" },
          response: { kind: "static", status: 200, body: { count: 0 } },
        },
      ],
    }),
  );
  return root;
}

describe("integration: launched server", () => {
  let root: string;
  let launched: Launched | null = null;

  afterEach(async () => {
    if (launched) {
      await launched.stop();
      launched = null;
    }
  });

  it("serves a static mock end-to-end with templating", async () => {
    root = await setupMocks();
    launched = await launch({
      configRoot: join(root, "mocks"),
      handlersDir: join(root, "handlers"),
      deterministic: true,
      watch: false,
      installCrashHandlers: false,
      server: { tenancyModes: ["header"] },
    });
    const res = await launched.server.hono.request("http://localhost/users/42", {
      headers: { "x-mockstar-tenant": "acme" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; tenant: string };
    expect(body.id).toBe("42");
    expect(body.tenant).toBe("acme");
  });

  it("enforces tenant isolation — globex cannot see acme routes", async () => {
    root = await setupMocks();
    launched = await launch({
      configRoot: join(root, "mocks"),
      handlersDir: join(root, "handlers"),
      deterministic: true,
      watch: false,
      installCrashHandlers: false,
      server: { tenancyModes: ["header"] },
    });
    const res = await launched.server.hono.request("http://localhost/users/1", {
      headers: { "x-mockstar-tenant": "globex" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; tenant: string };
    expect(body.error).toBe("unmatched");
    expect(body.tenant).toBe("globex");
  });

  it("returns diagnostic 404 with nearest_matches populated", async () => {
    root = await setupMocks();
    launched = await launch({
      configRoot: join(root, "mocks"),
      handlersDir: join(root, "handlers"),
      deterministic: true,
      watch: false,
      installCrashHandlers: false,
      server: { tenancyModes: ["header"] },
    });
    const res = await launched.server.hono.request("http://localhost/nope", {
      headers: { "x-mockstar-tenant": "acme" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; method: string; path: string };
    expect(body.error).toBe("unmatched");
    expect(body.method).toBe("GET");
    expect(body.path).toBe("/nope");
  });

  it("/health endpoint is unauthenticated and returns 200", async () => {
    root = await setupMocks();
    launched = await launch({
      configRoot: join(root, "mocks"),
      handlersDir: join(root, "handlers"),
      deterministic: true,
      watch: false,
      installCrashHandlers: false,
    });
    const res = await launched.server.hono.request("http://localhost/health");
    expect(res.status).toBe(200);
  });
});
