// Public library API.
// Satisfies: U2 (library embed distribution channel)

import { resolve } from "node:path";
import { SnapshotHolder, loadSnapshot, parseServerConfig, startWatcher } from "./core/config/index.ts";
import { buildHandlerRegistry } from "./core/handlers/index.ts";
import { type StructuredLogger, createLogger } from "./core/observability/index.ts";
import { preflight } from "./core/preflight.ts";
import { type CreateServerOptions, type RunningServer, createServer } from "./server.ts";

export interface LaunchOptions {
  configRoot: string;
  handlersDir?: string;
  server?: Record<string, unknown>;
  deterministic?: boolean;
  logger?: StructuredLogger;
  installCrashHandlers?: boolean;
  watch?: boolean;
  handlerTimeoutMs?: number;
  /** B5/TN5: honour X-Mockstar-Webhook-Url request header. Default false. */
  allowWebhookUrlHeader?: boolean;
  /** INT-1: optional JSONL append-only log of webhook deliveries (post-restart forensic replay). */
  webhookJournalFile?: string;
}

export interface Launched {
  readonly server: RunningServer;
  readonly stop: () => Promise<void>;
  readonly holder: SnapshotHolder;
}

/**
 * Bootstrap a Mockstar instance. Returns the composed Hono app plus a `stop()`
 * to tear down watchers and handlers.
 */
export async function launch(opts: LaunchOptions): Promise<Launched> {
  const logger = opts.logger ?? createLogger({ deterministic: opts.deterministic });

  // O6 preflight — warn (don't fail) library embedders on old Bun or non-Bun runtimes.
  const pf = preflight();
  if (pf.warning)
    logger.warn({ event: "preflight_warning", detected: pf.detected, min: pf.min, message: pf.warning });

  const configRoot = resolve(opts.configRoot);
  const handlersDir = resolve(opts.handlersDir ?? resolve(configRoot, "..", "handlers"));

  // RT-1 FIRST — handler registry is the structural prerequisite.
  const handlers = await buildHandlerRegistry(handlersDir);
  logger.info({ event: "handlers_loaded", count: handlers.size, dir: handlersDir });

  const serverConfig = parseServerConfig({ ...(opts.server ?? {}), deterministic: opts.deterministic });
  const initial = await loadSnapshot({ configRoot, server: serverConfig, handlers });
  const holder = new SnapshotHolder(initial);

  const server = createServer({
    holder,
    registry: handlers,
    logger,
    deterministic: opts.deterministic,
    installCrashHandlers: opts.installCrashHandlers,
    handlerTimeoutMs: opts.handlerTimeoutMs,
    allowWebhookUrlHeader: opts.allowWebhookUrlHeader,
    webhookJournalFile: opts.webhookJournalFile,
  });

  const watcher =
    opts.watch !== false && !opts.deterministic
      ? startWatcher({
          configRoot,
          holder,
          handlers,
          onReload: (tenant, result, details): void => {
            if (result === "ok") logger.info({ event: "config_reload_ok", tenant });
            else logger.warn({ event: "config_reload_rejected", tenant, details });
          },
        })
      : null;

  return {
    server,
    holder,
    async stop(): Promise<void> {
      watcher?.stop();
      server.uninstallCrashHandlers();
    },
  };
}

export type { RunningServer, CreateServerOptions } from "./server.ts";
export { SnapshotHolder } from "./core/config/index.ts";
