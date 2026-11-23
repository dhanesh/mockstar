// @constraint RT-12.2 / TN8 — deterministic faker is scoped per request, not shared per server
//
// Before #52 one seeded faker instance served every request, tenant and webhook, so a
// request's values depended on how many faker calls every EARLIER request made. Changing an
// unrelated mock's template (or sending a different earlier request) shifted every later
// fixture. Now each request draws from its own stream seeded by (seed, tenant, entry, requestId).

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakerFactory } from "../src/core/templating/faker.ts";
import { type Launched, launch } from "../src/index.ts";

const fakerBody = (n: number): Record<string, string> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, "{{faker.uuid}}"]));

async function setup(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "faker-per-req-"));
  await mkdir(join(root, "mocks", "acme"), { recursive: true });
  await mkdir(join(root, "handlers"), { recursive: true });
  const entry = (id: string, path: string, body: unknown): unknown => ({
    id,
    match: { method: "GET", path },
    response: { kind: "static", status: 200, headers: { "content-type": "application/json" }, body },
  });
  await writeFile(
    join(root, "mocks", "acme", "mocks.json"),
    JSON.stringify({
      mocks: [
        entry("light", "/light", fakerBody(1)),
        entry("heavy", "/heavy", fakerBody(25)),
        entry("user", "/user", {
          name: "{{faker.name}}",
          email: "{{faker.email}}",
          n: "{{faker.integer(1, 1000000)}}",
        }),
      ],
    }),
  );
  return root;
}

async function boot(root: string): Promise<Launched> {
  return launch({
    configRoot: join(root, "mocks"),
    handlersDir: join(root, "handlers"),
    deterministic: true,
    watch: false,
    installCrashHandlers: false,
    server: { tenancyModes: ["header"] },
  });
}

async function get(l: Launched, path: string): Promise<unknown> {
  const r = await l.server.hono.request(`http://localhost${path}`, {
    headers: { "x-mockstar-tenant": "acme" },
  });
  expect(r.status).toBe(200);
  return r.json();
}

describe("deterministic faker is per request", () => {
  let a: Launched | null = null;
  let b: Launched | null = null;
  afterEach(async () => {
    await a?.stop();
    await b?.stop();
    a = null;
    b = null;
  });

  it("a request's values do not depend on how many faker calls earlier requests made", async () => {
    const root = await setup();
    a = await boot(root);
    b = await boot(root);
    // Same position (request #2) for /user on both servers; the request before it makes 1 vs 25
    // faker calls. With a shared stream the /user values differed; per-request they must match.
    await get(a, "/light");
    await get(b, "/heavy");
    expect(await get(a, "/user")).toEqual(await get(b, "/user"));
  });

  it("different requests to the same entry still get different values", async () => {
    const root = await setup();
    a = await boot(root);
    const first = await get(a, "/user");
    const second = await get(a, "/user");
    expect(first).not.toEqual(second);
  });
});

describe("createFakerFactory", () => {
  const scope = { tenant: "acme", endpoint: "user", requestId: "req-00000001" };

  it("deterministic: same scope → same sequence; any scope field changes it", () => {
    const f = createFakerFactory({ deterministic: true });
    const seq = (s: typeof scope): string[] => {
      const x = f(s);
      return [x.uuid(), x.name()];
    };
    expect(seq(scope)).toEqual(seq(scope));
    expect(seq({ ...scope, tenant: "beta" })).not.toEqual(seq(scope));
    expect(seq({ ...scope, endpoint: "user#webhooks" })).not.toEqual(seq(scope));
    expect(seq({ ...scope, requestId: "req-00000002" })).not.toEqual(seq(scope));
  });

  it("deterministic: base seed participates", () => {
    const a = createFakerFactory({ deterministic: true, seed: 1 })(scope).uuid();
    const b = createFakerFactory({ deterministic: true, seed: 2 })(scope).uuid();
    expect(a).not.toBe(b);
  });

  it("non-deterministic: one shared instance (no per-request allocation)", () => {
    const f = createFakerFactory({ deterministic: false });
    expect(f(scope)).toBe(f({ ...scope, requestId: "req-2" }));
  });
});
