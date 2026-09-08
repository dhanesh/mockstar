// @constraint RT-5 — DNS strategy: dnsmasq primary; /etc/hosts fallback; env-detected
//
// Regression coverage for issue #32: revertHostsBlock (and the macOS resolver-file
// mutation in buildDnsmasqMutations) used to shell out to a privileged `tee` with
// nothing piped to its stdin, which truncates the target file to empty on open and
// then writes nothing — silently, because the result was `.catch(() => undefined)`.
//
// These tests never touch the real /etc/hosts or /etc/resolver, and never invoke a
// real `sudo` — every privileged call goes through a fake runner injected via the
// (test-only) `runner`/`hostsPath` options.

import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOSTS_BLOCK_END,
  HOSTS_BLOCK_MARKER,
  buildDnsmasqMutations,
  revertHostsBlock,
} from "../src/features/proxy/dns.ts";
import { ProxyError } from "../src/features/proxy/types.ts";

type RunnerCall = readonly string[];
type RunnerResult = { exitCode: number; stdout: string; stderr: string };

/**
 * A fake privileged runner. Records every invocation. For an `mv <tmp> <dest>` call it
 * can optionally perform the move itself (reading the tmp file's content first) so tests
 * can assert on what actually would have landed at `dest` — without ever calling `sudo`.
 */
function fakeRunner(opts: { succeed: boolean; performMove?: boolean }) {
  const calls: RunnerCall[] = [];
  const tmpFileContents: string[] = [];
  const runner = async (argv: readonly string[]): Promise<RunnerResult> => {
    calls.push(argv);
    if (argv[0] === "mv" && argv[1]) {
      const content = await readFile(argv[1], "utf8");
      tmpFileContents.push(content);
      if (opts.succeed && opts.performMove !== false && argv[2]) {
        await writeFile(argv[2], content, "utf8");
      }
    }
    return opts.succeed
      ? { exitCode: 0, stdout: "", stderr: "" }
      : { exitCode: 1, stdout: "", stderr: "sudo: a password is required" };
  };
  return { runner, calls, tmpFileContents };
}

async function tempHostsFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mockstar-dns-test-"));
  const path = join(dir, "hosts");
  await writeFile(path, content, "utf8");
  return path;
}

describe("revertHostsBlock (issue #32)", () => {
  it("removes only the marked block and preserves surrounding content byte-for-byte", async () => {
    const before = "127.0.0.1\tlocalhost\n255.255.255.255\tbroadcasthost\n";
    const block = `\n${HOSTS_BLOCK_MARKER}\n127.0.0.1\tapi.example.com\n${HOSTS_BLOCK_END}\n`;
    const after = "10.0.0.1\tsomething-else\n";
    const hostsPath = await tempHostsFile(before + block + after);

    const { runner } = fakeRunner({ succeed: true, performMove: true });
    await revertHostsBlock(HOSTS_BLOCK_MARKER, { hostsPath, runner });

    const result = await readFile(hostsPath, "utf8");
    expect(result).toBe(before + after);
  });

  it("never issues a privileged write without content — asserts the command sequence", async () => {
    const before = "127.0.0.1\tlocalhost\n";
    const block = `\n${HOSTS_BLOCK_MARKER}\n127.0.0.1\tapi.example.com\n${HOSTS_BLOCK_END}\n`;
    const after = "10.0.0.1\tkeep-me\n";
    const hostsPath = await tempHostsFile(before + block + after);

    const { runner, calls, tmpFileContents } = fakeRunner({ succeed: true, performMove: true });
    await revertHostsBlock(HOSTS_BLOCK_MARKER, { hostsPath, runner });

    // Exactly one privileged call, and it's `mv <tempfile> <hostsPath>` — never a bare
    // `tee <hostsPath>` with nothing piped to it.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("mv");
    expect(calls[0]?.[2]).toBe(hostsPath);
    expect(calls[0]?.[1]).not.toBe("tee");

    // The temp file that was moved into place held the exact corrected content — not empty.
    expect(tmpFileContents).toHaveLength(1);
    expect(tmpFileContents[0]).toBe(before + after);
    expect(tmpFileContents[0]?.length ?? 0).toBeGreaterThan(0);
  });

  it("surfaces an error and leaves the target untouched when the privileged write fails", async () => {
    const before = "127.0.0.1\tlocalhost\n";
    const block = `\n${HOSTS_BLOCK_MARKER}\n127.0.0.1\tapi.example.com\n${HOSTS_BLOCK_END}\n`;
    const original = before + block;
    const hostsPath = await tempHostsFile(original);

    const { runner, calls } = fakeRunner({ succeed: false });

    await expect(revertHostsBlock(HOSTS_BLOCK_MARKER, { hostsPath, runner })).rejects.toThrow(ProxyError);
    await expect(revertHostsBlock(HOSTS_BLOCK_MARKER, { hostsPath, runner })).rejects.toMatchObject({
      code: "hosts_revert_failed",
    });

    // A privileged attempt was made (so the failure was real, not skipped)...
    expect(calls.length).toBeGreaterThan(0);
    // ...but since the fake runner never performed the move, the file on disk is exactly
    // what it was before — never truncated, never left empty.
    const stillThere = await readFile(hostsPath, "utf8");
    expect(stillThere).toBe(original);
    expect(stillThere.length).toBeGreaterThan(0);
  });

  it("does nothing if the file can't be read (preserves existing early-return behaviour)", async () => {
    const { runner, calls } = fakeRunner({ succeed: true });
    await revertHostsBlock(HOSTS_BLOCK_MARKER, {
      hostsPath: "/nonexistent/mockstar-test-path/hosts",
      runner,
    });
    expect(calls).toHaveLength(0);
  });

  it("does nothing if the marker block is not found (preserves existing early-return behaviour)", async () => {
    const original = "127.0.0.1\tlocalhost\n";
    const hostsPath = await tempHostsFile(original);
    const { runner, calls } = fakeRunner({ succeed: true });

    await revertHostsBlock(HOSTS_BLOCK_MARKER, { hostsPath, runner });

    expect(calls).toHaveLength(0);
    expect(await readFile(hostsPath, "utf8")).toBe(original);
  });
});

// The resolver-file mutation is macOS-only (buildDnsmasqMutations only emits it when
// platform() === "darwin"); skip on other platforms rather than asserting a mutation
// that the production code itself would never produce there.
describe.skipIf(platform() !== "darwin")(
  "buildDnsmasqMutations resolver write (issue #32, dns.ts:157)",
  () => {
    function resolverMutation(runner: (argv: readonly string[]) => Promise<RunnerResult>) {
      const mutations = buildDnsmasqMutations([{ host: "api.example.com", tenant: "default" }], { runner });
      const mutation = mutations.find((m) => m.action.includes("resolver"));
      if (!mutation) throw new Error("expected a resolver mutation on darwin");
      return mutation;
    }

    it("writes the real resolver content via temp file + mv — never a bare truncating tee", async () => {
      const { runner, calls, tmpFileContents } = fakeRunner({ succeed: true, performMove: false });
      const mutation = resolverMutation(runner);

      await mutation.apply();

      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe("mv");
      expect(calls[0]?.[2]).toBe("/etc/resolver/api.example.com");
      expect(tmpFileContents[0]).toBe("nameserver 127.0.0.1\nport 53\n");
      expect(tmpFileContents[0]?.length ?? 0).toBeGreaterThan(0);
    });

    it("throws a ProxyError (rather than silently succeeding) when the privileged write fails", async () => {
      const { runner, calls } = fakeRunner({ succeed: false });
      const mutation = resolverMutation(runner);

      await expect(mutation.apply()).rejects.toThrow(ProxyError);
      await expect(mutation.apply()).rejects.toMatchObject({ code: "resolver_write_failed" });
      expect(calls.length).toBeGreaterThan(0);
    });
  },
);
