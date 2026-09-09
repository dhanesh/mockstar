// Regression coverage for scripts/import-postman.ts (issue #42).
//
// Postman v2.1 collections split a request's URL into `url.host` and
// `url.path`. A {{baseUrl}}-style variable is parsed into `url.host`
// (e.g. host: ["{{baseUrl}}"]) — it never lands in `url.path`. So any
// whole-segment {{name}} that reaches `url.path` is a genuine path
// variable, and must convert to mockstar's `:name` form, the same as the
// `{name}` form already does.

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convert } from "../scripts/import-postman.ts";

interface Mock {
  id: string;
  match: { method: string; path: string; priority?: number };
  response: unknown;
}

async function runImport(items: unknown[]): Promise<{ mocksByFolder: Record<string, Mock[]> }> {
  const root = await mkdtemp(join(tmpdir(), "mockstar-import-postman-"));
  const collectionPath = join(root, "collection.json");
  const outDir = join(root, "out");
  await mkdir(outDir, { recursive: true });
  await writeFile(
    collectionPath,
    JSON.stringify({
      info: { name: "Test collection" },
      item: items,
    }),
  );

  const summary = await convert(collectionPath, outDir, "default");

  const mocksByFolder: Record<string, Mock[]> = {};
  for (const file of summary.filesWritten) {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { mocks: Mock[] };
    const folder = file.split("/").pop() ?? file;
    mocksByFolder[folder] = parsed.mocks;
  }
  return { mocksByFolder };
}

function exampleResponse(): unknown[] {
  return [
    {
      code: 200,
      header: [{ key: "Content-Type", value: "application/json" }],
      body: JSON.stringify({ ok: true }),
    },
  ];
}

function request(method: string, host: string[], path: (string | { value: string })[]): unknown {
  return {
    method,
    url: {
      raw: `${host.join(".")}/${path.map((p) => (typeof p === "string" ? p : p.value)).join("/")}`,
      host,
      path,
    },
  };
}

describe("import-postman: path variable conversion", () => {
  it("converts {{baseUrl}}/users/{{userId}}/orders/{{orderId}} to /users/:userId/orders/:orderId", async () => {
    const { mocksByFolder } = await runImport([
      {
        name: "Orders",
        item: [
          {
            name: "Get order",
            request: request("GET", ["{{baseUrl}}"], ["users", "{{userId}}", "orders", "{{orderId}}"]),
            response: exampleResponse(),
          },
        ],
      },
    ]);

    const mocks = mocksByFolder["orders.json"];
    expect(mocks).toBeDefined();
    expect(mocks).toHaveLength(1);
    expect(mocks?.[0]?.match.path).toBe("/users/:userId/orders/:orderId");
  });

  it("still converts the {id} curly-brace form to :id", async () => {
    const { mocksByFolder } = await runImport([
      {
        name: "Users",
        item: [
          {
            name: "Get user",
            request: request("GET", ["api", "example", "com"], ["users", "{id}"]),
            response: exampleResponse(),
          },
        ],
      },
    ]);

    expect(mocksByFolder["users.json"]?.[0]?.match.path).toBe("/users/:id");
  });

  it("leaves an already-colon-prefixed segment (:id) untouched", async () => {
    const { mocksByFolder } = await runImport([
      {
        name: "Users",
        item: [
          {
            name: "Get user",
            request: request("GET", ["api", "example", "com"], ["users", ":id"]),
            response: exampleResponse(),
          },
        ],
      },
    ]);

    expect(mocksByFolder["users.json"]?.[0]?.match.path).toBe("/users/:id");
  });

  it("sanitises non-alphanumeric characters in a {{var}} segment name, same as {var}", async () => {
    const { mocksByFolder } = await runImport([
      {
        name: "Users",
        item: [
          {
            name: "Get user by user-id",
            request: request("GET", ["{{baseUrl}}"], ["users", "{{user-id}}"]),
            response: exampleResponse(),
          },
          {
            name: "Get user by legacy id",
            request: request("GET", ["{{baseUrl}}"], ["legacy", "{user-id}"]),
            response: exampleResponse(),
          },
        ],
      },
    ]);

    const mocks = mocksByFolder["users.json"] ?? [];
    const doubleCurly = mocks.find((m) => m.match.path.startsWith("/users"));
    const singleCurly = mocks.find((m) => m.match.path.startsWith("/legacy"));
    expect(doubleCurly?.match.path).toBe("/users/:user_id");
    expect(singleCurly?.match.path).toBe("/legacy/:user_id");
  });

  it("still yields / for a path with no resolvable segments", async () => {
    const { mocksByFolder } = await runImport([
      {
        name: "Root",
        item: [
          {
            name: "Root request",
            request: request("GET", ["{{baseUrl}}"], [""]),
            response: exampleResponse(),
          },
        ],
      },
    ]);

    expect(mocksByFolder["root.json"]?.[0]?.match.path).toBe("/");
  });
});
