// Satisfies: T8 (per-tenant-scoped file-watch hot reload)
// Satisfies: RT-5.4 (per-tenant reload isolation)
// Satisfies: T7 (warn-and-keep-previous on invalid reload)

import { watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import type { HandlerRegistry } from '../handlers/index.ts';
import { loadTenant } from './loader.ts';
import type { SnapshotHolder } from './snapshot.ts';

export interface WatcherOptions {
  configRoot: string;
  holder: SnapshotHolder;
  handlers: HandlerRegistry;
  onReload?: (tenant: string, result: 'ok' | 'rejected', details?: string) => void;
  debounceMs?: number;
}

export function startWatcher(opts: WatcherOptions): { stop: () => void } {
  const debounce = opts.debounceMs ?? 250;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const watchers: FSWatcher[] = [];

  const snapshot = opts.holder.get();
  for (const tenant of snapshot.tenants.keys()) {
    const dir = resolve(opts.configRoot, tenant);
    const w = watch(dir, { recursive: true }, (_event, _filename) => {
      const existing = timers.get(tenant);
      if (existing) clearTimeout(existing);
      timers.set(
        tenant,
        setTimeout(() => {
          void reloadTenant(tenant, dir, opts);
        }, debounce),
      );
    });
    watchers.push(w);
  }

  return {
    stop(): void {
      for (const t of timers.values()) clearTimeout(t);
      for (const w of watchers) w.close();
    },
  };
}

async function reloadTenant(tenant: string, dir: string, opts: WatcherOptions): Promise<void> {
  try {
    const next = await loadTenant(dir, tenant, opts.handlers);
    opts.holder.swapTenant(tenant, next);
    opts.onReload?.(tenant, 'ok');
  } catch (err) {
    // Warn-and-keep-previous: existing snapshot remains active (T7).
    const message = err instanceof Error ? err.message : String(err);
    opts.onReload?.(tenant, 'rejected', message);
  }
}
