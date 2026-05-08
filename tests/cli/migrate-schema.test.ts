// Satisfies: RT-2 (dual-URL JSON Schema hosting — migrate CLI contract)

import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrateSchema } from "../../src/cli/commands/migrate.ts";

const SCHEMA_HOST = "https://schemas.mockstar.dev";

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mockstar-migrate-"));
}

describe("mockstar migrate --schema", () => {
  it("rewrites matching $schema URLs from --from to --to", async () => {
    const dir = await scratchDir();
    const file = join(dir, "mocks.json");
    await writeFile(
      file,
      JSON.stringify({ $schema: `${SCHEMA_HOST}/v0.1/mock.json`, entries: [] }, null, 2) + "\n",
    );

    const result = await runMigrateSchema({ dir, from: "v0.1", to: "v0.2", dryRun: false });
    expect(result.filesScanned).toBe(1);
    expect(result.filesChanged).toBe(1);
    expect(result.mismatched).toEqual([]);

    const after = JSON.parse(await readFile(file, "utf8")) as { $schema: string };
    expect(after.$schema).toBe(`${SCHEMA_HOST}/v0.2/mock.json`);
  });

  it("never touches $schema fields for unrelated hosts (e.g. OpenAPI)", async () => {
    const dir = await scratchDir();
    const openapi = join(dir, "openapi.json");
    await writeFile(openapi, JSON.stringify({ $schema: "https://spec.openapis.org/oas/3.1/schema.json" }));

    const result = await runMigrateSchema({ dir, from: "v0.1", to: "v0.2", dryRun: false });
    expect(result.filesChanged).toBe(0);
    expect(result.mismatched).toEqual([]);
    const after = JSON.parse(await readFile(openapi, "utf8")) as { $schema: string };
    expect(after.$schema).toBe("https://spec.openapis.org/oas/3.1/schema.json");
  });

  it("reports mismatched files without rewriting them (safety net for unexpected minors)", async () => {
    const dir = await scratchDir();
    const file = join(dir, "mocks.json");
    await writeFile(file, JSON.stringify({ $schema: `${SCHEMA_HOST}/v0.5/mock.json`, entries: [] }, null, 2));

    const result = await runMigrateSchema({ dir, from: "v0.1", to: "v0.2", dryRun: false });
    expect(result.filesChanged).toBe(0);
    expect(result.mismatched.length).toBe(1);
    const after = JSON.parse(await readFile(file, "utf8")) as { $schema: string };
    expect(after.$schema).toBe(`${SCHEMA_HOST}/v0.5/mock.json`);
  });

  it("is idempotent — files already at --to are counted but not rewritten", async () => {
    const dir = await scratchDir();
    const file = join(dir, "mocks.json");
    await writeFile(file, JSON.stringify({ $schema: `${SCHEMA_HOST}/v0.2/mock.json`, entries: [] }, null, 2));

    const result = await runMigrateSchema({ dir, from: "v0.1", to: "v0.2", dryRun: false });
    expect(result.filesScanned).toBe(1);
    expect(result.filesChanged).toBe(0);
    expect(result.mismatched).toEqual([]);
  });

  it("dry-run does not write the file", async () => {
    const dir = await scratchDir();
    const file = join(dir, "mocks.json");
    const original = JSON.stringify({ $schema: `${SCHEMA_HOST}/v0.1/mock.json`, entries: [] }, null, 2);
    await writeFile(file, original);

    const result = await runMigrateSchema({ dir, from: "v0.1", to: "v0.2", dryRun: true });
    expect(result.filesChanged).toBe(1);
    const after = await readFile(file, "utf8");
    expect(after).toBe(original);
  });
});
