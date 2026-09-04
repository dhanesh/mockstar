// Satisfies: RT-2 (generated schema carries a correct $id and uses the minor tag)

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { $ } from "bun";

const SCRIPT = resolve(import.meta.dir, "..", "..", "scripts", "generate-schema.ts");
const SCHEMA_PATH = resolve(import.meta.dir, "..", "..", "schema", "mock.json");
const VERSION_PATH = resolve(import.meta.dir, "..", "..", "schema", "VERSION");

// generate-schema.ts has no out-dir option — it always writes schema/mock.json and
// schema/VERSION in place, because that is also how the schema-publish CI workflow invokes
// it (see the script's header comment). Adding an out-dir flag would change a contract another
// workflow depends on just to make this test tidier. Instead, this suite snapshots the tracked
// files before running the script and restores them in afterAll, so every test below still
// exercises the real script (a fresh generation compared against the committed artifact) without
// leaving the tracked schema/mock.json / schema/VERSION mutated on disk once the suite exits.
let originalSchema: string | undefined;
let originalVersion: string | undefined;

beforeAll(async () => {
  if (existsSync(SCHEMA_PATH)) originalSchema = await readFile(SCHEMA_PATH, "utf8");
  if (existsSync(VERSION_PATH)) originalVersion = await readFile(VERSION_PATH, "utf8");
});

afterAll(async () => {
  if (originalSchema !== undefined) await writeFile(SCHEMA_PATH, originalSchema);
  if (originalVersion !== undefined) await writeFile(VERSION_PATH, originalVersion);
});

describe("RT-2: generate-schema produces a minor-tagged artifact", () => {
  it("generate-schema.ts exists and is runnable", async () => {
    expect(existsSync(SCRIPT)).toBe(true);
    const result = await $`bun run ${SCRIPT}`.quiet().nothrow();
    expect(result.exitCode).toBe(0);
  });

  it("writes schema/mock.json with a schemas.mockstar.dev $id pinned to a minor", async () => {
    await $`bun run ${SCRIPT}`.quiet();
    const schema = (await Bun.file(SCHEMA_PATH).json()) as {
      $id: string;
      title: string;
    };
    expect(schema.$id).toMatch(/^https:\/\/schemas\.mockstar\.dev\/v0\.\d+\/mock\.json$/);
    expect(schema.title).toContain("Mockstar mocks file");
  });

  it("a fresh generation matches the committed schema/mock.json byte-for-byte (no drift)", async () => {
    expect(originalSchema).toBeDefined();
    await $`bun run ${SCRIPT}`.quiet();
    const fresh = await readFile(SCHEMA_PATH, "utf8");
    expect(fresh).toBe(originalSchema as string);
  });
});

// Regression guard for a real incident (#30 fix-round-1): `zod-to-json-schema` cannot see
// through the `z.preprocess` wrapper on `WebhookSigning` that injects `mode: "hmac"` when
// absent, so it faithfully serialised the inner HmacSigning member's own required set —
// which listed `mode` as required, even though `mode` is optional at parse time (the
// preprocess step supplies it). That made the *emitted artifact* lie: a schema-aware editor
// pinning `$schema` (which this repo recommends — see CLAUDE.md, and
// `src/cli/commands/init.ts`) would flag every pre-existing signing block without an explicit
// `mode` key as invalid, despite Zod parsing it just fine.
// Fixed by adding `.default("hmac")` to the `mode` literal on the HmacSigning member, which
// zod-to-json-schema drops from `required` and annotates with `"default"` instead. This test
// pins the schema shape that fix protects. It deliberately does NOT also assert that the
// shipped example carries no `mode` key — that pins the example against ever gaining one for
// reasons unrelated to what this test guards; the required/default assertions below are the
// real tripwire.
describe("RT-2 regression: signing.mode must not be required in the emitted JSON Schema", () => {
  it("the hmac signing member's `required` array omits `mode`, and `mode` carries a default", async () => {
    await $`bun run ${SCRIPT}`.quiet();
    const schema = (await Bun.file(SCHEMA_PATH).json()) as {
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
});
