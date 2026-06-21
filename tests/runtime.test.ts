// @constraint T1 — Bun runtime + Hono HTTP framework
// @constraint G7 — runtime smoke

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";

describe("runtime stack (T1)", () => {
  it("is running on Bun", () => {
    const bun = (globalThis as { Bun?: { version: string } }).Bun;
    expect(bun?.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("Hono is available and constructable", () => {
    const app = new Hono();
    expect(app).toBeDefined();
    expect(typeof app.fetch).toBe("function");
  });

  it("Hono serves a minimal route in-memory", async () => {
    const app = new Hono();
    app.get("/ping", (ctx) => ctx.text("pong"));
    const res = await app.request("http://localhost/ping");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pong");
  });
});
