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
import { ProxyError, type ReverseCommand } from "./types.ts";

// --- PUBLIC API ----------------------------------------------------------

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
 */
export function portBindMutation(params: {
  binaryPath: string;
  plistPath?: string;
  launchdLabel?: string;
}): PortBindMutation {
  const os = platform();
  if (os === "linux") {
    return linuxSetcapMutation(params.binaryPath);
  }
  if (os === "darwin") {
    return macosLaunchdMutation({
      plistPath: params.plistPath ?? `${process.env.HOME}/Library/LaunchAgents/com.mockstar.proxy.plist`,
      label: params.launchdLabel ?? "com.mockstar.proxy",
      binaryPath: params.binaryPath,
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

function linuxSetcapMutation(binaryPath: string): PortBindMutation {
  return {
    action: `setcap cap_net_bind_service=+ep ${binaryPath}`,
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
}): PortBindMutation {
  const plistContents = macosPlist(params.label, params.binaryPath);
  return {
    action: `install launchd plist at ${params.plistPath}`,
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
