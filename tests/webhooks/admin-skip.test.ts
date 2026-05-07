// Validates: S4 (admin/health paths NEVER trigger webhooks)
// @constraint S4 - hard-coded admin path skip-list, regardless of route config

import { describe, expect, test, mock } from 'bun:test';
import { dispatchWebhooks } from '../../src/features/webhooks/dispatcher.ts';
import type { CompiledWebhookSpec } from '../../src/features/webhooks/types.ts';
import type { TemplateContext } from '../../src/core/templating/index.ts';

const dummySpec: CompiledWebhookSpec = {
  id: 'wh1',
  urlTemplate: { render: () => 'https://example.com/hook' },
  method: 'POST',
  body: null,
  headers: new Map(),
  retry: { attempts: 1, backoff: [], jitterRatio: 0 },
  signing: null,
  circuit: { failureThreshold: 5, cooldownMs: 30_000 },
  expectResponse: null,
  timeoutMs: 5000,
  allowHttp: false,
  allowPrivateNetworks: false,
  acceptHeaderOverride: false,
};

const dummyTemplateCtx: TemplateContext = {
  faker: {} as unknown as TemplateContext['faker'],
  request: { method: 'GET', path: '/health', query: {}, headers: {}, body: null, params: {} },
  tenant: 'default',
  requestId: 'req-1',
  clock: {} as unknown as TemplateContext['clock'],
  idHelpers: {} as unknown as TemplateContext['idHelpers'],
};

function makeDeps() {
  const enqueueCalls: number[] = [];
  return {
    metrics: { incCounter: () => undefined, observeLatencyUs: () => undefined, setGauge: () => undefined } as unknown as Parameters<typeof dispatchWebhooks>[0]['metrics'],
    journal: { record: () => undefined } as unknown as Parameters<typeof dispatchWebhooks>[0]['journal'],
    events: { publish: () => undefined } as unknown as Parameters<typeof dispatchWebhooks>[0]['events'],
    queueForTenant: () =>
      ({
        enqueue: () => enqueueCalls.push(1),
        size: () => 0,
      }) as unknown as ReturnType<Parameters<typeof dispatchWebhooks>[0]['queueForTenant']>,
    circuitFor: () => ({ gate: () => 'closed' as const, record: () => undefined, metricValue: () => 0 as const }) as unknown as ReturnType<Parameters<typeof dispatchWebhooks>[0]['circuitFor']>,
    allowWebhookUrlHeader: false,
    enqueueCalls,
  };
}

describe('S4 — admin/health paths skip webhooks unconditionally', () => {
  test.each([
    '/_mockstar',
    '/_mockstar/admin',
    '/__admin',
    '/__admin/tenants/default/journal',
    '/health',
    '/ready',
    '/metrics',
  ])('%s does NOT enqueue any delivery', (matchPath) => {
    const deps = makeDeps();
    const ids = dispatchWebhooks(deps, {
      tenant: 'default',
      matchPath,
      triggerRequestId: 'req-1',
      webhooks: [dummySpec],
      templateContext: dummyTemplateCtx,
      requestHeaders: new Map(),
    });
    expect(ids).toEqual([]);
    expect(deps.enqueueCalls).toEqual([]);
  });

  test('non-admin paths DO enqueue', () => {
    const deps = makeDeps();
    const ids = dispatchWebhooks(deps, {
      tenant: 'default',
      matchPath: '/api/users',
      triggerRequestId: 'req-1',
      webhooks: [dummySpec],
      templateContext: dummyTemplateCtx,
      requestHeaders: new Map(),
    });
    expect(ids).toHaveLength(1);
    expect(deps.enqueueCalls).toEqual([1]);
  });

  test('path that just contains /health as substring does NOT match (only prefix match)', () => {
    const deps = makeDeps();
    const ids = dispatchWebhooks(deps, {
      tenant: 'default',
      matchPath: '/api/healthcheck',  // distinct path; not a prefix-match for /health
      triggerRequestId: 'req-1',
      webhooks: [dummySpec],
      templateContext: dummyTemplateCtx,
      requestHeaders: new Map(),
    });
    expect(ids).toHaveLength(1);
  });
});
