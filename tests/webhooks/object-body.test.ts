// #56 — a webhook body written as a JSON object used to be JSON.stringify'd and then compiled
// as ONE template string. Stringify escaped the quotes inside tokens such as
// `{{id("evt_", 14)}}`, so config compile threw. Each string leaf is now compiled on its own;
// output is otherwise unchanged (values still render as strings).

import { describe, expect, it } from "bun:test";
import type { Entry } from "../../src/core/config/schema.ts";
import type { TemplateContext } from "../../src/core/templating/compiler.ts";
import { createFaker } from "../../src/core/templating/faker.ts";
import { createIdHelpers } from "../../src/core/templating/tier2/id.ts";
import { createClock } from "../../src/core/templating/tier2/now.ts";
import { compileWebhookSpecs } from "../../src/features/webhooks/compile.ts";
import { webhookSpec } from "./_helpers.ts";

const ctx = (body: unknown = null): TemplateContext => ({
  faker: createFaker({ deterministic: true, seed: 7 }),
  tenant: "acme",
  requestId: "req-1",
  clock: createClock({ deterministic: true }),
  idHelpers: createIdHelpers({ deterministic: true, tenant: "acme", endpoint: "e", requestCounter: 1 }),
  request: { method: "POST", path: "/orders", query: {}, headers: {}, body, params: {} },
});

function compileBody(body: unknown): { render: (c: TemplateContext) => string } {
  const entries: Entry[] = [
    {
      id: "e",
      match: { method: "POST", path: "/orders", priority: 0 },
      response: { kind: "static", status: 201, body: { ok: true } },
      webhooks: [webhookSpec({ body })],
    },
  ];
  const spec = compileWebhookSpecs(entries).get("e")?.[0];
  if (!spec?.body) throw new Error("no compiled body");
  return spec.body;
}

describe("#56 object webhook bodies", () => {
  it("compiles tokens with quoted args (id, id.named, faker.pick)", () => {
    const body = compileBody({
      evt: '{{id("evt_", 14)}}',
      order: '{{id.named("order", "ord_", 10)}}',
      again: '{{id.named("order", "ord_", 10)}}',
      pick: '{{faker.pick(["a", "b"])}}',
    });
    const out = JSON.parse(body.render(ctx())) as Record<string, string>;
    expect(out.evt).toMatch(/^evt_[A-Za-z0-9]{14}$/);
    expect(out.order).toMatch(/^ord_[A-Za-z0-9]{10}$/);
    expect(out.again).toBe(out.order);
    expect(["a", "b"]).toContain(out.pick ?? "");
  });

  it("renders byte-identically to the old stringify-then-compile path for unquoted tokens", () => {
    const obj = {
      id: "{{faker.uuid}}",
      who: { name: "{{faker.name}}", tenant: "{{tenant}}" },
      at: "{{now.iso}}",
      ref: "order {{request.body.id}} for {{faker.email}}",
      list: ["{{faker.uuid}}", 1, true, null],
      n: 3,
    };
    const asObject = compileBody(obj).render(ctx({ id: "o-1" }));
    const asString = compileBody(JSON.stringify(obj)).render(ctx({ id: "o-1" }));
    expect(asObject).toBe(asString);
  });

  it("keeps values as strings (no type change) and literals as-is", () => {
    const out = JSON.parse(
      compileBody({ n: "{{faker.integer(1, 1)}}", lit: 5, flag: false, none: null }).render(ctx()),
    ) as Record<string, unknown>;
    expect(out).toEqual({ n: "1", lit: 5, flag: false, none: null });
  });

  it("escapes rendered values, so the body stays valid JSON", () => {
    const rendered = compileBody({ name: "{{request.body.name}}" }).render(ctx({ name: 'say "hi"\n' }));
    expect(JSON.parse(rendered)).toEqual({ name: 'say "hi"\n' });
  });

  it("renders templated keys", () => {
    expect(JSON.parse(compileBody({ "{{tenant}}": "x" }).render(ctx()))).toEqual({ acme: "x" });
  });
});
