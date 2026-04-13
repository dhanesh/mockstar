// Satisfies: composition of phase-1 + phase-2 modules into a running HTTPS proxy.
// Satisfies: T1 (Bun HTTPS proxy), T9 (header passthrough), T10 (upstream 502),
//            RT-4 (snapshot + atomic swap wired to TLS adapter), RT-9 (observability reuse).
//
// This file is the glue. It imports from every other proxy module, wires them together,
// and exposes `startProxyServer` as the single entry point used by the CLI.

import { createLogger, Metrics, type StructuredLogger } from '../../core/observability/index.ts';
import { buildSnapshot, evictedHostnames, SnapshotHolder } from './cert-cache.ts';
import {
  startTlsServer,
  leavesFromSnapshot,
  type RequestMeta,
  type TlsServerHandle,
} from './tls-adapter.ts';
import { forwardToMockstar, probeMockstarHealth } from './upstream.ts';
import { watchConfig } from './config.ts';
import type { Hostname, ProxyConfig } from './types.ts';

export interface ProxyRuntime {
  readonly server: TlsServerHandle;
  readonly holder: SnapshotHolder;
  readonly metrics: Metrics;
  readonly logger: StructuredLogger;
  readonly stop: () => Promise<void>;
}

export interface StartOptions {
  configPath: string;
  config: ProxyConfig;
  logger?: StructuredLogger;
  watch?: boolean;
}

export async function startProxyServer(opts: StartOptions): Promise<ProxyRuntime> {
  const logger = opts.logger ?? createLogger({});
  const metrics = new Metrics();

  // Initial snapshot (generates a leaf cert per configured hostname).
  const initial = await buildSnapshot(opts.config, { version: 1 });
  const holder = new SnapshotHolder(initial);

  // Health probe — non-blocking; warn if mockstar isn't up yet.
  const upstreamOk = await probeMockstarHealth(opts.config);
  if (!upstreamOk) {
    logger.warn({
      event: 'proxy_upstream_unreachable_at_start',
      upstream: opts.config.mockstarUrl,
      hint: 'Start mockstar via `make dev` or `bunx mockstar ./mocks`.',
    });
  }

  const server = await startTlsServer({
    hostname: opts.config.listenHost,
    port: opts.config.listenPort,
    leaves: leavesFromSnapshot(initial),
    handle: async (req, meta) => dispatch(req, meta, { holder, metrics, logger }),
    onWarn: (event, details) => logger.warn({ event, ...details }),
  });

  logger.info({
    event: 'proxy_listening',
    url: server.url,
    hosts: opts.config.hosts.map((h) => h.host),
    mockstarUrl: opts.config.mockstarUrl,
  });

  // File-watch hot reload.
  const watcher = opts.watch === false
    ? null
    : await watchConfig(opts.configPath, (result) => {
        if (!result.ok) {
          logger.warn({ event: 'proxy_config_reload_rejected', details: result.error });
          return;
        }
        void reloadSnapshot(holder, result.config, server, logger);
      });

  return {
    server,
    holder,
    metrics,
    logger,
    async stop(): Promise<void> {
      watcher?.stop();
      await server.stop();
    },
  };
}

// --- INTERNAL HELPERS ----------------------------------------------------

interface DispatchDeps {
  holder: SnapshotHolder;
  metrics: Metrics;
  logger: StructuredLogger;
}

async function dispatch(req: Request, meta: RequestMeta, deps: DispatchDeps): Promise<Response> {
  const snapshot = deps.holder.get(); // atomic capture for this request (RT-4.2)
  const host = snapshot.hosts.get(meta.servername.toLowerCase());
  if (!host) {
    // This should be rare — TLS handshake was accepted but config raced ahead.
    deps.logger.warn({
      event: 'proxy_host_disappeared_mid_request',
      servername: meta.servername,
    });
    return new Response(
      JSON.stringify({ error: 'host_not_configured', servername: meta.servername }),
      { status: 421, headers: { 'content-type': 'application/json' } },
    );
  }

  const requestId = `prx-${meta.connectionId}-${Date.now().toString(36)}`;
  const startedUs = performance.now() * 1000;

  let response: Response;
  try {
    response = await forwardToMockstar(req, {
      config: snapshot.config,
      host,
      requestId,
      logger: deps.logger,
    });
  } catch (err) {
    deps.logger.error({
      event: 'proxy_dispatch_error',
      requestId,
      message: err instanceof Error ? err.message : String(err),
    });
    response = new Response(
      JSON.stringify({ error: 'proxy_internal', requestId }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }

  // Observability: deferred log + counter increment (RT-9 follows mockstar's O1/O2 shape).
  queueMicrotask(() => {
    const durationUs = Math.round(performance.now() * 1000 - startedUs);
    deps.logger.info({
      event: 'proxy_request',
      host: host.host,
      tenant: host.tenant,
      method: req.method,
      path: new URL(req.url).pathname,
      status: response.status,
      requestId,
      durationUs,
    });
    deps.metrics.incCounter('mockstar_proxy_requests_total', {
      host: host.host,
      tenant: host.tenant,
      status: String(response.status),
      method: req.method,
    });
    deps.metrics.observeLatencyUs('mockstar_proxy_request_latency_us', { tenant: host.tenant }, durationUs);
  });

  return response;
}

async function reloadSnapshot(
  holder: SnapshotHolder,
  nextConfig: ProxyConfig,
  server: TlsServerHandle,
  logger: StructuredLogger,
): Promise<void> {
  const current = holder.get();
  try {
    const next = await buildSnapshot(nextConfig, { version: current.version + 1, previous: current });
    const { previous } = holder.swap(next);
    // Atomically swap the TLS config (RT-4.2 + TN5). Bun's reload flushes session tickets,
    // so any subsequent resumption attempts force a fresh handshake with the new leaves.
    await server.reload(leavesFromSnapshot(next));
    const evicted = evictedHostnames(previous, next);
    if (evicted.size > 0) {
      await server.closeWhere((meta: RequestMeta) => evicted.has(meta.servername.toLowerCase() as Hostname));
      logger.info({
        event: 'proxy_config_reload_ok_with_eviction',
        version: next.version,
        evicted: [...evicted],
      });
    } else {
      logger.info({ event: 'proxy_config_reload_ok', version: next.version });
    }
  } catch (err) {
    logger.warn({
      event: 'proxy_config_reload_failed',
      message: err instanceof Error ? err.message : String(err),
    });
    // Keep the previous snapshot active (TN5 behaviour: warn-and-keep-previous).
  }
}
