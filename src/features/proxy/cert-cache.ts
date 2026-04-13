// Satisfies: RT-4 (leaf 24h TTL + versioned snapshots + atomic swap + forced eviction on reload)
// Satisfies: T3, T5, O5 (TN4, TN5, TN7 resolutions)
// Priority: structural (RT-4 is the secondary structural prereq; T5 blocks T8)
//
// Shape:
//   - a pinned "snapshot" object holds the current hostname->leaf map + version
//   - callers capture the snapshot pointer once per connection (RT-4.2 atomicity)
//   - config reload builds a new snapshot and swap()s the pointer
//   - reload also triggers forced-close on connections matching evicted hostnames
//     (RT-4.3 — implemented via a predicate passed to tls-adapter's closeWhere)

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateLeaf } from './ca.ts';
import type { Hostname, HostConfig, LeafCert, ProxyConfig, ProxySnapshot } from './types.ts';

// --- PUBLIC API ----------------------------------------------------------

export class SnapshotHolder {
  #current: ProxySnapshot;

  constructor(initial: ProxySnapshot) {
    this.#current = Object.freeze(initial);
  }

  /** Atomic reader: callers capture this once per connection (RT-4.2). */
  get(): ProxySnapshot {
    return this.#current;
  }

  /**
   * Pointer-swap. Returns (previous, next) so the caller can diff and drive
   * forced-close on evicted hostnames.
   */
  swap(next: ProxySnapshot): { previous: ProxySnapshot; next: ProxySnapshot } {
    const previous = this.#current;
    this.#current = Object.freeze(next);
    return { previous, next };
  }
}

/**
 * Build an initial snapshot from config: generates leaves for every configured host.
 * Called once at startup; re-called on reload to build the next snapshot.
 */
export async function buildSnapshot(
  config: ProxyConfig,
  options: { version: number; previous?: ProxySnapshot },
): Promise<ProxySnapshot> {
  const hosts = new Map<Hostname, HostConfig>();
  for (const h of config.hosts) {
    hosts.set(h.host.toLowerCase(), h);
  }

  const leaves = new Map<Hostname, LeafCert>();
  const scratchDir = await mkdtemp(join(tmpdir(), 'mockstar-leaves-'));
  try {
    for (const hostname of hosts.keys()) {
      // RT-4.4: if the previous snapshot has a non-expired leaf for this hostname
      // AND the hostname was in the previous snapshot's hosts too, we can reuse it.
      // Otherwise, mint a new one.
      const existing = options.previous?.leaves.get(hostname);
      const reusable =
        existing && options.previous?.hosts.has(hostname) && existing.expiresAt > Date.now() + 5 * 60_000;
      if (reusable) {
        leaves.set(hostname, { ...existing, snapshotVersion: options.version });
      } else {
        const { certPem, keyPem, expiresAt } = await generateLeaf(hostname, {
          ttlHours: config.leafTtlHours,
          scratchDir,
        });
        leaves.set(hostname, {
          host: hostname,
          certPem,
          keyPem,
          expiresAt,
          snapshotVersion: options.version,
        });
      }
    }
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }

  return Object.freeze({
    version: options.version,
    hosts,
    leaves,
    config,
  });
}

/**
 * Given two snapshots, return the set of hostnames present in `previous` but not in `next`.
 * Used by the reload orchestrator to force-close connections on evicted hostnames (RT-4.3).
 */
export function evictedHostnames(previous: ProxySnapshot, next: ProxySnapshot): Set<Hostname> {
  const out = new Set<Hostname>();
  for (const h of previous.hosts.keys()) {
    if (!next.hosts.has(h)) out.add(h);
    else {
      // Also evict if the cert changed (e.g. the TTL elapsed and we regenerated).
      const prevLeaf = previous.leaves.get(h);
      const nextLeaf = next.leaves.get(h);
      if (prevLeaf && nextLeaf && prevLeaf.certPem !== nextLeaf.certPem) {
        out.add(h);
      }
    }
  }
  return out;
}

/**
 * Is the given leaf due for renewal soon? Returns true when expiry is within
 * the refresh window (default: 1 hour). Used by a background refresh task.
 */
export function needsRefresh(leaf: LeafCert, windowMs = 60 * 60_000): boolean {
  return leaf.expiresAt < Date.now() + windowMs;
}
