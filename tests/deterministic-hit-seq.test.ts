// #53 — deterministic seeds come from a per-(tenant, mock entry) hit counter, not the global
// request id. Before, `req-0000000N` (one counter shared by every tenant) seeded faker and
// `{{id()}}`, so tenant B's traffic — or any other mock's — shifted tenant A's fixtures.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Launched, launch } from "../src/index.ts";

const BODY = { id: '{{id("usr_", 14)}}', uuid: "{{faker.uuid}}", name: "{{faker.name}}" };

async function setup(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hit-seq-"));
  await mkdir(join(root, "handlers"), { recursive: true });
  const entry = (id: string, path: string): unknown => ({
    id,
    match: { method: "GET", path },
    response: { kind: "static", status: 200, headers: { "content-type": "application/json" }, body: BODY },
  });
  for (const tenant of ["acme", "beta"]) {
    await mkdir(join(root, "mocks", tenant), { recursive: true });
    await writeFile(
      join(root, "mocks", tenant, "mocks.json"),
      JSON.stringify({ mocks: [entry("user", "/user"), entry("other", "/other")] }),
    );
  }
  return root;
}

const boot = (root: string): Promise<Launched> =>
  launch({
    configRoot: join(root, "mocks"),
    handlersDir: join(root, "handlers"),
    deterministic: true,
    watch: false,
    installCrashHandlers: false,
    server: { tenancyModes: ["header"] },
  });

async function get(l: Launched, tenant: string, path: string): Promise<unknown> {
  const r = await l.server.hono.request(`http://localhost${path}`, {
    headers: { "x-mockstar-tenant": tenant },
  });
  expect(r.status).toBe(200);
  return r.json();
}

describe("#53 deterministic seeds are per (tenant, mock entry)", () => {
  let a: Launched | null = null;
  let b: Launched | null = null;
  afterEach(async () => {
    await a?.stop();
    await b?.stop();
    a = b = null;
  });

  it("other tenants' traffic does not change a tenant's sequence", async () => {
    const root = await setup();
    a = await boot(root);
    b = await boot(root);
    const seqA: unknown[] = [];
    const seqB: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      seqA.push(await get(a, "acme", "/user"));
      await get(a, "beta", "/user"); // interleaved traffic on server A only
      await get(a, "beta", "/other");
    }
    for (let i = 0; i < 3; i++) seqB.push(await get(b, "acme", "/user"));
    expect(seqA).toEqual(seqB);
  });

  it("other mocks of the same tenant do not change an entry's sequence", async () => {
    const root = await setup();
    a = await boot(root);
    b = await boot(root);
    await get(a, "acme", "/other");
    await get(a, "acme", "/other");
    expect(await get(a, "acme", "/user")).toEqual(await get(b, "acme", "/user"));
  });

  it("repeat hits on one entry still get different values", async () => {
    const root = await setup();
    a = await boot(root);
    const first = await get(a, "acme", "/user");
    const second = await get(a, "acme", "/user");
    expect(first).not.toEqual(second);
  });

  it("the public request id stays the global arrival counter", async () => {
    const root = await setup();
    a = await boot(root);
    await get(a, "beta", "/user");
    await get(a, "acme", "/user");
    const ids = a.server.journal.snapshot("acme").map((e) => e.requestId);
    expect(ids).toEqual(["req-00000002"]);
  });
});
