// NOT wired into the running TLS server — see tls-adapter.ts's own doc comment.
// Bun.serve's `tls` option only accepts an array of {cert, key, serverName} triples
// (no resolveSni() callback), so the actual RT-3 gate at runtime is Bun's own SNI
// matching against that array (built by tls-adapter's leavesFromSnapshot) plus the
// post-handshake servername-vs-snapshot check in proxy/server.ts's dispatch()
// (`snapshot.hosts.get(meta.servername)`). This module is a pure-function
// diagnostics helper (sniGate/explainSni) kept for its unit-test coverage and
// exported from the proxy barrel; it does not itself accept or reject a connection.
// Satisfies: T3, T4, S3
//
// Given the current snapshot and an incoming SNI hostname, return the leaf that
// WOULD be presented OR null to indicate the handshake WOULD be rejected — matches
// the semantics of the array-form TLS config, without executing on the live path.

import type { SnapshotHolder } from "./cert-cache.ts";
import { type SniResolver, snapshotResolver } from "./tls-adapter.ts";

/**
 * Build an SniResolver that ALWAYS reads the current snapshot (captured per-call,
 * not per-closure-build). Not consumed by Bun.serve (see file header) — exported
 * for callers that want to reproduce the SNI decision outside the live TLS path.
 */
export function sniGate(holder: SnapshotHolder): SniResolver {
  return (servername: string) => {
    const resolver = snapshotResolver(holder.get());
    return resolver(servername.toLowerCase());
  };
}

/**
 * For diagnostics: given a hostname and the current snapshot, explain why
 * we'd accept or reject. Not currently wired to any CLI command — no
 * `mockstar proxy status --explain-sni` flag exists yet.
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
