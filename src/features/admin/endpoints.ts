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

  // Per-tenant mock list — tenant-scope only.
  app.get(
    '/__admin/tenants/:tenant/mocks',
    adminAuthMiddleware({ snapshot: (): ReturnType<SnapshotHolder['get']> => deps.holder.get(), scope: 'tenant' }),
    (ctx: Context) => {
      const tenant = ctx.req.param('tenant');
      const snap = deps.holder.get();
      const tenantSnap = snap?.tenants.get(tenant);
      if (!tenantSnap) return ctx.json({ error: 'tenant_not_found', tenant }, 404);
      const mocks = tenantSnap.entries.map((e) => {
        // Collect the attribute keys targeted by each scenario rule (U4 — values omitted to avoid leaking test data).
        const scenarioAttributes: string[] = [];
        if (e.scenarios) {
          for (const rule of e.scenarios) {
            for (const ns of ['params', 'query', 'headers', 'body'] as const) {
              const dim = rule.when[ns];
              if (dim) for (const key of Object.keys(dim)) scenarioAttributes.push(`${ns}.${key}`);
            }
          }
        }
        return {
          id: e.id,
          method: e.match.method,
          path: e.match.path,
          priority: e.match.priority ?? 0,
          kind: e.response.kind,
          ...(e.response.kind === 'passthrough' ? { upstream: e.response.upstream } : {}),
          ...(e.response.kind === 'dynamic' ? { handler: e.response.handler } : {}),
          scenarioCount: e.scenarios?.length ?? 0,
          ...(scenarioAttributes.length > 0 && { scenarioAttributes }),
        };
      });
      return ctx.json({ tenant, count: mocks.length, mocks });
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
