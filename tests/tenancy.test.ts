// @constraint S1 — tenant isolation
// @constraint S2 — three configurable tenant-identification modes
// @constraint RT-4 — tenant routing first, atomic, immutable

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { effectivePath, tenantMiddleware } from "../src/core/tenancy/index.ts";

function app(modes: Array<"path" | "subdomain" | "header">): Hono {
  const a = new Hono();
  a.use("*", tenantMiddleware({ modes }));
  a.get("/:rest?/*?", (ctx) => ctx.json({ tenant: ctx.var.tenant, path: effectivePath(ctx) }));
  a.get("*", (ctx) => ctx.json({ tenant: ctx.var.tenant, path: effectivePath(ctx) }));
  return a;
}

describe("tenantMiddleware", () => {
  it("extracts tenant from path prefix /t/{tenant}", async () => {
    const a = app(["path"]);
    const res = await a.request("http://localhost/t/acme/users/1");
    const body = (await res.json()) as { tenant: string; path: string };
    expect(body.tenant).toBe("acme");
    expect(body.path).toBe("/users/1");
  });

  it("extracts tenant from header", async () => {
    const a = app(["header"]);
    const res = await a.request("http://localhost/users/1", { headers: { "x-mockstar-tenant": "globex" } });
    const body = (await res.json()) as { tenant: string };
    expect(body.tenant).toBe("globex");
  });

  it("extracts tenant from subdomain", async () => {
    const a = app(["subdomain"]);
    const res = await a.request("http://contoso.mockstar.local/hello");
    const body = (await res.json()) as { tenant: string };
    expect(body.tenant).toBe("contoso");
  });

  it('falls back to "default" tenant when none supplied (non-strict)', async () => {
    const a = app(["header"]);
    const res = await a.request("http://localhost/anywhere");
    const body = (await res.json()) as { tenant: string };
    expect(body.tenant).toBe("default");
  });

  it("rejects tenant identifiers with invalid characters", async () => {
    const a = app(["header"]);
    const res = await a.request("http://localhost/anywhere", {
      headers: { "x-mockstar-tenant": "bad tenant!" },
    });
    expect(res.status).toBe(400);
  });

  it("path mode strips /t/{tenant} from effective path", async () => {
    const a = app(["path"]);
    const res = await a.request("http://localhost/t/acme/");
    const body = (await res.json()) as { tenant: string; path: string };
    expect(body.tenant).toBe("acme");
    expect(body.path).toBe("/");
  });
});
