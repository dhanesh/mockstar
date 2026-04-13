// Satisfies: shared types for the proxy subsystem (structural)
// Isolates downstream files from cross-importing the same shapes.

export type TenantName = string;
export type Hostname = string;

export interface HostConfig {
  /** Real hostname to intercept, e.g. "api.razorpay.com". */
  readonly host: Hostname;
  /** Mockstar tenant this hostname maps to. */
  readonly tenant: TenantName;
}

export interface ProxyConfig {
  /** The ordered list of hostnames this proxy accepts + the tenant each maps to. */
  readonly hosts: readonly HostConfig[];
  /** Upstream mockstar URL (HTTP). Default http://127.0.0.1:3000. */
  readonly mockstarUrl: string;
  /** Listen host (must be 127.0.0.1 per S2). */
  readonly listenHost: string;
  /** Listen port (443 per RT-6). */
  readonly listenPort: number;
  /** Upstream request timeout in ms (T10). */
  readonly upstreamTimeoutMs: number;
  /** Leaf cert TTL in hours (RT-4.1; 24 per TN4). */
  readonly leafTtlHours: number;
  /** DNS strategy — set by env detection at install time. */
  readonly dnsMode: 'dnsmasq' | 'hosts-fallback';
}

export interface LeafCert {
  readonly host: Hostname;
  /** PEM-encoded cert. */
  readonly certPem: string;
  /** PEM-encoded key. */
  readonly keyPem: string;
  /** Unix-ms of NotAfter. */
  readonly expiresAt: number;
  /** Snapshot version that issued this cert (RT-4.2). */
  readonly snapshotVersion: number;
}

export interface ProxySnapshot {
  readonly version: number;
  readonly hosts: ReadonlyMap<Hostname, HostConfig>;
  readonly leaves: ReadonlyMap<Hostname, LeafCert>;
  readonly config: ProxyConfig;
}

export type EnvHostility =
  | { kind: 'clean' }
  | { kind: 'mdm-managed'; detail: string }
  | { kind: 'vpn-resolver-override'; detail: string }
  | { kind: 'port-443-bound'; detail: string }
  | { kind: 'containerized-or-ci'; detail: string };

/** A single recorded mutation in the install journal (RT-7). */
export interface InstallStep {
  readonly step: number;
  readonly timestamp: string; // ISO
  readonly action: string;    // human-readable description
  readonly reverseCommand: ReverseCommand;
  /** SHA-256 of {step, timestamp, action, reverseCommand} JSON. */
  readonly checksum: string;
}

/**
 * A reverse command is a structured, replayable instruction.
 * We deliberately avoid embedding literal shell strings so we can sanitise
 * arguments at replay time and because shell quoting is a footgun.
 */
export type ReverseCommand =
  | { kind: 'mkcert_uninstall' }
  | { kind: 'remove_file'; path: string }
  | { kind: 'remove_dir'; path: string }
  | { kind: 'revert_file'; path: string; originalContent: string }
  | { kind: 'dnsmasq_stop_and_remove' }
  | { kind: 'revert_hosts_entries'; blockMarker: string }
  | { kind: 'setcap_drop'; path: string }
  | { kind: 'launchctl_unload_and_remove'; plistPath: string }
  | { kind: 'noop'; reason: string };

export class ProxyError extends Error {
  constructor(message: string, public readonly code: string, public readonly hint?: string) {
    super(message);
    this.name = 'ProxyError';
  }
}
