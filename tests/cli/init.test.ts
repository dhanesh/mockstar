// Satisfies: RT-13 (5-minute Dev quickstart — init produces runnable mocks)
// Satisfies: RT-14 (init scaffolds starter tree with $schema pinned to minor)

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MocksFile } from "../../src/core/config/schema.ts";
import { minorTagFromVersion, runInit } from "../../src/cli/commands/init.ts";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mockstar-init-"));
}

describe("mockstar init", () => {
  it("minorTagFromVersion handles prereleases and missing parts", () => {
    expect(minorTagFromVersion("0.1.0-rc.1")).toBe("v0.1");
    expect(minorTagFromVersion("1.2.3")).toBe("v1.2");
    expect(minorTagFromVersion("5")).toBe("v5.0");
  });

  it("creates mocks/default/example.json + mockstar.config.json", async () => {
    const dir = await scratch();
    const result = await runInit({ dir, minorTag: "v0.1", force: false });
    expect(result.created.length).toBe(2);
    expect(result.skipped.length).toBe(0);
    expect(existsSync(join(dir, "mocks", "default", "example.json"))).toBe(true);
    expect(existsSync(join(dir, "mockstar.config.json"))).toBe(true);
  });

  it("the generated example.json validates against the MocksFile Zod schema", async () => {
    const dir = await scratch();
    await runInit({ dir, minorTag: "v0.1", force: false });
    const doc = JSON.parse(await readFile(join(dir, "mocks", "default", "example.json"), "utf8")) as unknown;
    // $schema is not a MocksFile field; strip before Zod parse.
    if (doc && typeof doc === "object" && !Array.isArray(doc)) {
      delete (doc as Record<string, unknown>).$schema;
    }
    expect(() => MocksFile.parse(doc)).not.toThrow();
  });

  it("pins $schema to the provided minor", async () => {
    const dir = await scratch();
    await runInit({ dir, minorTag: "v0.3", force: false });
    const doc = JSON.parse(await readFile(join(dir, "mocks", "default", "example.json"), "utf8")) as {
      $schema: string;
    };
    expect(doc.$schema).toBe("https://schemas.mockstar.dev/v0.3/mock.json");
  });

  it("idempotent without --force: skips existing files", async () => {
    const dir = await scratch();
    await runInit({ dir, minorTag: "v0.1", force: false });
    const second = await runInit({ dir, minorTag: "v0.1", force: false });
    expect(second.created).toEqual([]);
    expect(second.skipped.length).toBe(2);
  });

  it("--force overwrites existing files", async () => {
    const dir = await scratch();
    await runInit({ dir, minorTag: "v0.1", force: false });
    const second = await runInit({ dir, minorTag: "v0.2", force: true });
    expect(second.created.length).toBe(2);
    const doc = JSON.parse(await readFile(join(dir, "mocks", "default", "example.json"), "utf8")) as {
      $schema: string;
    };
    expect(doc.$schema).toBe("https://schemas.mockstar.dev/v0.2/mock.json");
  });
});
