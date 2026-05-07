// Satisfies: O2 (metrics endpoint), O3 (journal endpoint), O4 (health/ready)
// Satisfies: O4 (webhook list/journal/replay/await endpoints), U1 (sync await), U3 (secret redaction)
// Satisfies: RT-13 (admin router hosts /webhooks/*), TN3 (await on separate request lifecycle), TN7 (replay scope = ring-buffer-resident)

import { Hono, type Context } from 'hono';
import type { JournalRegistry } from '../../core/journal/index.ts';
import type { Metrics } from '../../core/observability/index.ts';
import type { SnapshotHolder } from '../../core/config/snapshot.ts';
import type { DeliveryEventRegistry, WebhookJournalRegistry } from '../webhooks/index.ts';
import type { ReplayResult } from '../../server.ts';
import { adminAuthMiddleware } from './auth.ts';

export interface AdminDeps {
  holder: SnapshotHolder;
  journal: JournalRegistry;
  metrics: Metrics;
  ready: { current: () => boolean; set: (v: boolean) => void };
  webhookJournal?: WebhookJournalRegistry;
  webhookEvents?: DeliveryEventRegistry;
  /** INT-2: re-enqueue a delivery by id. Provided by createServer when webhooks are enabled. */
  replayWebhook?: (tenant: string, deliveryId: string) => ReplayResult;
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

  // -- Webhook admin endpoints (O4, U1, U3, RT-13) --
  // List active webhooks for a tenant — secrets REDACTED (U3).
  app.get(
    '/__admin/tenants/:tenant/webhooks',
    adminAuthMiddleware({ snapshot: (): ReturnType<SnapshotHolder['get']> => deps.holder.get(), scope: 'tenant' }),
    (ctx: Context) => {
      const tenant = ctx.req.param('tenant');
      const snap = deps.holder.get();
      const tenantSnap = snap?.tenants.get(tenant);
      if (!tenantSnap) return ctx.json({ error: 'tenant_not_found', tenant }, 404);
      const webhooks: Array<Record<string, unknown>> = [];
      for (const [entryId, specs] of tenantSnap.compiledWebhooks) {
        for (const spec of specs) {
          webhooks.push({
            entryId,
            id: spec.id,
            method: spec.method,
            // U3: never expose secret material in admin responses.
            signing: spec.signing
              ? { enabled: spec.signing.enabled, algorithm: spec.signing.algorithm }
              : null,
            retry: { attempts: spec.retry.attempts },
            circuit: spec.circuit,
            timeoutMs: spec.timeoutMs,
            allowHttp: spec.allowHttp,
            allowPrivateNetworks: spec.allowPrivateNetworks,
            acceptHeaderOverride: spec.acceptHeaderOverride,
          });
        }
      }
      return ctx.json({ tenant, count: webhooks.length, webhooks });
    },
  );

  // Per-tenant webhook delivery journal.
  app.get(
    '/__admin/tenants/:tenant/webhooks/journal',
    adminAuthMiddleware({ snapshot: (): ReturnType<SnapshotHolder['get']> => deps.holder.get(), scope: 'tenant' }),
    (ctx: Context) => {
      const tenant = ctx.req.param('tenant');
      if (!deps.webhookJournal) return ctx.json({ error: 'webhooks_disabled' }, 503);
      const entries = deps.webhookJournal.snapshot(tenant);
      return ctx.json({ tenant, count: entries.length, entries });
    },
  );

  // Sync await — TN3 lifecycle separation: this endpoint is its own request, blocking on the queue's terminal-state event.
  app.get(
    '/__admin/tenants/:tenant/webhooks/await',
    adminAuthMiddleware({ snapshot: (): ReturnType<SnapshotHolder['get']> => deps.holder.get(), scope: 'tenant' }),
    async (ctx: Context) => {
      if (!deps.webhookEvents) return ctx.json({ error: 'webhooks_disabled' }, 503);
      const deliveryId = ctx.req.query('id');
      if (!deliveryId) return ctx.json({ error: 'missing_query_id' }, 400);
      const timeoutMs = Math.min(60_000, Number.parseInt(ctx.req.query('timeoutMs') ?? '5000', 10) || 5000);
      const summary = await deps.webhookEvents.await(deliveryId, timeoutMs);
      if (!summary) return ctx.json({ error: 'await_timeout', deliveryId }, 408);
      return ctx.json(summary);
    },
  );

  // Replay — TN7: replay scope is ring-buffer-resident entries. Evicted -> 404 delivery_not_in_journal.
  // INT-2: re-enqueues using the CURRENT snapshot's webhook spec (not a stored copy of the original).
  // Templates referencing request data render against an empty request — replay is a recovery tool,
  // not a wire-replay primitive. See DECISIONS.md INT-2.
  app.post(
    '/__admin/tenants/:tenant/webhooks/:deliveryId/replay',
    adminAuthMiddleware({ snapshot: (): ReturnType<SnapshotHolder['get']> => deps.holder.get(), scope: 'tenant' }),
    (ctx: Context) => {
      const tenant = ctx.req.param('tenant');
      const deliveryId = ctx.req.param('deliveryId');
      if (!deps.replayWebhook) return ctx.json({ error: 'webhooks_disabled' }, 503);
      const result = deps.replayWebhook(tenant, deliveryId);
      if (!result.ok) {
        const httpStatus = result.code === 'delivery_not_in_journal'
          ? 404
          : result.code === 'tenant_not_found'
          ? 404
          : 410;  // mock_entry_removed / webhook_spec_removed — config no longer hosts the spec
        return ctx.json({ error: result.code, deliveryId }, httpStatus);
      }
      return ctx.json({
        replayQueued: true,
        originalDeliveryId: deliveryId,
        newDeliveryId: result.newDeliveryId,
      }, 202);
    },
  );

  return app;
}
