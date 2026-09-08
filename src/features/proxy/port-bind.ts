// Satisfies: RT-6 (port 443 binding via OS capability grants at install time)
// Satisfies: T7 (setcap on Linux / launchd on macOS)
//
// Install grants a capability once, with sudo. Daily `mockstar proxy start` runs unprivileged.
// Uninstall reverses via the install journal.
//
// IMPORTANT: this module shells out to `setcap` / `launchctl` which require sudo. It's called
// from the install/uninstall paths, never from steady-state runtime. The privilege escalation
// is explicit and user-visible (the user sees their OS's password prompt).

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { basename } from "node:path";
import { ProxyError, type ReverseCommand } from "./types.ts";

// --- PUBLIC API ----------------------------------------------------------

// General-purpose JS/TS runtime executables. `mockstar proxy install` must never grant
// cap_net_bind_service (or install a launchd plist) against one of these — see #39: run
// from source (`bun run src/cli.ts proxy install`) — or through the npm `mockstar` shim,
// which is itself a `#!/usr/bin/env bun` script — the resolved binary path is the
// interpreter's own path, not a packaged mockstar binary. Granting the capability to
// `bun` would hand every Bun program on the machine the ability to bind privileged
// ports, and makes `bun` an AT_SECURE binary machine-wide and persistently. `node` and
// `deno` are included defensively even though only Bun runs this project today.
const INTERPRETER_BASENAMES: ReadonlySet<string> = new Set(["bun", "bun-debug", "node", "deno"]);

/**
 * The explicit, opt-in escape hatch for #39's interpreter refusal (see below). Named so
 * both the CLI flag and the env var make the consequence obvious at the call site — a
 * reviewer reading a CI step or Dockerfile should not need to chase this into source to
 * know it grants the network-bind capability to the interpreter itself, not a packaged
 * binary. Two forms because a flag is what a human types, an env var is what a CI step
 * or Dockerfile `ENV`/`RUN` line can set without rewriting the invoked command.
 */
export const ALLOW_INTERPRETER_CAPABILITY_GRANT_FLAG = "--allow-interpreter-capability-grant";
export const ALLOW_INTERPRETER_CAPABILITY_GRANT_ENV = "MOCKSTAR_ALLOW_INTERPRETER_CAPABILITY_GRANT";

/** Does `binaryPath`'s basename match a general-purpose JS/TS runtime executable? */
function isInterpreterBinary(binaryPath: string): boolean {
  return INTERPRETER_BASENAMES.has(basename(binaryPath).toLowerCase());
}

/**
 * Refuse when `binaryPath` resolves to a general-purpose interpreter rather than a
 * packaged mockstar binary. Checked on the *basename* of the resolved path (not the
 * whole path or a "looks like mockstar" allowlist) because that is the one honest,
 * self-contained signal available here: the caller passes `process.execPath` (the
 * OS-resolved path of the actual running executable — more robust than
 * `process.argv[0]`, which a caller could override, e.g. via `exec -a`), and a
 * standalone `bun build --compile` binary never has a basename of `bun`/`node`/`deno`
 * regardless of what the user names it, whereas the interpreter always does.
 *
 * `allowInterpreter` is the explicit opt-in (see {@link ALLOW_INTERPRETER_CAPABILITY_GRANT_FLAG}
 * / {@link ALLOW_INTERPRETER_CAPABILITY_GRANT_ENV}). The default stays "refuse" — that's the
 * security property worth keeping (#39: this would otherwise grant every Bun program on the
 * machine the ability to bind privileged ports). Opting in is only appropriate on a
 * single-purpose, ephemeral host (a CI runner, a throwaway VM/container) where "every Bun
 * program on this machine" isn't a meaningful concern because the machine is discarded after
 * the run — never on a developer's own machine.
 */
function assertPackagedBinary(binaryPath: string, allowInterpreter: boolean): void {
  if (!isInterpreterBinary(binaryPath)) return;
  const base = basename(binaryPath).toLowerCase();

  if (!allowInterpreter) {
    throw new ProxyError(
      `Refusing to grant the network-bind capability to '${binaryPath}': it resolves to the ` +
        `${base} interpreter, not a packaged mockstar binary.`,
      "binary_path_is_interpreter",
      `Build and use a packaged binary instead of running from source: \`bun run build && bun run build:binary\`, then run \`./dist/mockstar-<platform>-<arch> proxy install\` (or use a downloaded release binary / the Docker image). Granting this capability to the interpreter itself would let every program it runs bind privileged ports. If this is a single-purpose, ephemeral host (CI runner, throwaway VM/container) where that risk doesn't apply, opt in explicitly with ${ALLOW_INTERPRETER_CAPABILITY_GRANT_FLAG} or ${ALLOW_INTERPRETER_CAPABILITY_GRANT_ENV}=1 — do not use either on a developer's own machine.`,
    );
  }

  // Opted in: proceed, but make the grant loud. This must land in CI logs (stderr, right
  // now) and be reconstructable after the fact (the mutation's `action` string, which the
  // caller both prints and persists in the install journal — see linuxSetcapMutation).
  process.stderr.write(
    `\nWARNING: granting cap_net_bind_service to '${binaryPath}' — the ${base} interpreter, not a packaged mockstar binary (${ALLOW_INTERPRETER_CAPABILITY_GRANT_FLAG} / ${ALLOW_INTERPRETER_CAPABILITY_GRANT_ENV}=1 was set). This grants EVERY program run by this interpreter on this host the ability to bind privileged ports, until 'mockstar proxy uninstall' or 'sudo setcap -r ${binaryPath}' reverses it. Only acceptable on a single-purpose, ephemeral host (CI runner, throwaway VM/container).\n\n`,
  );
}

export interface PortBindMutation {
  /** Human-readable description for the install journal. */
  readonly action: string;
  /** The reverse command recorded in the journal for uninstall. */
  readonly reverseCommand: ReverseCommand;
  apply(): Promise<void>;
}

/**
 * Produce a mutation that grants the running binary cap_net_bind_service (Linux)
 * or configures launchd to socket-activate on port 443 (macOS). Idempotent: re-running
 * is safe.
 *
 * @param binaryPath The absolute path to the mockstar binary (or the Bun binary when
 *                   running from source). On Linux, setcap is applied to this path.
 * @param allowInterpreter Explicit opt-in to grant the capability even when `binaryPath`
 *                   resolves to a general-purpose interpreter. Default `false` (refuse).
 *                   See {@link ALLOW_INTERPRETER_CAPABILITY_GRANT_FLAG} /
 *                   {@link ALLOW_INTERPRETER_CAPABILITY_GRANT_ENV}.
 */
export function portBindMutation(params: {
  binaryPath: string;
  plistPath?: string;
  launchdLabel?: string;
  allowInterpreter?: boolean;
}): PortBindMutation {
  const allowInterpreter = params.allowInterpreter ?? false;
  assertPackagedBinary(params.binaryPath, allowInterpreter);
  const interpreterGrant = allowInterpreter && isInterpreterBinary(params.binaryPath);

  const os = platform();
  if (os === "linux") {
    return linuxSetcapMutation(params.binaryPath, interpreterGrant);
  }
  if (os === "darwin") {
    return macosLaunchdMutation({
      plistPath: params.plistPath ?? `${process.env.HOME}/Library/LaunchAgents/com.mockstar.proxy.plist`,
      label: params.launchdLabel ?? "com.mockstar.proxy",
      binaryPath: params.binaryPath,
      interpreterGrant,
    });
  }
  throw new ProxyError(
    `Unsupported platform for port 443 bind: ${os}. macOS and Linux only in v1 (B2).`,
    "unsupported_platform",
  );
}

/**
 * Spawn a process via `sudo` (macOS/Linux). Used by install mutations that require
 * elevated privileges. The user sees the OS password prompt.
 */
export function runPrivileged(
  argv: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runCmd("sudo", argv);
}

/** Does the host OS support our port-443 binding strategy? */
export function isPlatformSupported(): boolean {
  const os = platform();
  return os === "linux" || os === "darwin";
}

// --- LINUX: setcap -------------------------------------------------------

function linuxSetcapMutation(binaryPath: string, interpreterGrant: boolean): PortBindMutation {
  return {
    action: `setcap cap_net_bind_service=+ep ${binaryPath}${interpreterGrant ? " [INTERPRETER GRANT — #39 escape hatch used, see install output]" : ""}`,
    reverseCommand: { kind: "setcap_drop", path: binaryPath },
    async apply(): Promise<void> {
      const result = await runPrivileged(["setcap", "cap_net_bind_service=+ep", binaryPath]);
      if (result.exitCode !== 0) {
        throw new ProxyError(
          `setcap failed: ${result.stderr.trim() || result.stdout.trim()}`,
          "setcap_failed",
          "Ensure 'libcap2-bin' is installed and the binary path is absolute.",
        );
      }
    },
  };
}

// --- MACOS: launchd ------------------------------------------------------

function macosLaunchdMutation(params: {
  plistPath: string;
  label: string;
  binaryPath: string;
  interpreterGrant: boolean;
}): PortBindMutation {
  const plistContents = macosPlist(params.label, params.binaryPath);
  return {
    action: `install launchd plist at ${params.plistPath}${
      params.interpreterGrant
        ? ` [INTERPRETER GRANT for ${params.binaryPath} — #39 escape hatch used, see install output]`
        : ""
    }`,
    reverseCommand: { kind: "launchctl_unload_and_remove", plistPath: params.plistPath },
    async apply(): Promise<void> {
      await writeFile(params.plistPath, plistContents, { encoding: "utf8", mode: 0o644 });
      const loadResult = await runCmd("launchctl", ["load", "-w", params.plistPath]);
      if (loadResult.exitCode !== 0) {
        throw new ProxyError(
          `launchctl load failed: ${loadResult.stderr.trim() || loadResult.stdout.trim()}`,
          "launchctl_load_failed",
          `Check ${params.plistPath} permissions + XML validity.`,
        );
      }
    },
  };
}

function macosPlist(label: string, binaryPath: string): string {
  // Uses Socket-activated launching: launchd binds port 443, passes the socket fd
  // to the running process via LAUNCH_DAEMON_SOCKET_NAME env var. When the user's
  // `mockstar proxy start` runs, it inherits the privileged socket.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binaryPath}</string>
    <string>proxy</string>
    <string>start</string>
  </array>
  <key>Sockets</key>
  <dict>
    <key>Listeners</key>
    <dict>
      <key>SockServiceName</key>
      <string>443</string>
      <key>SockNodeName</key>
      <string>127.0.0.1</string>
    </dict>
  </dict>
  <key>KeepAlive</key>
  <false/>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${process.env.HOME}/Library/Logs/mockstar-proxy.out.log</string>
  <key>StandardErrorPath</key>
  <string>${process.env.HOME}/Library/Logs/mockstar-proxy.err.log</string>
</dict>
</plist>
`;
}

// --- INTERNALS -----------------------------------------------------------

function runCmd(
  cmd: string,
  argv: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv as string[], { stdio: ["inherit", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}
