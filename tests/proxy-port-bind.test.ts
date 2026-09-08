// @constraint T7 — setcap on Linux / launchd on macOS at proxy install time
// Regression coverage for #39: `portBindMutation` must refuse to grant the
// network-bind capability (setcap on Linux, a launchd plist on macOS) to a
// general-purpose interpreter path instead of a packaged mockstar binary.
//
// These tests never call `.apply()` on the returned mutation — constructing a
// mutation is pure (string building only); only `.apply()` shells out to `sudo`.
// So no sudo/setcap/launchctl invocation happens here, ever.

import { describe, expect, it } from "bun:test";
import { portBindMutation } from "../src/features/proxy/port-bind.ts";
import { ProxyError } from "../src/features/proxy/types.ts";

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
    }
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
