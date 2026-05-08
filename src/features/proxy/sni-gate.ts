// Satisfies: RT-3 (SNI-to-hostname allowlist is the exclusive cert-issuance gate)
// Satisfies: T3, T4, S3
//
// Paired with tls-adapter's SniResolver. Given the current snapshot and an incoming
// SNI hostname, return the leaf to present OR null to reject the handshake.

import { snapshotResolver, type SniResolver } from "./tls-adapter.ts";
import type { SnapshotHolder } from "./cert-cache.ts";

/**
 * Build an SniResolver that ALWAYS reads the current snapshot (captured per-call,
 * not per-closure-build). This keeps it safe to pass to the TLS adapter and have
 * it reflect reloads.
 */
export function sniGate(holder: SnapshotHolder): SniResolver {
  return (servername: string) => {
    const resolver = snapshotResolver(holder.get());
    return resolver(servername.toLowerCase());
  };
}

/**
 * For diagnostics: given a hostname and the current snapshot, explain why
 * we'd accept or reject. Useful for `mockstar proxy status --explain-sni`.
 */
export function explainSni(
  holder: SnapshotHolder,
  servername: string,
): { accepted: boolean; reason: string } {
  const snap = holder.get();
  const h = servername.toLowerCase();
  if (!snap.hosts.has(h)) {
    return {
      accepted: false,
      reason: `Hostname '${servername}' is not in the configured hosts list (${[...snap.hosts.keys()].join(", ")}). Add it to the config file and reload.`,
    };
  }
  const leaf = snap.leaves.get(h);
  if (!leaf) {
    return {
      accepted: false,
      reason: `Hostname '${servername}' is configured but no leaf cert has been generated yet. This is a bug — report it.`,
    };
  }
  if (leaf.expiresAt < Date.now()) {
    return {
      accepted: false,
      reason: `Leaf cert for '${servername}' expired at ${new Date(leaf.expiresAt).toISOString()}. Run 'mockstar proxy reload' to regenerate.`,
    };
  }
  return {
    accepted: true,
    reason: `Host in allowlist; leaf cert valid until ${new Date(leaf.expiresAt).toISOString()}.`,
  };
}
