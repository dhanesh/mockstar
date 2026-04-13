// Satisfies: RT-3 (tiers 2-4 of TN2 — crash-only design)
// Satisfies: T10, O4, O6 — process-level hooks + /ready flip + orchestrator restart

import type { StructuredLogger } from '../observability/logger.ts';

export interface ProcessBoundaryOptions {
  logger: StructuredLogger;
  /** Callback to flip /ready to 503. */
  setReady: (ready: boolean) => void;
  /** Graceful-exit delay so the log flushes and /ready drains. */
  drainMs?: number;
  /** Called instead of process.exit for testability. */
  exit?: (code: number) => void;
}

/**
 * Install process-level crash handlers. Fire-and-forget promise rejections
 * and truly uncatchable errors log + flip /ready + exit. The orchestrator
 * restarts (documented prod requirement — RT-3.3).
 */
export function installProcessHandlers(opts: ProcessBoundaryOptions): () => void {
  const drainMs = opts.drainMs ?? 1000;
  const exit = opts.exit ?? ((code): void => {
    process.exit(code);
  });

  const onUnhandled = (reason: unknown, kind: 'unhandledRejection' | 'uncaughtException'): void => {
    opts.logger.error({
      event: 'process_fault',
      kind,
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    opts.setReady(false);
    setTimeout(() => exit(1), drainMs).unref?.();
  };

  const rejHandler = (reason: unknown): void => onUnhandled(reason, 'unhandledRejection');
  const excHandler = (err: Error): void => onUnhandled(err, 'uncaughtException');

  process.on('unhandledRejection', rejHandler);
  process.on('uncaughtException', excHandler);

  return (): void => {
    process.off('unhandledRejection', rejHandler);
    process.off('uncaughtException', excHandler);
  };
}
