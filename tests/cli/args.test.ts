// #60 — `--help` / `-h` after a subcommand used to fall through to the subcommand:
// `serve --help` started a server, `init --help` scaffolded files into the current directory.
// #63 — the CLI had no way to set tenancy modes; `--tenancy-modes` / MOCKSTAR_TENANCY_MODES.

import { afterEach, describe, expect, it } from "bun:test";
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
      ["init", "--help"],
      ["serve", "--help"],
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

describe("#63 tenancy modes from the CLI", () => {
  it("defaults to undefined (server default applies)", () => {
    expect(parseArgs(["serve"], {}).tenancyModes).toBeUndefined();
  });

  it("--tenancy-modes=a,b and --tenancy-modes a,b", () => {
    expect(parseArgs(["serve", "--tenancy-modes=subdomain,header"], {}).tenancyModes).toEqual([
      "subdomain",
      "header",
    ]);
    expect(parseArgs(["./mocks", "--tenancy-modes", "path"], {}).tenancyModes).toEqual(["path"]);
  });

  it("MOCKSTAR_TENANCY_MODES, with the flag winning", () => {
    expect(parseArgs(["serve"], { MOCKSTAR_TENANCY_MODES: "header, subdomain" }).tenancyModes).toEqual([
      "header",
      "subdomain",
    ]);
    expect(
      parseArgs(["serve", "--tenancy-modes=path"], { MOCKSTAR_TENANCY_MODES: "subdomain" }).tenancyModes,
    ).toEqual(["path"]);
  });

  it("an unknown or empty mode is a usage error", () => {
    expect(parseArgs(["serve", "--tenancy-modes=path,domain"], {}).error).toContain("domain");
    expect(parseArgs(["serve", "--tenancy-modes="], {}).error).toBeDefined();
    expect(parseArgs(["serve"], { MOCKSTAR_TENANCY_MODES: "nope" }).error).toContain("nope");
  });
});

let procs: Array<ReturnType<typeof Bun.spawn>> = [];
afterEach(() => {
  for (const p of procs) p.kill();
  procs = [];
});

describe("#63 end to end", () => {
  it("serve --tenancy-modes=subdomain routes by the Host header's first label", async () => {
    const root = await mkdtemp(join(tmpdir(), "mockstar-tenancy-"));
    const { mkdir, writeFile } = await import("node:fs/promises");
    for (const t of ["acme", "default"]) {
      await mkdir(join(root, "mocks", t), { recursive: true });
      await writeFile(
        join(root, "mocks", t, "m.json"),
        JSON.stringify({
          mocks: [
            {
              id: "who",
              match: { method: "GET", path: "/who" },
              response: { kind: "static", status: 200, body: { tenant: t } },
            },
          ],
        }),
      );
    }
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port;
    probe.stop(true);

    const proc = Bun.spawn(
      [
        "bun",
        CLI,
        "serve",
        join(root, "mocks"),
        "--port",
        String(port),
        "--no-watch",
        "--tenancy-modes=subdomain",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    procs.push(proc);
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 150; i++) {
      try {
        if ((await fetch(`${base}/health`)).ok) break;
      } catch {}
      await Bun.sleep(100);
    }
    const viaSub = await fetch(`${base}/who`, { headers: { host: `acme.localhost:${port}` } });
    expect(await viaSub.json()).toEqual({ tenant: "acme" });
    // header mode is off now, so the header is ignored
    const viaHeader = await fetch(`${base}/who`, { headers: { "x-mockstar-tenant": "acme" } });
    expect(await viaHeader.json()).toEqual({ tenant: "default" });
  }, 20_000);

  it("an invalid mode exits 2 before starting", async () => {
    const proc = Bun.spawn(["bun", CLI, "serve", "--tenancy-modes=bogus"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    procs.push(proc);
    const timer = setTimeout(() => proc.kill(), 5000);
    const code = await proc.exited;
    clearTimeout(timer);
    expect(code).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain("bogus");
  }, 20_000);
});
