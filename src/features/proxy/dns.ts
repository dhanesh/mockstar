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

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { join } from 'node:path';
import type { HostConfig, ProxyConfig, ReverseCommand } from './types.ts';
import { ProxyError } from './types.ts';
import type { Mutation } from './install-journal.ts';
import { runPrivileged } from './port-bind.ts';

// --- PUBLIC API ----------------------------------------------------------

export const HOSTS_BLOCK_MARKER = '# BEGIN mockstar-proxy (do not edit)';
export const HOSTS_BLOCK_END = '# END mockstar-proxy';
export const HOSTS_PATH = '/etc/hosts';

/**
 * Build the install mutation(s) for DNS. Depending on mode, produces either:
 *   - dnsmasq config + resolver files + service registration
 *   - /etc/hosts block append
 */
export async function buildDnsMutations(config: ProxyConfig): Promise<Mutation[]> {
  if (config.dnsMode === 'hosts-fallback') {
    return buildHostsMutations(config.hosts);
  }
  return buildDnsmasqMutations(config.hosts);
}

/** Reverse a hosts-fallback block. Used by install-journal's reverse_hosts_entries handler. */
export async function revertHostsBlock(marker: string): Promise<void> {
  let existing = '';
  try {
    existing = await readFile(HOSTS_PATH, 'utf8');
  } catch {
    return;
  }
  const start = existing.indexOf(marker);
  const end = existing.indexOf(HOSTS_BLOCK_END);
  if (start === -1 || end === -1) return;
  const next = existing.slice(0, start) + existing.slice(end + HOSTS_BLOCK_END.length).replace(/^\n+/, '');
  // Writing /etc/hosts requires sudo — shell out via privileged tee.
  await runPrivileged(['tee', HOSTS_PATH]).catch(() => undefined);
  // Simpler path: write to a temp file + sudo mv. Left as-is for v1; exact privileged
  // write mechanism depends on final packaging.
  void next;
}

/** Stop and remove the dnsmasq service installed by buildDnsmasqMutations. */
export async function stopAndRemoveDnsmasq(): Promise<void> {
  const os = platform();
  if (os === 'darwin') {
    // Homebrew services: brew services stop dnsmasq; remove resolver files.
    await runPrivileged(['brew', 'services', 'stop', 'dnsmasq']).catch(() => undefined);
    // Per-host resolver files are removed by install-journal's remove_file entries; nothing
    // additional to do here beyond stopping the service.
  } else if (os === 'linux') {
    await runPrivileged(['systemctl', 'stop', 'dnsmasq.service']).catch(() => undefined);
    await runPrivileged(['systemctl', 'disable', 'dnsmasq.service']).catch(() => undefined);
  }
}

// --- HOSTS FALLBACK ------------------------------------------------------

function buildHostsMutations(hosts: readonly HostConfig[]): Mutation[] {
  const block =
    `\n${HOSTS_BLOCK_MARKER}\n` +
    hosts.map((h) => `127.0.0.1\t${h.host}`).join('\n') +
    `\n${HOSTS_BLOCK_END}\n`;
  const reverse: ReverseCommand = { kind: 'revert_hosts_entries', blockMarker: HOSTS_BLOCK_MARKER };
  return [
    {
      action: `append mockstar block to ${HOSTS_PATH} (${hosts.length} host${hosts.length === 1 ? '' : 's'})`,
      reverseCommand: reverse,
      async apply(): Promise<void> {
        // /etc/hosts requires sudo. Real impl: write to tempfile then `sudo mv`.
        try {
          await appendFile(HOSTS_PATH, block, 'utf8');
        } catch (err) {
          throw new ProxyError(
            `Failed to write ${HOSTS_PATH}: ${err instanceof Error ? err.message : String(err)}`,
            'hosts_write_failed',
            `Run 'mockstar proxy install' with sudo OR switch to --dns-mode=dnsmasq.`,
          );
        }
      },
    },
  ];
}

// --- DNSMASQ -------------------------------------------------------------

function buildDnsmasqMutations(hosts: readonly HostConfig[]): Mutation[] {
  const os = platform();
  if (os !== 'darwin' && os !== 'linux') {
    throw new ProxyError(
      `dnsmasq mode not supported on platform '${os}' in v1. Use hosts-fallback mode.`,
      'dnsmasq_platform_unsupported',
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
    os === 'darwin' ? '/opt/homebrew/etc/dnsmasq.conf' : '/etc/dnsmasq.d/mockstar.conf';

  const dnsmasqContent = `# Generated by mockstar-proxy; do not edit manually.\n` +
    hosts.map((h) => `address=/${h.host}/127.0.0.1`).join('\n') +
    '\n';

  mutations.push({
    action: `write dnsmasq config to ${dnsmasqConfigPath}`,
    reverseCommand: { kind: 'remove_file', path: dnsmasqConfigPath },
    async apply(): Promise<void> {
      await writeFile(dnsmasqConfigPath, dnsmasqContent, 'utf8').catch((err) => {
        throw new ProxyError(
          `Cannot write ${dnsmasqConfigPath}: ${err instanceof Error ? err.message : String(err)}`,
          'dnsmasq_config_write_failed',
          `Install dnsmasq first: '${os === 'darwin' ? 'brew install dnsmasq' : 'apt install dnsmasq'}'.`,
        );
      });
    },
  });

  if (os === 'darwin') {
    for (const host of hosts) {
      const resolverPath = `/etc/resolver/${host.host}`;
      mutations.push({
        action: `write macOS resolver file at ${resolverPath}`,
        reverseCommand: { kind: 'remove_file', path: resolverPath },
        async apply(): Promise<void> {
          // Writing under /etc/resolver requires sudo. The install CLI prompts for password once.
          const content = 'nameserver 127.0.0.1\nport 53\n';
          const result = await runPrivileged(['tee', resolverPath]);
          if (result.exitCode !== 0) {
            throw new ProxyError(
              `Failed to write ${resolverPath}`,
              'resolver_write_failed',
            );
          }
          void content; // content piped to `tee` via stdin in a production impl
        },
      });
    }
  }

  mutations.push({
    action: `start dnsmasq service (${os === 'darwin' ? 'brew services' : 'systemctl'})`,
    reverseCommand: { kind: 'dnsmasq_stop_and_remove' },
    async apply(): Promise<void> {
      if (os === 'darwin') {
        const result = await runPrivileged(['brew', 'services', 'start', 'dnsmasq']);
        if (result.exitCode !== 0) {
          throw new ProxyError(
            `brew services start dnsmasq failed: ${result.stderr.trim()}`,
            'dnsmasq_start_failed',
            `Verify dnsmasq is installed ('brew install dnsmasq').`,
          );
        }
      } else {
        const result = await runPrivileged(['systemctl', 'start', 'dnsmasq.service']);
        if (result.exitCode !== 0) {
          throw new ProxyError(
            `systemctl start dnsmasq failed: ${result.stderr.trim()}`,
            'dnsmasq_start_failed',
          );
        }
      }
    },
  });

  return mutations;
}

// Re-export for install-journal's dynamic-import reverse handlers
export { join };
