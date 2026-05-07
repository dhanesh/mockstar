// Validates: B4 (zero-config SDET embed), B1 (no Redis required even with webhooks)
// @constraint B4 - launch() with webhooks works without any MOCKSTAR_* env vars

import { describe, expect, test } from 'bun:test';
import { makeTestServer, webhookSpec } from './_helpers.ts';
import type { Entry } from '../../src/core/config/schema.ts';

describe('B4 — SDET embed: zero-config webhooks', () => {
  test('webhooks compile and infrastructure spins up with no env vars set', () => {
    // Snapshot env keys that webhooks might touch — none should be required for basic launch.
    delete process.env.MOCKSTAR_ALLOW_WEBHOOK_URL_HEADER;
    delete process.env.MOCKSTAR_ADMIN_TOKEN;

    const entries: Entry[] = [{
      id: 'mock1',
      match: { method: 'POST', path: '/orders', priority: 0 },
      response: { kind: 'static', status: 201, body: { ok: true } },
      webhooks: [webhookSpec({ url: 'http://127.0.0.1:1' })],
    }];

    // makeTestServer mirrors the SDET launch path — Snapshot + createServer.
    // If anything required env / sidecar infra, this would throw.
    expect(() => {
      const { server } = makeTestServer({ entries });
      // RunningServer must expose webhook surface even without explicit opt-ins.
      expect(server.webhookJournal).toBeDefined();
      expect(server.webhookEvents).toBeDefined();
      expect(server.replayWebhook).toBeDefined();
    }).not.toThrow();
  });

  test('library embed never imports a Redis client (B1 sanity)', async () => {
    // Smoke test on the public package: the Redis client is NOT in the resolution graph.
    // We confirm by checking that bun's import graph for the index doesn't surface 'ioredis' / 'redis'.
    // (Cheap proxy check — full graph audit is m6 territory.)
    const indexSource = await Bun.file(`${import.meta.dir}/../../src/index.ts`).text();
    const queueSource = await Bun.file(`${import.meta.dir}/../../src/features/webhooks/queue.ts`).text();
    const dispatcherSource = await Bun.file(`${import.meta.dir}/../../src/features/webhooks/dispatcher.ts`).text();

    for (const source of [indexSource, queueSource, dispatcherSource]) {
      expect(source).not.toMatch(/\bfrom\s+['"]ioredis['"]/);
      expect(source).not.toMatch(/\bfrom\s+['"]redis['"]/);
      expect(source).not.toMatch(/\bfrom\s+['"]bullmq['"]/);
    }
  });
});
