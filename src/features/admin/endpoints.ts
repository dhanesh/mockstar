// Satisfies: O2 (metrics endpoint), O3 (journal endpoint), O4 (health/ready)

import { Hono, type Context } from 'hono';
import type { JournalRegistry } from '../../core/journal/index.ts';
import type { Metrics } from '../../core/observability/index.ts';
import type { SnapshotHolder } from '../../core/config/snapshot.ts';
import { adminAuthMiddleware } from './auth.ts';

export interface AdminDeps {
  holder: SnapshotHolder;
  journal: JournalRegistry;
  metrics: Metrics;
  ready: { current: () => boolean; set: (v: boolean) => void };
}

export function adminRouter(deps: AdminDeps): Hono {
  const app = new Hono();

  // Health — always unauthenticated (RT-3 requirement: /health stays 200 until exit).
  app.get('/health', (ctx) => ctx.json({ status: 'ok' }));

  // Ready — flips to 503 on process-level fault (RT-3.2).
  app.get('/ready', (ctx) => {
    const ready = deps.ready.current();
    ctx.status(ready ? 200 : 503);
    return ctx.json({ ready });
  });

  // Metrics — root-scope only (RT-7.2).
  app.get(
    '/metrics',
    adminAuthMiddleware({ snapshot: (): ReturnType<SnapshotHolder['get']> => deps.holder.get(), scope: 'root' }),
    (ctx) => {
      ctx.header('content-type', 'text/plain; version=0.0.4');
      return ctx.body(deps.metrics.format());
    },
  );

  // Per-tenant journal — tenant-scope only (RT-7.1).
  app.get(
    '/__admin/tenants/:tenant/journal',
    adminAuthMiddleware({ snapshot: (): ReturnType<SnapshotHolder['get']> => deps.holder.get(), scope: 'tenant' }),
    (ctx: Context) => {
      const tenant = ctx.req.param('tenant');
      const entries = deps.journal.snapshot(tenant);
      return ctx.json({ tenant, count: entries.length, entries });
    },
  );

  return app;
}
