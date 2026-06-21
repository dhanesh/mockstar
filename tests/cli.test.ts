// @constraint U3 — readable CLI output
// @constraint U5 — `mockstar import` subcommand
// @constraint G12 — CLI test coverage

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

async function runCli(
  args: readonly string[],
  timeoutMs = 5000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // biome-ignore lint/suspicious/noExplicitAny: Bun global
  const bun = (globalThis as any).Bun;
  const proc = bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeoutTimer = setTimeout(() => proc.kill(), timeoutMs);
  (timeoutTimer as { unref?: () => void }).unref?.();
  const [stdoutText, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timeoutTimer);
  return { code, stdout: stdoutText, stderr: stderrText };
}

describe("mockstar CLI (U3)", () => {
  it("--version prints a semver-like string", async () => {
    const r = await runCli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/mockstar \d+\.\d+\.\d+/);
  });

  it("--help includes each command", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("serve");
    expect(r.stdout).toContain("import");
    expect(r.stdout).toContain("--handlers");
    expect(r.stdout).toContain("MOCKSTAR_ADMIN_TOKEN");
  });

  it("import subcommand converts an OpenAPI spec to mocks.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "mockstar-cli-import-"));
    const specPath = join(root, "spec.json");
    await writeFile(
      specPath,
      JSON.stringify({
        openapi: "3.1.0",
        servers: [{ url: "https://api.example.com" }],
        paths: {
          "/ping": {
            get: {
              operationId: "ping",
              responses: {
                "200": {
                  description: "ok",
                  content: { "application/json": { example: { message: "pong" } } },
                },
              },
            },
          },
        },
      }),
    );
    const outDir = join(root, "out");
    await mkdir(outDir, { recursive: true });
    const r = await runCli(["import", specPath, outDir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Imported 1 mocks/);
    const generated = await readFile(join(outDir, "default", "openapi.json"), "utf8");
    const parsed = JSON.parse(generated) as { mocks: Array<{ id: string }> };
    expect(parsed.mocks).toHaveLength(1);
    expect(parsed.mocks[0]?.id).toBe("ping");
  });
});
