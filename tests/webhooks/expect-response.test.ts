// Validates: U2 (expectResponse runtime behavior — body/status assertion drives retry)
// @constraint U2 - delivery success conditional on receiver response shape, not just 2xx

import { describe, expect, test, afterEach } from 'bun:test';
import { makeTestServer, webhookSpec, tick, spawnReceiver } from './_helpers.ts';
import type { Entry } from '../../src/core/config/schema.ts';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

describe('U2 — expectResponse drives retry/failure decisions', () => {
  test('default behavior (no expectResponse): 2xx counts as success', async () => {
    const receiver = spawnReceiver(() => new Response('{}', { status: 200 }));
    cleanups = [receiver.close];

    const entries: Entry[] = [{
      id: 'mock1',
      match: { method: 'POST', path: '/trigger', priority: 0 },
      response: { kind: 'static', status: 200, body: { ok: true } },
      webhooks: [webhookSpec({ url: receiver.url, retry: { attempts: 1, backoff: [], jitterRatio: 0 } })],
    }];
    const { server } = makeTestServer({ entries });

    await server.hono.fetch(new Request('http://localhost/trigger', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }));
    await tick(200);

    const journal = server.webhookJournal.snapshot('default');
    expect(journal.length).toBeGreaterThan(0);
    expect(journal[journal.length - 1]?.outcome).toBe('success');
  });

  test('expectResponse.status: receiver returns 200 but expected 202 → retries until exhausted', async () => {
    const receiver = spawnReceiver(() => new Response('{}', { status: 200 }));
    cleanups = [receiver.close];

    const entries: Entry[] = [{
      id: 'mock1',
      match: { method: 'POST', path: '/trigger', priority: 0 },
      response: { kind: 'static', status: 200, body: { ok: true } },
      webhooks: [webhookSpec({
        url: receiver.url,
        expectResponse: { status: 202 },
        retry: { attempts: 2, backoff: [50], jitterRatio: 0 },
      })],
    }];
    const { server } = makeTestServer({ entries });

    await server.hono.fetch(new Request('http://localhost/trigger', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }));
    await tick(400);

    const journal = server.webhookJournal.snapshot('default');
    expect(journal.length).toBeGreaterThan(0);
    expect(journal[journal.length - 1]?.outcome).toBe('failed');
    // Receiver should have been hit twice — once per attempt before exhaustion.
    expect(receiver.hits.length).toBe(2);
  });

  test('expectResponse.status as array: 200 OR 202 both count as success', async () => {
    const receiver = spawnReceiver(() => new Response('{}', { status: 202 }));
    cleanups = [receiver.close];

    const entries: Entry[] = [{
      id: 'mock1',
      match: { method: 'POST', path: '/trigger', priority: 0 },
      response: { kind: 'static', status: 200, body: { ok: true } },
      webhooks: [webhookSpec({
        url: receiver.url,
        expectResponse: { status: [200, 202] },
        retry: { attempts: 1, backoff: [], jitterRatio: 0 },
      })],
    }];
    const { server } = makeTestServer({ entries });

    await server.hono.fetch(new Request('http://localhost/trigger', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }));
    await tick(200);

    const journal = server.webhookJournal.snapshot('default');
    expect(journal[journal.length - 1]?.outcome).toBe('success');
  });

  test('expectResponse.body partial-equal: matching field passes', async () => {
    const receiver = spawnReceiver(() => new Response(JSON.stringify({ ack: true, extra: 'ignored' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    cleanups = [receiver.close];

    const entries: Entry[] = [{
      id: 'mock1',
      match: { method: 'POST', path: '/trigger', priority: 0 },
      response: { kind: 'static', status: 200, body: { ok: true } },
      webhooks: [webhookSpec({
        url: receiver.url,
        expectResponse: { body: { ack: true } },
        retry: { attempts: 1, backoff: [], jitterRatio: 0 },
      })],
    }];
    const { server } = makeTestServer({ entries });

    await server.hono.fetch(new Request('http://localhost/trigger', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }));
    await tick(200);

    const journal = server.webhookJournal.snapshot('default');
    expect(journal[journal.length - 1]?.outcome).toBe('success');
  });

  test('expectResponse.body mismatch: receiver returns 200 but body wrong → retries', async () => {
    const receiver = spawnReceiver(() => new Response(JSON.stringify({ ack: false }), { status: 200, headers: { 'content-type': 'application/json' } }));
    cleanups = [receiver.close];

    const entries: Entry[] = [{
      id: 'mock1',
      match: { method: 'POST', path: '/trigger', priority: 0 },
      response: { kind: 'static', status: 200, body: { ok: true } },
      webhooks: [webhookSpec({
        url: receiver.url,
        expectResponse: { body: { ack: true } },
        retry: { attempts: 2, backoff: [50], jitterRatio: 0 },
      })],
    }];
    const { server } = makeTestServer({ entries });

    await server.hono.fetch(new Request('http://localhost/trigger', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }));
    await tick(400);

    const journal = server.webhookJournal.snapshot('default');
    expect(journal[journal.length - 1]?.outcome).toBe('failed');
    expect(receiver.hits.length).toBe(2);  // both attempts made
  });
});
