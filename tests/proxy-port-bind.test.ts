// @constraint T7 — setcap on Linux / launchd on macOS at proxy install time
// Regression coverage for #39: `portBindMutation` must refuse to grant the
// network-bind capability (setcap on Linux, a launchd plist on macOS) to a
// general-purpose interpreter path instead of a packaged mockstar binary.
//
// These tests never call `.apply()` on the returned mutation — constructing a
// mutation is pure (string building only); only `.apply()` shells out to `sudo`.
// So no sudo/setcap/launchctl invocation happens here, ever.

import { describe, expect, it } from "bun:test";
import {
  ALLOW_INTERPRETER_CAPABILITY_GRANT_ENV,
  ALLOW_INTERPRETER_CAPABILITY_GRANT_FLAG,
  portBindMutation,
} from "../src/features/proxy/port-bind.ts";
import { ProxyError } from "../src/features/proxy/types.ts";

/** Capture process.stderr.write during a callback, then restore it. */
function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join("");
}

describe("portBindMutation — #39 interpreter-path refusal", () => {
  it.each([
    "/usr/local/bin/bun",
    "/home/dev/.bun/bin/bun",
    "/usr/local/bin/bun-debug",
    "/usr/local/bin/node",
    "/opt/homebrew/bin/deno",
    "bun", // bare basename, as process.execPath can resolve to on some setups
  ])("refuses interpreter path %s with a typed ProxyError", (binaryPath) => {
    expect(() => portBindMutation({ binaryPath })).toThrow(ProxyError);
    try {
      portBindMutation({ binaryPath });
      throw new Error("expected portBindMutation to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProxyError);
      const proxyErr = err as ProxyError;
      expect(proxyErr.code).toBe("binary_path_is_interpreter");
      expect(proxyErr.message).toContain(binaryPath);
      expect(proxyErr.hint).toBeDefined();
      expect(proxyErr.hint).toContain("build:binary");
      // The refusal must be self-service: a user hitting this in a container should be
      // able to resolve it from the error alone, without reading source.
      expect(proxyErr.hint).toContain(ALLOW_INTERPRETER_CAPABILITY_GRANT_FLAG);
      expect(proxyErr.hint).toContain(ALLOW_INTERPRETER_CAPABILITY_GRANT_ENV);
    }
  });

  it("refuses an interpreter path identically when allowInterpreter is explicitly false", () => {
    expect(() => portBindMutation({ binaryPath: "/usr/local/bin/bun", allowInterpreter: false })).toThrow(
      ProxyError,
    );
  });

  it.each([
    "/usr/local/bin/mockstar",
    "/opt/mockstar/dist/mockstar-darwin-arm64",
    "/opt/mockstar/dist/mockstar-linux-x64",
    "/home/dev/bin/mockstar-linux-arm64",
  ])("accepts a packaged mockstar binary path %s", (binaryPath) => {
    // Platform-agnostic: on Linux this builds a setcap mutation (whose `action`
    // names binaryPath directly); on macOS a launchd-plist mutation (whose
    // `action` names the plist path instead, with binaryPath embedded in the
    // plist contents, not in `action`). Either way it must not throw, and must
    // produce a well-formed mutation.
    expect(() => portBindMutation({ binaryPath })).not.toThrow();
    const mutation = portBindMutation({ binaryPath });
    expect(mutation.action.length).toBeGreaterThan(0);
    expect(mutation.reverseCommand).toBeDefined();
  });
});

describe("portBindMutation — #39 escape hatch (allowInterpreter)", () => {
  it.each([
    "/usr/local/bin/bun",
    "/usr/local/bin/bun-debug",
    "/usr/local/bin/node",
    "/opt/homebrew/bin/deno",
  ])(
    "permits interpreter path %s when allowInterpreter is true, and produces a well-formed mutation",
    (binaryPath) => {
      let mutation: ReturnType<typeof portBindMutation> | undefined;
      const stderr = captureStderr(() => {
        mutation = portBindMutation({ binaryPath, allowInterpreter: true });
      });
      expect(mutation).toBeDefined();
      expect(mutation?.action.length).toBeGreaterThan(0);
      expect(mutation?.reverseCommand).toBeDefined();
      // The escape hatch is auditable in the journal too: the action string records that
      // this mutation used it (see linuxSetcapMutation / macosLaunchdMutation).
      expect(mutation?.action).toContain("INTERPRETER GRANT");
      // And it must be loud in CI logs, naming exactly what is granted and to which path.
      expect(stderr).toContain("WARNING");
      expect(stderr).toContain(binaryPath);
      expect(stderr).toContain("cap_net_bind_service");
    },
  );

  it("emits the warning naming the flag and env var that were used to opt in", () => {
    const stderr = captureStderr(() => {
      portBindMutation({ binaryPath: "/usr/local/bin/bun", allowInterpreter: true });
    });
    expect(stderr).toContain(ALLOW_INTERPRETER_CAPABILITY_GRANT_FLAG);
    expect(stderr).toContain(ALLOW_INTERPRETER_CAPABILITY_GRANT_ENV);
  });

  it.each([
    "/usr/local/bin/mockstar",
    "/opt/mockstar/dist/mockstar-darwin-arm64",
    "/opt/mockstar/dist/mockstar-linux-x64",
  ])("leaves a legitimate packaged binary path %s unaffected, and emits no warning", (binaryPath) => {
    let mutationFalse: ReturnType<typeof portBindMutation> | undefined;
    let mutationTrue: ReturnType<typeof portBindMutation> | undefined;
    const stderrFalse = captureStderr(() => {
      mutationFalse = portBindMutation({ binaryPath, allowInterpreter: false });
    });
    const stderrTrue = captureStderr(() => {
      mutationTrue = portBindMutation({ binaryPath, allowInterpreter: true });
    });
    expect(mutationFalse?.action).not.toContain("INTERPRETER GRANT");
    expect(mutationTrue?.action).not.toContain("INTERPRETER GRANT");
    expect(stderrFalse).toBe("");
    expect(stderrTrue).toBe("");
  });
});
