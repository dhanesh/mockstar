// Satisfies: RT-2 (generated schema carries a correct $id and uses the minor tag)

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";

const SCRIPT = resolve(import.meta.dir, "..", "..", "scripts", "generate-schema.ts");

describe("RT-2: generate-schema produces a minor-tagged artifact", () => {
  it("generate-schema.ts exists and is runnable", async () => {
    expect(existsSync(SCRIPT)).toBe(true);
    const result = await $`bun run ${SCRIPT}`.quiet().nothrow();
    expect(result.exitCode).toBe(0);
  });

  it("writes schema/mock.json with a schemas.mockstar.dev $id pinned to a minor", async () => {
    await $`bun run ${SCRIPT}`.quiet();
    const schema = (await Bun.file(resolve(import.meta.dir, "..", "..", "schema", "mock.json")).json()) as {
      $id: string;
      title: string;
    };
    expect(schema.$id).toMatch(/^https:\/\/schemas\.mockstar\.dev\/v0\.\d+\/mock\.json$/);
    expect(schema.title).toContain("Mockstar mocks file");
  });
});

// Regression guard for a real incident (#30 fix-round-1): `zod-to-json-schema` cannot see
// through the `z.preprocess` wrapper on `WebhookSigning` that injects `mode: "hmac"` when
// absent, so it faithfully serialised the inner HmacSigning member's own required set —
// which listed `mode` as required, even though `mode` is optional at parse time (the
// preprocess step supplies it). That made the *emitted artifact* lie: a schema-aware editor
// pinning `$schema` (which this repo recommends — see CLAUDE.md, and
// `src/cli/commands/init.ts`) would flag every pre-existing signing block without an explicit
// `mode` key — including the shipped example — as invalid, despite Zod parsing it just fine.
// Fixed by adding `.default("hmac")` to the `mode` literal on the HmacSigning member, which
// zod-to-json-schema drops from `required` and annotates with `"default"` instead. This test
// pins both the schema shape and the real-world fixture that shape must keep accepting.
describe("RT-2 regression: signing.mode must not be required in the emitted JSON Schema", () => {
  it("the hmac signing member's `required` array omits `mode`, and `mode` carries a default", async () => {
    await $`bun run ${SCRIPT}`.quiet();
    const schema = (await Bun.file(resolve(import.meta.dir, "..", "..", "schema", "mock.json")).json()) as {
      properties: {
        mocks: {
          items: {
            properties: {
              webhooks: {
                items: {
                  properties: {
                    signing: {
                      anyOf: Array<{
                        required?: string[];
                        properties: { mode?: { default?: unknown; const?: unknown } };
                      }>;
                    };
                  };
                };
              };
            };
          };
        };
      };
    };

    const signingNode = schema.properties.mocks.items.properties.webhooks.items.properties.signing.anyOf[0];
    expect(signingNode).toBeDefined();
    expect(signingNode?.required ?? []).not.toContain("mode");
    expect(signingNode?.properties.mode?.default).toBe("hmac");
  });

  it("the shipped example's signing block has no `mode` key — the exact shape the fix protects", async () => {
    const examplePath = resolve(
      import.meta.dir,
      "..",
      "..",
      "examples",
      "mocks",
      "default",
      "webhooks-example.json",
    );
    const example = (await Bun.file(examplePath).json()) as {
      mocks: Array<{ webhooks?: Array<{ signing?: Record<string, unknown> }> }>;
    };

    const signingBlocks = example.mocks
      .flatMap((mock) => mock.webhooks ?? [])
      .map((webhook) => webhook.signing)
      .filter((signing): signing is Record<string, unknown> => signing !== undefined);

    expect(signingBlocks.length).toBeGreaterThan(0);
    for (const signing of signingBlocks) {
      expect(Object.keys(signing)).not.toContain("mode");
    }
  });
});
