// Validates: B5 (server CLI flag gates X-Mockstar-Webhook-Url header), TN5 (tiered opt-in)
// @constraint B5 - --allow-webhook-url-header off by default; per-route acceptHeaderOverride second tier

import { describe, expect, test, afterEach } from 'bun:test';
import { makeTestServer, webhookSpec, tick, spawnReceiver } from './_helpers.ts';
import type { Entry } from '../../src/core/config/schema.ts';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

describe('B5 / TN5 — header URL channel tiered gate', () => {
  test('flag OFF: configured URL is targeted, header is ignored', async () => {
    const configured = spawnReceiver(() => new Response('configured', { status: 200 }));
    const headerTarget = spawnReceiver(() => new Response('header', { status: 200 }));
    cleanups = [configured.close, headerTarget.close];

    const entries: Entry[] = [{
      id: 'mock1',
      match: { method: 'POST', path: '/trigger', priority: 0 },
      response: { kind: 'static', status: 200, body: { ok: true } },
      webhooks: [webhookSpec({ url: configured.url, retry: { attempts: 1, backoff: [], jitterRatio: 0 } })],
    }];
    const { server } = makeTestServer({ entries, serverOpts: { allowWebhookUrlHeader: false } });

    await server.hono.fetch(new Request('http://localhost/trigger', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json', 'x-mockstar-webhook-url': headerTarget.url },
    }));
    await tick(200);

    expect(configured.hits.length).toBeGreaterThan(0);
    expect(headerTarget.hits.length).toBe(0);
  });

  test('flag ON + per-route opt-out FALSE: header URL takes precedence', async () => {
    const configured = spawnReceiver(() => new Response('configured', { status: 200 }));
    const headerTarget = spawnReceiver(() => new Response('header', { status: 200 }));
    cleanups = [configured.close, headerTarget.close];

    const entries: Entry[] = [{
      id: 'mock1',
      match: { method: 'POST', path: '/trigger', priority: 0 },
      response: { kind: 'static', status: 200, body: { ok: true } },
      webhooks: [webhookSpec({
        url: configured.url,
        acceptHeaderOverride: true,
        retry: { attempts: 1, backoff: [], jitterRatio: 0 },
      })],
    }];
    const { server } = makeTestServer({ entries, serverOpts: { allowWebhookUrlHeader: true } });

    await server.hono.fetch(new Request('http://localhost/trigger', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json', 'x-mockstar-webhook-url': headerTarget.url },
    }));
    await tick(200);

    expect(headerTarget.hits.length).toBeGreaterThan(0);
    expect(configured.hits.length).toBe(0);
  });

  test('flag ON + per-route acceptHeaderOverride FALSE: header is ignored', async () => {
    const configured = spawnReceiver(() => new Response('configured', { status: 200 }));
    const headerTarget = spawnReceiver(() => new Response('header', { status: 200 }));
    cleanups = [configured.close, headerTarget.close];

    const entries: Entry[] = [{
      id: 'mock1',
      match: { method: 'POST', path: '/trigger', priority: 0 },
      response: { kind: 'static', status: 200, body: { ok: true } },
      webhooks: [webhookSpec({
        url: configured.url,
        acceptHeaderOverride: false,  // Per-route opt-out wins even when server flag is on
        retry: { attempts: 1, backoff: [], jitterRatio: 0 },
      })],
    }];
    const { server } = makeTestServer({ entries, serverOpts: { allowWebhookUrlHeader: true } });

    await server.hono.fetch(new Request('http://localhost/trigger', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json', 'x-mockstar-webhook-url': headerTarget.url },
    }));
    await tick(200);

    expect(configured.hits.length).toBeGreaterThan(0);
    expect(headerTarget.hits.length).toBe(0);
  });
});
