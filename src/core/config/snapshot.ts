// Satisfies: RT-5 (immutable config snapshots with atomic swap)
// Satisfies: T11 (config hot-swap atomicity — in-flight requests see consistent snapshot)

import type { HandlerRegistry } from '../handlers/index.ts';
import type { MatchIndex } from '../matching/index.ts';
import type { CompiledResponse } from '../templating/compiler.ts';
import type { Entry, Server, Tenant } from './schema.ts';

export interface TenantSnapshot {
  readonly name: string;
  readonly entries: readonly Entry[];
  /** Precomputed match index (RT-6.1). */
  readonly matchIndex: MatchIndex;
  /** Response bodies compiled from templates at load time (RT-6.2). */
  readonly compiledResponses: ReadonlyMap<string, CompiledResponse>;
  readonly limits: Tenant['limits'];
  readonly adminToken?: string;
  readonly allowPrivateUpstreams: boolean;
}

export interface ConfigSnapshot {
  readonly version: number; // monotonically incremented on each successful reload
  readonly server: Server;
  readonly tenants: ReadonlyMap<string, TenantSnapshot>;
  readonly handlers: HandlerRegistry;
}

/**
 * Atomic snapshot holder. Readers call `get()` exactly once per request and
 * retain that reference for the request lifetime (RT-5.3).
 *
 * Replacing the snapshot is a single assignment — in-flight readers keep
 * the old reference. Old snapshots are garbage-collected when the last
 * reader completes.
 */
export class SnapshotHolder {
  #current: ConfigSnapshot;

  constructor(initial: ConfigSnapshot) {
    this.#current = Object.freeze(initial);
  }

  get(): ConfigSnapshot {
    return this.#current;
  }

  /**
   * Replace the active snapshot. Atomic from a reader's perspective: a
   * request that has already captured the previous snapshot continues to
   * see it; subsequent requests see the new one. (RT-5.2)
   */
  swap(next: ConfigSnapshot): ConfigSnapshot {
    const previous = this.#current;
    this.#current = Object.freeze(next);
    return previous;
  }

  /**
   * Partial swap: replace a single tenant's snapshot, leaving others
   * untouched. Preserves per-tenant reload isolation (T8, RT-5.4).
   */
  swapTenant(tenantName: string, nextTenant: TenantSnapshot): void {
    const tenants = new Map(this.#current.tenants);
    tenants.set(tenantName, nextTenant);
    this.#current = Object.freeze({
      ...this.#current,
      version: this.#current.version + 1,
      tenants,
    });
  }
}
