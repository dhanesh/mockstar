// #60 — `--help` / `-h` after a subcommand used to fall through to the subcommand:
// `serve --help` started a server, `init --help` scaffolded files into the current directory.

import { describe, expect, it } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "../../src/cli/args.ts";

const CLI = resolve(import.meta.dir, "../../src/cli.ts");

describe("#60 --help after a subcommand", () => {
  for (const argv of [
    ["serve", "--help"],
    ["serve", "./mocks", "-h"],
    ["./mocks", "--port", "4000", "--help"],
    ["init", "--help"],
    ["import", "spec.yaml", "--help"],
    ["enhance", "-h"],
    ["migrate", "--schema", "--help"],
  ]) {
    it(`${argv.join(" ")} → help`, () => {
      expect(parseArgs(argv, {}).command).toBe("help");
    });
  }

  it("proxy keeps its own help", () => {
    expect(parseArgs(["proxy", "--help"], {})).toEqual({ command: "proxy", proxyArgs: ["--help"] });
  });

  it("subprocess: serve --help and init --help print usage, exit 0, start nothing, write nothing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mockstar-help-"));
    for (const argv of [
      ["serve", "--help"],
      ["init", "--help"],
    ]) {
      const proc = Bun.spawn(["bun", CLI, ...argv], { cwd, stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => proc.kill(), 5000); // a started server would never exit
      try {
        const code = await proc.exited;
        const out = await new Response(proc.stdout).text();
        expect(code).toBe(0);
        expect(out).toContain("Commands:");
        expect(out).not.toContain("listening on");
      } finally {
        clearTimeout(timer);
        proc.kill();
      }
    }
    expect(await readdir(cwd)).toEqual([]);
  }, 20_000);
});
