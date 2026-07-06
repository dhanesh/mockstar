// @constraint U5 — OpenAPI offline converter
// @constraint RT-8.3 — external $ref disabled (addresses CVE-2026-39885)
// @constraint RT-8.4 — URL-encoded path params (addresses CVE-2026-32871)

import { describe, expect, it } from "bun:test";
import { OpenApiImportError, convertOpenApi, encodePathTemplate } from "../src/features/openapi/index.ts";

describe("OpenAPI converter", () => {
  it("converts operations to mock entries using response examples", () => {
    const doc = {
      openapi: "3.1.0",
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/users/{id}": {
          get: {
            operationId: "getUser",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { example: { id: 1, name: "Alice" } },
                },
              },
            },
          },
        },
      },
    };
    const entries = convertOpenApi(doc);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry).toBeDefined();
    expect(entry?.id).toBe("getUser");
    expect((entry?.match as { method: string }).method).toBe("GET");
    expect((entry?.match as { path: string }).path).toBe("/users/:id");
  });

  it("rejects external http:// $ref (CVE-2026-39885 class)", () => {
    const doc = {
      openapi: "3.1.0",
      paths: {
        "/foo": {
          get: {
            responses: {
              "200": {
                $ref: "http://169.254.169.254/metadata", // would SSRF
                description: "leaks",
              },
            },
          },
        },
      },
    };
    expect(() => convertOpenApi(doc)).toThrow(OpenApiImportError);
  });

  it("rejects file:// $ref", () => {
    const doc = {
      paths: {
        "/foo": {
          get: {
            responses: { "200": { $ref: "file:///etc/passwd", description: "local read" } },
          },
        },
      },
    };
    expect(() => convertOpenApi(doc)).toThrow(OpenApiImportError);
  });

  it("accepts in-document (#/...) $ref without fetching anything", () => {
    const doc = {
      paths: {
        "/foo": {
          get: {
            responses: {
              "200": {
                description: "ok",
                $ref: "#/components/responses/Foo",
              },
            },
          },
        },
      },
    };
    expect(() => convertOpenApi(doc)).not.toThrow();
  });

  it("rejects server URLs in private ranges by default", () => {
    const doc = {
      servers: [{ url: "http://10.0.0.1/" }],
      paths: {},
    };
    expect(() => convertOpenApi(doc)).toThrow(OpenApiImportError);
  });
});

describe("encodePathTemplate", () => {
  it("rewrites {name} to :name", () => {
    expect(encodePathTemplate("/users/{userId}/orders/{orderId}")).toBe("/users/:userId/orders/:orderId");
  });

  it("URL-encodes literal segments that contain traversal characters", () => {
    // Defence-in-depth: `encodeURIComponent` escapes the `%` of any existing percent-encoded
    // sequence, so smuggled `%2f` becomes `%252f` — a slash cannot sneak through the path.
    // Note: `encodeURIComponent` intentionally does not encode `.` (RFC 3986 unreserved),
    // so `..` remains literal. Path traversal is still prevented because the `/` it would
    // need to escape the segment is double-encoded.
    const encoded = encodePathTemplate("/users/..%2fadmin");
    expect(encoded).toContain("%252f"); // percent is escaped
    expect(encoded).not.toMatch(/%2f[^0-9a-fA-F%]/); // no raw %2f slash
  });

  it("sanitises param names to [a-zA-Z0-9_]", () => {
    expect(encodePathTemplate("/things/{id-with-dash}")).toBe("/things/:id_with_dash");
  });

  it("collapses a segment with an embedded param + literal suffix to a whole-segment :param", () => {
    // mockstar's path-trie only treats a WHOLE segment as a param; it has no partial-segment
    // params. `{api}.json` must become `:api` (capturing e.g. `2.0.json`) — NOT the URL-encoded
    // `%7Bapi%7D.json`, which matches no real request.
    expect(encodePathTemplate("/specs/{provider}/{api}.json")).toBe("/specs/:provider/:api");
    expect(encodePathTemplate("/{provider}.json")).toBe("/:provider");
  });

  it("collapses a segment with multiple embedded params to one :param", () => {
    // Only one param per trie slot; use the first param name (cosmetic).
    expect(encodePathTemplate("/v{major}-{minor}/x")).toBe("/:major/x");
  });
});
