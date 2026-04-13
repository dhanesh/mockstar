// Satisfies: RT-10 (install detects environment hostility with remediation-specific errors)
// Satisfies: U5, S4, O6
//
// Runs at install time. Each detector returns null (clean) or an EnvHostility with a
// specific remediation message. install aborts on any detector hit unless --force.

import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { EnvHostility } from './types.ts';

// --- PUBLIC API ----------------------------------------------------------

export async function detectEnvHostility(): Promise<EnvHostility> {
  // Order matters: CI/container check first (fastest, highest severity), then platform-specific.
  const ci = detectCiOrContainer();
  if (ci) return ci;

  const port443 = await detectPort443Bound();
  if (port443) return port443;

  if (platform() === 'darwin') {
    const mdm = await detectMacosMdm();
    if (mdm) return mdm;
    const vpn = await detectMacosVpnResolver();
    if (vpn) return vpn;
  }

  if (platform() === 'linux') {
    const vpn = await detectLinuxVpnResolver();
    if (vpn) return vpn;
  }

  return { kind: 'clean' };
}

/**
 * Map an EnvHostility result to a specific remediation message. (RT-10.2)
 */
export function remediationMessage(h: EnvHostility): string {
  switch (h.kind) {
    case 'clean':
      return 'Environment looks clean. Proceeding with install.';
    case 'containerized-or-ci':
      return (
        `Detected CI or container environment (${h.detail}). ` +
        `mockstar proxy is a developer-laptop tool; installing a dev CA in CI is explicitly ` +
        `disallowed (S4). If you're running tests that need HTTPS mocks, consider using the ` +
        `library-embed API (createServer) with mockstar's HTTP interface directly instead.`
      );
    case 'port-443-bound':
      return (
        `Port 443 is already bound on 127.0.0.1 (${h.detail}). ` +
        `Stop the conflicting process (commonly nginx, Apache, another proxy, or Docker) and retry. ` +
        `Run 'sudo lsof -i :443' to see the culprit.`
      );
    case 'mdm-managed':
      return (
        `Managed MDM profile detected (${h.detail}). ` +
        `Installing a dev CA may conflict with corporate policy and trigger a profile revert. ` +
        `Options: (a) coordinate with IT to allowlist 'mockstar-dev-ca'; (b) use /etc/hosts fallback mode; ` +
        `(c) re-run with --force (not recommended on managed fleets).`
      );
    case 'vpn-resolver-override':
      return (
        `Your DNS resolver is being rewritten by a VPN or privacy tool (${h.detail}). ` +
        `dnsmasq install may work but silently fail on reconnect. Recommended: use /etc/hosts ` +
        `fallback mode via 'mockstar proxy install --dns-mode=hosts'.`
      );
  }
}

// --- DETECTORS -----------------------------------------------------------

function detectCiOrContainer(): EnvHostility | null {
  if (process.env.CI === 'true') return { kind: 'containerized-or-ci', detail: 'CI=true' };
  if (process.env.GITHUB_ACTIONS === 'true')
    return { kind: 'containerized-or-ci', detail: 'GITHUB_ACTIONS=true' };
  if (process.env.CIRCLECI === 'true')
    return { kind: 'containerized-or-ci', detail: 'CIRCLECI=true' };
  if (process.env.BUILDKITE === 'true')
    return { kind: 'containerized-or-ci', detail: 'BUILDKITE=true' };
  if (process.env.container) return { kind: 'containerized-or-ci', detail: `container=${process.env.container}` };
  return null;
}

async function detectPort443Bound(): Promise<EnvHostility | null> {
  // lsof is present on macOS and most Linuxes. Failure to run lsof is not itself
  // a hostility signal — we silently skip if lsof is missing.
  const result = await runCmd('lsof', ['-i', ':443', '-sTCP:LISTEN', '-t']).catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  const pids = result.stdout.trim().split('\n').filter((x) => x.length > 0);
  if (pids.length === 0) return null;
  return { kind: 'port-443-bound', detail: `held by pid(s) ${pids.join(',')}` };
}

async function detectMacosMdm(): Promise<EnvHostility | null> {
  // `profiles list -type enrollment` is the canonical check on macOS.
  // It exits 0 if MDM-enrolled, non-zero if not (and also on permissions errors).
  const result = await runCmd('profiles', ['status', '-type', 'enrollment']).catch(() => null);
  if (!result) return null;
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (combined.includes('mdm enrollment: yes') || combined.includes('enrolled via dep')) {
    return { kind: 'mdm-managed', detail: 'profiles enrollment active' };
  }
  return null;
}

async function detectMacosVpnResolver(): Promise<EnvHostility | null> {
  const result = await runCmd('scutil', ['--dns']).catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  // Heuristic: more than one "resolver #N" block with a "search domain" entry
  // suggests VPN/corporate DNS override.
  const resolverCount = (result.stdout.match(/^resolver #/gm) ?? []).length;
  const hasSearchDomains = /search domain\[\d+\]/m.test(result.stdout);
  if (resolverCount >= 3 && hasSearchDomains) {
    return { kind: 'vpn-resolver-override', detail: `scutil reports ${resolverCount} resolvers with search domains` };
  }
  return null;
}

async function detectLinuxVpnResolver(): Promise<EnvHostility | null> {
  // systemd-resolved check: `resolvectl status` shows per-link DNS.
  const result = await runCmd('resolvectl', ['status']).catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  // Heuristic: "Current DNS Server" entries on link that isn't the default.
  if (/tun[0-9]+/i.test(result.stdout) || /openvpn|wireguard/i.test(result.stdout)) {
    return { kind: 'vpn-resolver-override', detail: 'VPN tunnel detected in resolvectl output' };
  }
  return null;
}

function runCmd(
  cmd: string,
  argv: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv as string[], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}
