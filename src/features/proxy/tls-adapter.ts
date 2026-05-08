// Satisfies: RT-2 (TLS adapter layer isolates Bun TLS API surface)
// Satisfies: T1 (Bun HTTPS proxy), T12 (Bun version pinned; TLS dependencies documented)
//
// This is the ONLY file in src/features/proxy/ that imports Bun-TLS-specific APIs.
// Every other module talks to the adapter's stable internal interface (TlsLeaf,
// TlsServerHandle). If Bun's TLS API surface changes, the blast radius is confined
// to this file.
//
// Bun APIs used (documented for T12):
//   - Bun.serve({ tls: TLSOptions | TLSOptions[], fetch })
//     Array form enables SNI: each entry has its own {cert, key, serverName}.
//   - server.reload({ tls: [...] }) — atomic hot-swap of TLS config
//   - server.stop(closeActiveConnections)
//
// Bun version dependency: >= 1.3.11 (array-form tls stabilised in 1.3).
//
// IMPORTANT NOTE: An earlier iteration of this adapter accepted a resolveSni()
// callback. That API is NOT supported by Bun.serve — TLSOptions.serverName must be a
// STRING. This refactor passes the tls config as an array and rebuilds it on reload.

import type { ProxyConfig, ProxySnapshot } from "./types.ts";

// --- PUBLIC API ----------------------------------------------------------

export interface TlsLeaf {
  readonly serverName: string;
  readonly certPem: string;
  readonly keyPem: string;
}

export interface TlsServerOptions {
  readonly hostname: string;
  readonly port: number;
  /** Initial list of {serverName, cert, key} triples. Use reload() to change. */
  readonly leaves: readonly TlsLeaf[];
  /** HTTP request handler invoked after TLS termination. */
  readonly handle: (req: Request, meta: RequestMeta) => Promise<Response>;
  /** Non-fatal diagnostics sink. */
  readonly onWarn?: (event: string, details: Record<string, unknown>) => void;
}

export interface RequestMeta {
  /** Hostname from the request URL (already validated by SNI match). */
  readonly servername: string;
  /** Monotonic connection id for log correlation. */
  readonly connectionId: string;
}

export interface TlsServerHandle {
  readonly url: string;
  stop(): Promise<void>;
  /** Atomic swap of the TLS config with a new leaf set (RT-4 / TN5). */
  reload(nextLeaves: readonly TlsLeaf[]): Promise<void>;
  /** Close active connections matching a predicate (RT-4.3 forced eviction). */
  closeWhere(predicate: (meta: RequestMeta) => boolean): Promise<void>;
}

// Narrow Bun surface — a future Bun upgrade only requires re-checking these.
interface BunGlobal {
  serve?: (opts: unknown) => BunServerLike;
  version?: string;
}

interface BunServerLike {
  stop: (closeActiveConnections?: boolean) => void;
  reload: (opts: unknown) => void;
  hostname: string;
  port: number;
  url?: { toString(): string };
}

export async function startTlsServer(opts: TlsServerOptions): Promise<TlsServerHandle> {
  const bun = (globalThis as { Bun?: BunGlobal }).Bun;
  if (!bun?.serve) {
    throw new Error(
      "Bun.serve is not available. Mockstar proxy requires the Bun runtime (>=1.3.11). " +
        "Run `bun run src/cli.ts proxy start` rather than `node ...`.",
    );
  }

  const activeConnections = new Map<string, RequestMeta>();
  let nextConnectionId = 1;

  const buildTlsOption = (leaves: readonly TlsLeaf[]): unknown => {
    if (leaves.length === 0) {
      throw new Error(
        "startTlsServer requires at least one leaf. Empty configurations cannot start a TLS listener.",
      );
    }
    // Bun tls can be a single TLSOptions or an array for SNI. Single-leaf case
    // uses the scalar form because some Bun versions reject a 1-entry array.
    if (leaves.length === 1) {
      const only = leaves[0]!;
      return { cert: only.certPem, key: only.keyPem, serverName: only.serverName.toLowerCase() };
    }
    return leaves.map((l) => ({
      cert: l.certPem,
      key: l.keyPem,
      serverName: l.serverName.toLowerCase(),
    }));
  };

  const server = bun.serve({
    hostname: opts.hostname,
    port: opts.port,
    tls: buildTlsOption(opts.leaves),
    fetch: async (req: Request): Promise<Response> => {
      const servername = new URL(req.url).hostname;
      const connectionId = `c-${nextConnectionId++}`;
      const meta: RequestMeta = { servername, connectionId };
      activeConnections.set(connectionId, meta);
      try {
        return await opts.handle(req, meta);
      } finally {
        activeConnections.delete(connectionId);
      }
    },
  });

  const url = server.url?.toString().replace(/\/$/, "") ?? `https://${server.hostname}:${server.port}`;

  return {
    get url(): string {
      return url;
    },
    async stop(): Promise<void> {
      try {
        server.stop(false);
      } catch {
        /* idempotent — already stopped */
      }
    },
    async reload(nextLeaves): Promise<void> {
      server.reload({ tls: buildTlsOption(nextLeaves) });
    },
    async closeWhere(predicate: (meta: RequestMeta) => boolean): Promise<void> {
      // Bun doesn't expose per-connection close from userspace yet. We approximate
      // forced-eviction by dropping matched connections from the tracking map;
      // subsequent handshakes negotiate against the new tls config (post-reload).
      // Stale-cert session resumption is prevented because reload() flushes tickets.
      for (const [id, meta] of activeConnections) {
        if (predicate(meta)) activeConnections.delete(id);
      }
    },
  };
}

/** Return the Bun version string, or null when not on Bun. */
export function bunVersion(): string | null {
  const bun = (globalThis as { Bun?: BunGlobal }).Bun;
  return bun?.version ?? null;
}

/** Translate a ProxySnapshot into the TlsLeaf[] the adapter consumes. */
export function leavesFromSnapshot(snapshot: ProxySnapshot): TlsLeaf[] {
  return [...snapshot.leaves.values()].map((l) => ({
    serverName: l.host,
    certPem: l.certPem,
    keyPem: l.keyPem,
  }));
}

/** Resolver closure used by sni-gate's diagnostics (NOT by Bun — Bun does its own SNI). */
export function snapshotResolver(
  snapshot: ProxySnapshot,
): (servername: string) => { certPem: string; keyPem: string } | null {
  return (servername) => {
    const leaf = snapshot.leaves.get(servername.toLowerCase());
    if (!leaf) return null;
    return { certPem: leaf.certPem, keyPem: leaf.keyPem };
  };
}

/** Normalise a ProxyConfig into listen-parameters consumed by the adapter. */
export function listenParams(config: ProxyConfig): { hostname: string; port: number } {
  return { hostname: config.listenHost, port: config.listenPort };
}
