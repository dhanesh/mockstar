// @constraint RT-6 — spec parser shared by importer + enhancer
// Covers loadSpec format detection (openapi/postman/unknown), field-name harvesting,
// provider-tag slugging, depth guard, and the YAML-not-supported error.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpec } from "../src/features/spec/index.ts";

const dir = await mkdtemp(join(tmpdir(), "mockstar-spec-"));
const tmpFiles: string[] = [];

async function writeJson(name: string, value: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(value), "utf8");
  tmpFiles.push(path);
  return path;
}

async function writeRaw(name: string, text: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, text, "utf8");
  tmpFiles.push(path);
  return path;
}

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadSpec — OpenAPI", () => {
  it("detects openapi 3.x and indexes properties by METHOD path", async () => {
    const path = await writeJson("petstore.json", {
      openapi: "3.0.0",
      info: { title: "Pet Store API" },
      paths: {
        "/pets": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { properties: { name: {}, tag: {} } },
                },
              },
            },
          },
        },
      },
    });
    const spec = await loadSpec(path);
    expect(spec.format).toBe("openapi");
    expect(spec.providerTag).toBe("pet-store-api");
    const fields = spec.fieldsByEndpoint.get("POST /pets");
    expect(fields).toBeDefined();
    expect([...(fields ?? [])].sort()).toEqual(["name", "tag"]);
  });

  it("recognises legacy swagger 2.0 documents", async () => {
    const path = await writeJson("swagger.json", {
      swagger: "2.0",
      info: { title: "Legacy" },
      paths: {
        "/x": { get: { responses: { 200: { schema: { properties: { ok: {} } } } } } },
      },
    });
    const spec = await loadSpec(path);
    expect(spec.format).toBe("openapi");
    expect(spec.fieldsByEndpoint.get("GET /x")).toEqual(new Set(["ok"]));
  });

  it("omits endpoints that contribute zero field names", async () => {
    const path = await writeJson("empty-fields.json", {
      openapi: "3.0.0",
      info: { title: "T" },
      paths: { "/ping": { get: { summary: "no properties here" } } },
    });
    const spec = await loadSpec(path);
    expect(spec.fieldsByEndpoint.has("GET /ping")).toBe(false);
    expect(spec.fieldsByEndpoint.size).toBe(0);
  });

  it("collects property names from deeply nested schemas (within depth guard)", async () => {
    const path = await writeJson("nested.json", {
      openapi: "3.0.0",
      info: { title: "Nested" },
      paths: {
        "/a": {
          put: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    properties: {
                      outer: { type: "object", properties: { inner: {} } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const spec = await loadSpec(path);
    const fields = spec.fieldsByEndpoint.get("PUT /a");
    expect(fields?.has("outer")).toBe(true);
    expect(fields?.has("inner")).toBe(true);
  });

  it("skips non-object operation entries without throwing", async () => {
    const path = await writeJson("weird-paths.json", {
      openapi: "3.0.0",
      info: { title: "Weird" },
      paths: {
        "/ok": { post: { requestBody: { content: { x: { schema: { properties: { a: {} } } } } } } },
        "/bad": "not-an-object",
        "/null": null,
      },
    });
    const spec = await loadSpec(path);
    expect(spec.fieldsByEndpoint.get("POST /ok")).toEqual(new Set(["a"]));
    expect(spec.fieldsByEndpoint.has("GET /bad")).toBe(false);
  });

  it("upper-cases the HTTP method in the index key", async () => {
    const path = await writeJson("method-case.json", {
      openapi: "3.0.0",
      info: { title: "M" },
      paths: { "/r": { delete: { requestBody: { content: { x: { schema: { properties: { z: {} } } } } } } } },
    });
    const spec = await loadSpec(path);
    expect([...spec.fieldsByEndpoint.keys()]).toEqual(["DELETE /r"]);
  });
});

describe("loadSpec — provider tag slugging", () => {
  it("slugifies info.title (lowercase, hyphenated, trimmed)", async () => {
    const path = await writeJson("tagged.json", {
      openapi: "3.0.0",
      info: { title: "  Acme Payments v2!! " },
      paths: {},
    });
    const spec = await loadSpec(path);
    expect(spec.providerTag).toBe("acme-payments-v2");
  });

  it("returns null when title is missing or empty after slugging", async () => {
    const noTitle = await loadSpec(
      await writeJson("no-title.json", { openapi: "3.0.0", info: {}, paths: {} }),
    );
    expect(noTitle.providerTag).toBeNull();

    const symbolTitle = await loadSpec(
      await writeJson("symbol-title.json", { openapi: "3.0.0", info: { title: "!!!" }, paths: {} }),
    );
    expect(symbolTitle.providerTag).toBeNull();
  });
});

describe("loadSpec — Postman", () => {
  it("detects postman collections (info + item) with a provider tag", async () => {
    const path = await writeJson("collection.json", {
      info: { name: "My Collection", title: "My Collection" },
      item: [{ name: "Get users", request: { method: "GET" } }],
    });
    const spec = await loadSpec(path);
    expect(spec.format).toBe("postman");
    // detectProviderTag reads info.title; postman collections use info.name, so tag is from title here.
    expect(spec.providerTag).toBe("my-collection");
    // Surface-level postman index is intentionally empty (documented starting point).
    expect(spec.fieldsByEndpoint.size).toBe(0);
  });
});

describe("loadSpec — unknown / fallback", () => {
  it("returns format 'unknown' for unrecognised JSON, exposing raw", async () => {
    const path = await writeJson("mystery.json", { hello: "world" });
    const spec = await loadSpec(path);
    expect(spec.format).toBe("unknown");
    expect(spec.providerTag).toBeNull();
    expect(spec.fieldsByEndpoint.size).toBe(0);
    expect(spec.raw).toEqual({ hello: "world" });
  });

  it("openapi marker without paths falls through to unknown", async () => {
    const path = await writeJson("no-paths.json", { openapi: "3.0.0", info: { title: "X" } });
    const spec = await loadSpec(path);
    expect(spec.format).toBe("unknown");
  });
});

describe("loadSpec — non-JSON extension", () => {
  it("throws a clear 'YAML not yet supported' error for .yaml files", async () => {
    const path = await writeRaw("spec.yaml", "openapi: 3.0.0\npaths: {}\n");
    await expect(loadSpec(path)).rejects.toThrow(/YAML spec parsing not yet supported/);
  });
});
