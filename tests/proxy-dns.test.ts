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

/**
 * A fake privileged runner that can be told, independently, whether `mv` and the piped
 * `tee` fallback succeed — so tests can exercise the bind-mount path added after #32's
 * initial fix (mv fails with an EBUSY-shaped error; tee is expected to pick up the write).
 *
 * Why `tee` and not `cp`: verified against a real Docker bind mount, busybox `cp` refuses
 * with "can't create '<path>': File exists", so a `cp` fallback works on GNU coreutils and
 * fails on Alpine — which is what mockstar's own runtime image is built on. `tee` writes
 * through the existing inode and works on both.
 *
 * `tee` takes its content on stdin, not as an argv path, so this runner reads it from the
 * `stdin` option — which is also the guard against #32 regressing: a `tee` invoked with no
 * `stdin` truncates the target and then reads EOF, which is exactly the original bug.
 *
 * Like {@link fakeRunner}, this never shells out to real `sudo`; it optionally performs
 * the write itself so tests can assert on what actually landed at the destination.
 */
function fakeFallbackRunner(opts: {
  mv: "succeed" | "fail";
  tee: "succeed" | "fail";
  performWrite?: boolean;
}) {
  const calls: RunnerCall[] = [];
  const contentsByCmd: Record<string, string[]> = { mv: [], tee: [] };
  const performWrite = opts.performWrite ?? true;
  const runner = async (argv: readonly string[], runOpts: { stdin?: string } = {}): Promise<RunnerResult> => {
    calls.push(argv);
    const cmd = argv[0];

    if (cmd === "mv" && argv[1] && argv[2]) {
      const content = await readFile(argv[1], "utf8");
      contentsByCmd.mv?.push(content);
      if (opts.mv === "succeed") {
        if (performWrite) await writeFile(argv[2], content, "utf8");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "mv: cannot move: Device or resource busy" };
    }

    if (cmd === "tee" && argv[1]) {
      // #32 regression guard: content must arrive on stdin. A tee with no stdin is the
      // original truncating bug, so treat it as a hard test failure rather than a pass.
      if (runOpts.stdin === undefined) {
        throw new Error("tee was invoked without piped stdin — this is the #32 bug");
      }
      contentsByCmd.tee?.push(runOpts.stdin);
      if (opts.tee === "succeed") {
        if (performWrite) await writeFile(argv[1], runOpts.stdin, "utf8");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "tee: /etc/hosts: Permission denied" };
    }

    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { runner, calls, contentsByCmd };
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

// Regression coverage for the bind-mount follow-up: `sudo mv` can't replace the inode of
// a bind-mounted /etc/hosts (e.g. inside a Docker container) and fails with an
// EBUSY-shaped error. The privileged write must fall back to a piped `sudo tee`, which
// writes THROUGH the existing inode instead of replacing it. (`cp` was tried first and
// rejected: busybox cp fails on a bind mount, so it works on Debian and breaks on Alpine.)
describe("revertHostsBlock bind-mount fallback (mv EBUSY -> piped tee)", () => {
  it("never invokes tee when mv succeeds", async () => {
    const before = "127.0.0.1\tlocalhost\n";
    const block = `\n${HOSTS_BLOCK_MARKER}\n127.0.0.1\tapi.example.com\n${HOSTS_BLOCK_END}\n`;
    const after = "10.0.0.1\tkeep-me\n";
    const hostsPath = await tempHostsFile(before + block + after);

    const { runner, calls } = fakeFallbackRunner({ mv: "succeed", tee: "succeed" });
    await revertHostsBlock(HOSTS_BLOCK_MARKER, { hostsPath, runner });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("mv");
    expect(calls.some((c) => c[0] === "tee")).toBe(false);
    expect(await readFile(hostsPath, "utf8")).toBe(before + after);
  });

  it("falls back to piped tee when mv fails with a busy-like error, and the content written is byte-identical to what mv would have written", async () => {
    const before = "127.0.0.1\tlocalhost\n";
    const block = `\n${HOSTS_BLOCK_MARKER}\n127.0.0.1\tapi.example.com\n${HOSTS_BLOCK_END}\n`;
    const after = "10.0.0.1\tkeep-me\n";
    const hostsPath = await tempHostsFile(before + block + after);
    const expected = before + after;

    const { runner, calls, contentsByCmd } = fakeFallbackRunner({ mv: "fail", tee: "succeed" });
    await revertHostsBlock(HOSTS_BLOCK_MARKER, { hostsPath, runner });

    // mv attempted first, then tee — never tee-only, never tee-before-mv.
    expect(calls.map((c) => c[0])).toEqual(["mv", "tee"]);
    // The tee call targeted the real hosts path (tee takes it as argv[1], content on stdin).
    expect(calls[1]?.[1]).toBe(hostsPath);

    // Content piped to tee is exactly the content that would have been renamed by mv.
    expect(contentsByCmd.mv?.[0]).toBe(expected);
    expect(contentsByCmd.tee?.[0]).toBe(expected);
    expect(contentsByCmd.mv?.[0]).toBe(contentsByCmd.tee?.[0]);

    // And it's what actually landed at the destination.
    expect(await readFile(hostsPath, "utf8")).toBe(expected);
  });

  it("throws a ProxyError and leaves the target untouched when both mv and tee fail", async () => {
    const before = "127.0.0.1\tlocalhost\n";
    const block = `\n${HOSTS_BLOCK_MARKER}\n127.0.0.1\tapi.example.com\n${HOSTS_BLOCK_END}\n`;
    const original = before + block;
    const hostsPath = await tempHostsFile(original);

    const { runner, calls } = fakeFallbackRunner({ mv: "fail", tee: "fail" });

    await expect(revertHostsBlock(HOSTS_BLOCK_MARKER, { hostsPath, runner })).rejects.toThrow(ProxyError);

    const { runner: runner2 } = fakeFallbackRunner({ mv: "fail", tee: "fail" });
    await expect(revertHostsBlock(HOSTS_BLOCK_MARKER, { hostsPath, runner: runner2 })).rejects.toMatchObject({
      code: "hosts_revert_failed",
    });

    // Both privileged attempts were made (mv, then tee) — the failure is real, not skipped.
    expect(calls.map((c) => c[0])).toEqual(["mv", "tee"]);

    // Neither fake runner performed a write, so the file on disk is exactly what it was
    // before — never truncated, never left partially written.
    const stillThere = await readFile(hostsPath, "utf8");
    expect(stillThere).toBe(original);
    expect(stillThere.length).toBeGreaterThan(0);
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

    it("falls back to piped tee when mv fails with a busy-like error (bind-mounted /etc/resolver)", async () => {
      // performWrite: false — the resolver path is not injectable (real callers always
      // target the real /etc/resolver/<host>), so the fake must not actually write there.
      const { runner, calls, contentsByCmd } = fakeFallbackRunner({
        mv: "fail",
        tee: "succeed",
        performWrite: false,
      });
      const mutation = resolverMutation(runner);

      await mutation.apply();

      expect(calls.map((c) => c[0])).toEqual(["mv", "tee"]);
      // tee takes the target as argv[1] and the content on stdin.
      expect(calls[1]?.[1]).toBe("/etc/resolver/api.example.com");
      expect(contentsByCmd.tee?.[0]).toBe("nameserver 127.0.0.1\nport 53\n");
      expect(contentsByCmd.tee?.[0]).toBe(contentsByCmd.mv?.[0]);
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
