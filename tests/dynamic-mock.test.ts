// @constraint RT-1 — registry-backed dynamic handler render path
// @constraint RT-2 — error boundary wraps handler invocation
// Covers renderDynamic: success, helper bundle wiring, missing-handler 500,
// handler-fault isolation, and the non-dynamic guard.

import { describe, expect, it } from "bun:test";
import type { Context } from "hono";
import type { Entry } from "../src/core/config/schema.ts";
import type { HandlerRegistry, MockHandler } from "../src/core/handlers/index.ts";
import { createLogger } from "../src/core/observability/index.ts";
import { createFaker } from "../src/core/templating/faker.ts";
import { type DynamicInput, renderDynamic } from "../src/features/dynamic-mock.ts";

const silentLogger = (): ReturnType<typeof createLogger> => {
  const lines: string[] = [];
  return createLogger({ stdout: (l) => lines.push(l), stderr: (l) => lines.push(l), deterministic: true });
};

function registryOf(handlers: Record<string, MockHandler>): HandlerRegistry {
  const map = new Map(Object.entries(handlers));
  return {
    size: map.size,
    has: (name) => map.has(name),
    get: (name) => map.get(name),
    names: () => [...map.keys()].sort(),
  };
}

function dynamicEntry(handler: string): Entry {
  return {
    id: `entry-${handler}`,
    match: { method: "GET", path: "/x", priority: 0 },
    response: { kind: "dynamic", handler },
  } as Entry;
}

function makeInput(opts: {
  entry: Entry;
  registry: HandlerRegistry;
  tenant?: string;
  requestId?: string;
}): DynamicInput {
  const ctx = {
    var: { requestId: opts.requestId ?? "req-1", tenant: opts.tenant ?? "default" },
  } as unknown as Context;
  return {
    entry: opts.entry,
    ctx,
    registry: opts.registry,
    tenant: opts.tenant ?? "default",
    requestId: opts.requestId ?? "req-1",
    faker: createFaker({ deterministic: true, seed: 7 }),
    boundary: { timeoutMs: 1000, logger: silentLogger() },
  };
}

describe("renderDynamic — success path", () => {
  it("returns the handler's response", async () => {
    const registry = registryOf({
      ok: () =>
        new Response(JSON.stringify({ hi: true }), { headers: { "content-type": "application/json" } }),
    });
    const res = await renderDynamic(makeInput({ entry: dynamicEntry("ok"), registry }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hi: true });
  });

  it("passes tenant and requestId through to the handler helpers", async () => {
    let seen: { tenant: string; requestId: string } | null = null;
    const registry = registryOf({
      reflect: (_ctx, helpers) => {
        seen = { tenant: helpers.tenant, requestId: helpers.requestId };
        return new Response("ok");
      },
    });
    await renderDynamic(
      makeInput({ entry: dynamicEntry("reflect"), registry, tenant: "acme", requestId: "rid-42" }),
    );
    expect(seen as { tenant: string; requestId: string } | null).toEqual({
      tenant: "acme",
      requestId: "rid-42",
    });
  });

  it("awaits async handlers", async () => {
    const registry = registryOf({
      slow: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return new Response("done", { status: 202 });
      },
    });
    const res = await renderDynamic(makeInput({ entry: dynamicEntry("slow"), registry }));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("done");
  });
});

describe("renderDynamic — faker helper bundle", () => {
  it("exposes uuid/email/name/integer/pick backed by the request faker", async () => {
    let helperFaker: Record<string, unknown> | null = null;
    const registry = registryOf({
      gen: (_ctx, helpers) => {
        const f = helpers.faker;
        helperFaker = {
          uuid: f.uuid(),
          email: f.email(),
          name: f.name(),
          integer: f.integer(1, 1),
          pick: f.pick(["only"]),
        };
        return new Response("ok");
      },
    });
    await renderDynamic(makeInput({ entry: dynamicEntry("gen"), registry }));
    const hf = helperFaker as Record<string, unknown> | null;
    expect(typeof hf?.uuid).toBe("string");
    expect(hf?.email as string).toContain("@");
    expect(typeof hf?.name).toBe("string");
    expect(hf?.integer).toBe(1); // min===max===1
    expect(hf?.pick).toBe("only");
  });

  it("produces deterministic output for a seeded faker", async () => {
    const handler: MockHandler = (_ctx, helpers) =>
      new Response(JSON.stringify({ id: helpers.faker.uuid() }), {
        headers: { "content-type": "application/json" },
      });
    const run = async (): Promise<unknown> => {
      const input = makeInput({ entry: dynamicEntry("u"), registry: registryOf({ u: handler }) });
      input.faker = createFaker({ deterministic: true, seed: 123 });
      const res = await renderDynamic(input);
      return res.json();
    };
    expect(await run()).toEqual(await run());
  });
});

describe("renderDynamic — missing handler (defensive RT-1.3)", () => {
  it("returns a 500 handler_missing response without invoking anything", async () => {
    const res = await renderDynamic(makeInput({ entry: dynamicEntry("ghost"), registry: registryOf({}) }));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "handler_missing", handler: "ghost" });
  });

  it("logs a handler_missing_at_runtime event with diagnostic context", async () => {
    const lines: string[] = [];
    const logger = createLogger({
      stdout: (l) => lines.push(l),
      stderr: (l) => lines.push(l),
      deterministic: true,
    });
    const input = makeInput({
      entry: dynamicEntry("ghost"),
      registry: registryOf({}),
      tenant: "t9",
      requestId: "rZ",
    });
    input.boundary = { timeoutMs: 1000, logger };
    await renderDynamic(input);
    const logged = lines.map((l) => JSON.parse(l));
    const evt = logged.find((e) => e.event === "handler_missing_at_runtime");
    expect(evt).toMatchObject({ handler: "ghost", entryId: "entry-ghost", tenant: "t9", requestId: "rZ" });
  });
});

describe("renderDynamic — fault isolation (RT-2)", () => {
  it("converts a throwing handler into a safe 500 handler_fault", async () => {
    const registry = registryOf({
      boom: () => {
        throw new Error("secret internal: token=xyz");
      },
    });
    const res = await renderDynamic(makeInput({ entry: dynamicEntry("boom"), registry }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "handler_fault", handler: "boom" });
    expect(JSON.stringify(body)).not.toContain("token=xyz"); // no leak
  });

  it("converts a rejecting async handler into a 500", async () => {
    const registry = registryOf({
      rej: async () => {
        throw new Error("async boom");
      },
    });
    const res = await renderDynamic(makeInput({ entry: dynamicEntry("rej"), registry }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("handler_fault");
  });

  it("times out a handler that exceeds the boundary budget", async () => {
    const registry = registryOf({
      hang: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return new Response("too late");
      },
    });
    const input = makeInput({ entry: dynamicEntry("hang"), registry });
    input.boundary = { timeoutMs: 20, logger: silentLogger() };
    const res = await renderDynamic(input);
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("timeout");
  });
});

describe("renderDynamic — guard", () => {
  it("throws when called with a non-dynamic entry", async () => {
    const staticEntry = {
      id: "static-1",
      match: { method: "GET", path: "/x", priority: 0 },
      response: { kind: "static", status: 200 },
    } as Entry;
    const input = makeInput({ entry: staticEntry, registry: registryOf({}) });
    await expect(renderDynamic(input)).rejects.toThrow(/non-dynamic entry 'static-1'/);
  });
});
