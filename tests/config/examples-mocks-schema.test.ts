// Validates: RT-8 (webhooks-example.json is the canonical back-compat artifact for #30),
// T7 (Zod-validated config with fail-fast boot)
//
// Review round 2, item 7: examples/mocks/default/webhooks-example.json is the canonical
// back-compat artifact for the whole #30 signing-schemes PR, and the only test that touched it
// was dropped in d816b4d. This parses EVERY mock config file under examples/mocks/ (every
// tenant, not just default/) with the real MocksFile schema, so a shape regression here fails
// loudly instead of only surfacing when someone happens to run `mockstar serve ./examples/mocks`.
//
// Loader-parity check (per the task instructions): none of these files currently carry a
// top-level `$schema` key (checked directly — grep found none), so MocksFile's `.strict()`
// object shape ({ mocks: [...] }, no extra keys) validates every file as-is. No workaround
// mirroring loader.ts's more lenient per-entry parsing was needed.

import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { MocksFile } from "../../src/core/config/schema.ts";

const MOCKS_ROOT = resolve(import.meta.dir, "..", "..", "examples", "mocks");

function findMockFiles(): string[] {
  const files: string[] = [];
  for (const tenant of readdirSync(MOCKS_ROOT)) {
    const tenantDir = join(MOCKS_ROOT, tenant);
    if (!statSync(tenantDir).isDirectory()) continue;
    for (const name of readdirSync(tenantDir)) {
      // tenant.json is a TenantConfig, not a MocksFile — loader.ts excludes it the same way.
      if (!name.endsWith(".json") || name === "tenant.json") continue;
      files.push(join(tenantDir, name));
    }
  }
  return files;
}

describe("examples/mocks/** validates against the real MocksFile schema", () => {
  const files = findMockFiles();

  test("at least one mock config file was found (sanity — a bad glob would pass vacuously)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of findMockFiles()) {
    const relative = file.slice(MOCKS_ROOT.length + 1);
    test(`${relative} parses under MocksFile`, async () => {
      const raw = JSON.parse(await Bun.file(file).text());
      expect(() => MocksFile.parse(raw)).not.toThrow();
    });
  }

  test("webhooks-example.json specifically parses and has a signing block (#30 canonical artifact)", async () => {
    const file = join(MOCKS_ROOT, "default", "webhooks-example.json");
    const raw = JSON.parse(await Bun.file(file).text());
    const parsed = MocksFile.parse(raw);
    const withSigning = parsed.mocks.find((m) => m.webhooks?.some((w) => w.signing));
    expect(withSigning).toBeDefined();
  });
});
