// @constraint T5 — handlers from configured dir only
// @constraint T6 — handler-reference integrity at boot
// @constraint RT-1 — registry exists and is cross-verified

import { describe, it, expect, beforeAll } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildHandlerRegistry,
  MissingHandlerError,
  verifyHandlerReferences,
} from "../src/core/handlers/index.ts";

async function makeHandlersDir(contents: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mockstar-test-"));
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(contents)) {
    await writeFile(join(dir, name), body, "utf8");
  }
  return dir;
}

describe("handler registry (RT-1)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await makeHandlersDir({
      "echo.ts":
        'export async function echo() { return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }); }\n',
      "greet.ts": 'export async function greet() { return new Response("hi", { status: 200 }); }\n',
    });
  });

  it("discovers named exports from .ts files", async () => {
    const reg = await buildHandlerRegistry(dir);
    expect(reg.has("echo")).toBe(true);
    expect(reg.has("greet")).toBe(true);
    expect(reg.names()).toEqual(["echo", "greet"]);
  });

  it("returns an empty registry when directory is missing", async () => {
    const reg = await buildHandlerRegistry(join(tmpdir(), "does-not-exist-" + Math.random()));
    expect(reg.size).toBe(0);
  });

  it("throws MissingHandlerError for unresolved references (boot failure)", async () => {
    const reg = await buildHandlerRegistry(dir);
    expect(() =>
      verifyHandlerReferences(reg, [
        { name: "echo", configPath: "mocks/default/a.json#e1" },
        { name: "nonexistent", configPath: "mocks/default/a.json#e2" },
      ]),
    ).toThrow(MissingHandlerError);
  });

  it("names() is sorted and deterministic", async () => {
    const reg = await buildHandlerRegistry(dir);
    const a = reg.names();
    const b = reg.names();
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([...a]);
  });
});
