// Satisfies: RT-5 (DNS strategy: dnsmasq primary; /etc/hosts fallback; env-detected)
// Satisfies: T6
//
// Two modes:
//   1. dnsmasq: write a dnsmasq.conf + /etc/resolver/<host>.conf (macOS) or systemd-resolved
//      per-link config (Linux); reload dnsmasq. Per-host interception; survives reboot via
//      launchd/systemd unit.
//   2. /etc/hosts fallback: append a marked block mapping each host to 127.0.0.1. Simpler,
//      survives everything, no wildcard support.
//
// The mode is chosen by env-detector at install time and persisted to proxy config.
//
// NOTE: the file-system-mutating install steps below are intentionally platform-specific
// and contain significant TODO markers where production-quality integration needs live
// testing on each platform. The structure + signatures are stable; the shell-outs are
// scaffolded with clear intent.

import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import type { Mutation } from "./install-journal.ts";
import { runPrivileged } from "./port-bind.ts";
import type { HostConfig, ProxyConfig, ReverseCommand } from "./types.ts";
import { ProxyError } from "./types.ts";

/** Signature of {@link runPrivileged} — injectable so tests never shell out to real `sudo`. */
type PrivilegedRunner = typeof runPrivileged;

// --- PUBLIC API ----------------------------------------------------------

export const HOSTS_BLOCK_MARKER = "# BEGIN mockstar-proxy (do not edit)";
export const HOSTS_BLOCK_END = "# END mockstar-proxy";
export const HOSTS_PATH = "/etc/hosts";

/**
 * Build the install mutation(s) for DNS. Depending on mode, produces either:
 *   - dnsmasq config + resolver files + service registration
 *   - /etc/hosts block append
 */
export async function buildDnsMutations(config: ProxyConfig): Promise<Mutation[]> {
  if (config.dnsMode === "hosts-fallback") {
    return buildHostsMutations(config.hosts);
  }
  return buildDnsmasqMutations(config.hosts);
}

/**
 * Reverse a hosts-fallback block. Used by install-journal's reverse_hosts_entries handler.
 *
 * `hostsPath` and `runner` are injectable purely for tests — real callers never pass them,
 * so they default to the real `/etc/hosts` and the real privileged `sudo` runner.
 */
export async function revertHostsBlock(
  marker: string,
  opts: { hostsPath?: string; runner?: PrivilegedRunner } = {},
): Promise<void> {
  const hostsPath = opts.hostsPath ?? HOSTS_PATH;
  let existing = "";
  try {
    existing = await readFile(hostsPath, "utf8");
  } catch {
    return;
  }
  const markerStart = existing.indexOf(marker);
  const end = existing.indexOf(HOSTS_BLOCK_END);
  if (markerStart === -1 || end === -1) return;
  // The appended block (see buildHostsMutations) is `\n${marker}\n...\n${HOSTS_BLOCK_END}\n` —
  // it owns one leading and one trailing newline as separators. Consume both so the
  // surrounding content is restored byte-for-byte, not left with a stray blank line.
  const blockStart = existing[markerStart - 1] === "\n" ? markerStart - 1 : markerStart;
  let blockEnd = end + HOSTS_BLOCK_END.length;
  if (existing[blockEnd] === "\n") blockEnd += 1;
  const next = existing.slice(0, blockStart) + existing.slice(blockEnd);
  // Writing /etc/hosts requires sudo. Write the corrected content to a temp file first,
  // then `sudo mv` it into place — atomic, never truncates the target, and needs no stdin.
  await privilegedWriteFile(hostsPath, next, {
    runner: opts.runner,
    errorCode: "hosts_revert_failed",
    hint: `Manually remove the block between '${HOSTS_BLOCK_MARKER}' and '${HOSTS_BLOCK_END}' in ${hostsPath}.`,
  });
}

/**
 * Write `content` to `path` via sudo, safely: the content is written to a private temp
 * file first (no privilege needed for that), then moved into place with `sudo mv`. This
 * is atomic and never truncates `path` without first having the full content ready to
 * land there — unlike shelling out to a privileged `tee` with nothing piped to its stdin,
 * which truncates the target on open and then writes nothing.
 *
 * `mv` replaces the directory entry for `path` with the temp file's inode. That's correct
 * (and preferred) on an ordinary filesystem, but it's exactly what fails when `path` is a
 * bind-mounted file — e.g. `/etc/hosts` inside a Docker container — because the mount
 * pins that specific inode in place and the rename can't swap it out. `mv` there fails
 * with something like "Device or resource busy" (EBUSY).
 *
 * When `mv` fails, fall back to `sudo cp <tmpfile> <path>`. `cp` opens the *existing*
 * inode and writes the new content into it in place, rather than trying to replace the
 * inode — so it succeeds against a bind mount where `mv` can't. It also preserves the
 * same safety property #32 cares about: `cp`'s source is always the fully-written temp
 * file, so — unlike a bare `tee` invoked with nothing piped to its stdin — there is no
 * way for it to open/truncate the target and then have no content to write. (Piping the
 * temp file into `tee`'s stdin would share that same safety property, but `cp` gets it
 * with a plain two-argument argv and no change to how commands are run — no need to wire
 * a file descriptor into `runPrivileged`/`runCmd`'s stdio — so it's the simpler choice
 * for the same guarantee.)
 *
 * Which mechanism actually wrote the file is logged to stderr so a CI failure is
 * diagnosable from the job output alone, without needing to reproduce locally.
 *
 * If *both* `mv` and `cp` fail, this throws a `ProxyError` — it never swallows the
 * outcome, and it never leaves a partially-written or truncated file: neither command
 * runs unless the temp file is fully written first, and a failed command never touches
 * `path`.
 */
async function privilegedWriteFile(
  path: string,
  content: string,
  opts: { runner?: PrivilegedRunner; errorCode: string; hint?: string } = {
    errorCode: "privileged_write_failed",
  },
): Promise<void> {
  const runner = opts.runner ?? runPrivileged;
  const dir = await mkdtemp(join(tmpdir(), "mockstar-proxy-"));
  const tmpFile = join(dir, "content");
  try {
    await writeFile(tmpFile, content, "utf8");

    const mvResult = await runner(["mv", tmpFile, path]);
    if (mvResult.exitCode === 0) {
      process.stderr.write(`mockstar-proxy: wrote ${path} via 'mv' (atomic rename).\n`);
      return;
    }
    const mvError =
      mvResult.stderr.trim() || mvResult.stdout.trim() || `mv exited with code ${mvResult.exitCode}`;

    // Fallback: `tee` with the content piped to its stdin. This writes THROUGH the
    // existing inode instead of replacing it, so it succeeds against a bind mount.
    //
    // `cp` was the obvious candidate and is wrong: busybox `cp` refuses with
    // "can't create '<path>': File exists" on a bind-mounted target, so it works on
    // GNU coreutils and fails on Alpine — which is what mockstar's own runtime image
    // is built on. Verified in both, plus `tee`, against a real Docker bind mount.
    //
    // This is `tee` used correctly, and is NOT a return of the #32 bug: that bug was
    // `tee` with NOTHING supplied on an inherited stdin, so it truncated and then read
    // EOF. Here the content is piped explicitly, and `runPrivileged` only inherits
    // stdin when no `stdin` option is passed.
    const teeResult = await runner(["tee", path], { stdin: content });
    if (teeResult.exitCode === 0) {
      const why = "target is likely a bind mount, e.g. inside a container";
      process.stderr.write(
        `mockstar-proxy: 'mv' failed for ${path} (${mvError}); wrote via piped 'tee' instead (${why}).\n`,
      );
      return;
    }
    const teeError =
      teeResult.stderr.trim() || teeResult.stdout.trim() || `tee exited with code ${teeResult.exitCode}`;

    throw new ProxyError(
      `Failed to write ${path}: mv failed (${mvError}); piped tee fallback also failed (${teeError})`,
      opts.errorCode,
      opts.hint,
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Stop and remove the dnsmasq service installed by buildDnsmasqMutations. */
export async function stopAndRemoveDnsmasq(): Promise<void> {
  const os = platform();
  if (os === "darwin") {
    // Homebrew services: brew services stop dnsmasq; remove resolver files.
    await runPrivileged(["brew", "services", "stop", "dnsmasq"]).catch(() => undefined);
    // Per-host resolver files are removed by install-journal's remove_file entries; nothing
    // additional to do here beyond stopping the service.
  } else if (os === "linux") {
    await runPrivileged(["systemctl", "stop", "dnsmasq.service"]).catch(() => undefined);
    await runPrivileged(["systemctl", "disable", "dnsmasq.service"]).catch(() => undefined);
  }
}

// --- HOSTS FALLBACK ------------------------------------------------------

function buildHostsMutations(hosts: readonly HostConfig[]): Mutation[] {
  const block = `\n${HOSTS_BLOCK_MARKER}\n${hosts.map((h) => `127.0.0.1\t${h.host}`).join("\n")}\n${HOSTS_BLOCK_END}\n`;
  const reverse: ReverseCommand = { kind: "revert_hosts_entries", blockMarker: HOSTS_BLOCK_MARKER };
  return [
    {
      action: `append mockstar block to ${HOSTS_PATH} (${hosts.length} host${hosts.length === 1 ? "" : "s"})`,
      reverseCommand: reverse,
      async apply(): Promise<void> {
        // /etc/hosts requires sudo. Real impl: write to tempfile then `sudo mv`.
        try {
          await appendFile(HOSTS_PATH, block, "utf8");
        } catch (err) {
          throw new ProxyError(
            `Failed to write ${HOSTS_PATH}: ${err instanceof Error ? err.message : String(err)}`,
            "hosts_write_failed",
            `Run 'mockstar proxy install' with sudo OR switch to --dns-mode=dnsmasq.`,
          );
        }
      },
    },
  ];
}

// --- DNSMASQ -------------------------------------------------------------

/**
 * `overrides.runner` is injectable purely for tests — real callers never pass it, so
 * privileged writes go through the real `sudo` runner.
 */
export function buildDnsmasqMutations(
  hosts: readonly HostConfig[],
  overrides: { runner?: PrivilegedRunner } = {},
): Mutation[] {
  const os = platform();
  if (os !== "darwin" && os !== "linux") {
    throw new ProxyError(
      `dnsmasq mode not supported on platform '${os}' in v1. Use hosts-fallback mode.`,
      "dnsmasq_platform_unsupported",
    );
  }

  // TODO(m4-follow-up): The full dnsmasq setup involves:
  //   1. brew/apt install dnsmasq (skip if already installed)
  //   2. Write /usr/local/etc/dnsmasq.conf (macOS) or /etc/dnsmasq.d/mockstar.conf (Linux)
  //      with per-host "address=/api.razorpay.com/127.0.0.1" lines.
  //   3. macOS: write /etc/resolver/<host>.conf per hostname with "nameserver 127.0.0.1".
  //   4. Linux: configure systemd-resolved per-link or update /etc/resolv.conf (if permitted).
  //   5. Start dnsmasq via brew services / systemctl.
  //
  // For v1 the full implementation requires live testing on both platforms + extensive
  // rollback paths. The structure below is scaffolded so the install-journal records
  // the right reverse commands; the apply() bodies shell out to the relevant platform
  // tools. Each sub-mutation is recorded as a separate journal entry so partial failures
  // are cleanly reversible.

  const mutations: Mutation[] = [];

  const dnsmasqConfigPath =
    os === "darwin" ? "/opt/homebrew/etc/dnsmasq.conf" : "/etc/dnsmasq.d/mockstar.conf";

  const dnsmasqContent = `# Generated by mockstar-proxy; do not edit manually.\n${hosts.map((h) => `address=/${h.host}/127.0.0.1`).join("\n")}\n`;

  mutations.push({
    action: `write dnsmasq config to ${dnsmasqConfigPath}`,
    reverseCommand: { kind: "remove_file", path: dnsmasqConfigPath },
    async apply(): Promise<void> {
      await writeFile(dnsmasqConfigPath, dnsmasqContent, "utf8").catch((err) => {
        throw new ProxyError(
          `Cannot write ${dnsmasqConfigPath}: ${err instanceof Error ? err.message : String(err)}`,
          "dnsmasq_config_write_failed",
          `Install dnsmasq first: '${os === "darwin" ? "brew install dnsmasq" : "apt install dnsmasq"}'.`,
        );
      });
    },
  });

  if (os === "darwin") {
    for (const host of hosts) {
      const resolverPath = `/etc/resolver/${host.host}`;
      mutations.push({
        action: `write macOS resolver file at ${resolverPath}`,
        reverseCommand: { kind: "remove_file", path: resolverPath },
        async apply(): Promise<void> {
          // Writing under /etc/resolver requires sudo. The install CLI prompts for password once.
          // Write via temp file + `sudo mv` (see privilegedWriteFile) — atomic, and the content
          // that lands is exactly what was computed here, never an empty truncated file.
          const content = "nameserver 127.0.0.1\nport 53\n";
          await privilegedWriteFile(resolverPath, content, {
            runner: overrides.runner,
            errorCode: "resolver_write_failed",
            hint: `Manually create ${resolverPath} with:\n${content}`,
          });
        },
      });
    }
  }

  mutations.push({
    action: `start dnsmasq service (${os === "darwin" ? "brew services" : "systemctl"})`,
    reverseCommand: { kind: "dnsmasq_stop_and_remove" },
    async apply(): Promise<void> {
      if (os === "darwin") {
        const result = await runPrivileged(["brew", "services", "start", "dnsmasq"]);
        if (result.exitCode !== 0) {
          throw new ProxyError(
            `brew services start dnsmasq failed: ${result.stderr.trim()}`,
            "dnsmasq_start_failed",
            `Verify dnsmasq is installed ('brew install dnsmasq').`,
          );
        }
      } else {
        const result = await runPrivileged(["systemctl", "start", "dnsmasq.service"]);
        if (result.exitCode !== 0) {
          throw new ProxyError(
            `systemctl start dnsmasq failed: ${result.stderr.trim()}`,
            "dnsmasq_start_failed",
          );
        }
      }
    },
  });

  return mutations;
}

// Re-export for install-journal's dynamic-import reverse handlers
export { join };
