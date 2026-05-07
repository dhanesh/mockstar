// Validates: RT-1 (pipeline insertion point — scenario eval before kind dispatch)
// Validates: RT-7 (journal fields: scenarioId, scenarioMissReason)
// Validates: RT-8 (admin endpoint: scenarioCount, scenarioAttributes)
// Validates: T7 (kind-agnostic scenario short-circuit)
// Validates: T5 (Tier 2 tokens in scenario bodies)
// Validates: U1 (no-match is silent — returns default response)
// Validates: U4 (admin endpoint exposes scenario metadata)
// Validates: O1 (journal records scenario ID and miss reason)

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type { RunningServer } from '../src/server.ts';
import { createServer } from '../src/server.ts';
import type { SnapshotHolder } from '../src/core/config/snapshot.ts';
import { SnapshotHolder as SnapshotHolderClass } from '../src/core/config/snapshot.ts';
import { buildMatchIndex } from '../src/core/matching/index.ts';
import { compileEntryResponses } from '../src/core/templating/compiler.ts';
import { compileScenarioRules } from '../src/core/scenarios/evaluator.ts';
import type { Entry } from '../src/core/config/schema.ts';
import { TenantLimits } from '../src/core/config/schema.ts';
import type { HandlerRegistry } from '../src/core/handlers/index.ts';

const ADMIN_TOKEN = 'test-admin-token-32-chars-xxxxxxxx';

const emptyRegistry: HandlerRegistry = Object.freeze({
  get size() { return 0; },
  has: () => false,
  get: () => undefined,
  names: () => [],
});

function makeServer(entries: Entry[]): { server: RunningServer; holder: SnapshotHolder } {
  const matchIndex = buildMatchIndex(entries);
  const compiledResponses = compileEntryResponses(entries);
  const compiledScenarios = new Map(
    entries
      .filter((e) => e.scenarios && e.scenarios.length > 0)
      .map((e) => [e.id, compileScenarioRules(e.scenarios!)]),
  );

  const holder = new SnapshotHolderClass({
    version: 1,
    server: {
      host: '127.0.0.1',
      port: 3000,
      tenancyModes: ['path', 'header'],
      deterministic: true,
      adminEnabled: true,
      rootToken: ADMIN_TOKEN,
    },
    tenants: new Map([
      ['default', {
        name: 'default',
        entries,
        matchIndex,
        compiledResponses,
        compiledScenarios,
        compiledWebhooks: new Map(),
        limits: TenantLimits.parse({}),
        adminToken: ADMIN_TOKEN,
        allowPrivateUpstreams: false,
      }],
    ]),
    handlers: emptyRegistry,
  });

  const server = createServer({
    holder,
    registry: emptyRegistry,
    deterministic: true,
    installCrashHandlers: false,
  });
  return { server, holder };
}

// -- Fixtures --

const scenarioEntries: Entry[] = [
  {
    id: 'get-user-by-lastname',
    match: { method: 'GET', path: '/users/:lastName', priority: 0 },
    response: {
      kind: 'static',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { found: true, name: '{{request.params.lastName}}' },
    },
    scenarios: [
      {
        id: 'not-found-test',
        when: { params: { lastName: 'Test' } },
        response: { status: 404, body: { error: 'user_not_found', name: 'Test' } },
      },
      {
        id: 'server-error-carpenter',
        when: { params: { lastName: 'Carpenter' } },
        response: {
          status: 500,
          body: { error: 'internal_server_error', name: '{{request.params.lastName}}' },
        },
      },
      {
        id: 'locked-with-body',
        when: { params: { lastName: 'Locked' } },
        response: {
          status: 423,
          headers: { 'content-type': 'application/json', 'retry-after': '60' },
          body: { error: 'account_locked', name: 'Locked' },
        },
      },
    ],
  },
];

describe('scenario routing integration', () => {
  let server: RunningServer;
  let holder: SnapshotHolder;

  beforeAll(() => {
    ({ server, holder } = makeServer(scenarioEntries));
  });

  // -- U1: default response when no scenario matches --

  it('returns default response when lastName does not match any scenario (U1)', async () => {
    // @constraint U1
    const res = await server.hono.request('/t/default/users/Smith');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.found).toBe(true);
  });

  // -- B2: non-happy-path scenarios --

  it('returns 404 for lastName=Test (B2)', async () => {
    // @constraint B2
    const res = await server.hono.request('/t/default/users/Test');
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('user_not_found');
  });

  it('returns 500 for lastName=Carpenter (B2)', async () => {
    // @constraint B2
    const res = await server.hono.request('/t/default/users/Carpenter');
    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('internal_server_error');
  });

  it('returns 423 with retry-after header for lastName=Locked', async () => {
    const res = await server.hono.request('/t/default/users/Locked');
    expect(res.status).toBe(423);
    expect(res.headers.get('retry-after')).toBe('60');
  });

  // -- T5: Tier 2 tokens in scenario bodies --

  it('expands request.params token in scenario body (T5)', async () => {
    // @constraint T5
    const res = await server.hono.request('/t/default/users/Carpenter');
    const body = await res.json() as Record<string, unknown>;
    expect(body.name).toBe('Carpenter');
  });

  // -- RT-7: journal records scenario metadata --

  it('records scenarioId in journal for matched scenario (O1, RT-7)', async () => {
    // @constraint O1
    await server.hono.request('/t/default/users/Test');
    const entries = server.journal.snapshot('default');
    const entry = entries.at(-1);
    expect(entry?.scenarioId).toBe('not-found-test');
    expect(entry?.scenarioMissReason).toBeUndefined();
  });

  it('does not record scenarioId when no scenario matches', async () => {
    await server.hono.request('/t/default/users/Smith');
    const entries = server.journal.snapshot('default');
    const entry = entries.at(-1);
    expect(entry?.scenarioId).toBeUndefined();
  });

  // -- x-mockstar-scenario header --

  it('sets x-mockstar-scenario response header on match', async () => {
    const res = await server.hono.request('/t/default/users/Test');
    expect(res.headers.get('x-mockstar-scenario')).toBe('not-found-test');
  });

  it('does not set x-mockstar-scenario when no scenario matches', async () => {
    const res = await server.hono.request('/t/default/users/Smith');
    expect(res.headers.get('x-mockstar-scenario')).toBeNull();
  });

  // -- RT-8: admin endpoint scenario metadata --

  it('admin /mocks endpoint includes scenarioCount (U4, RT-8)', async () => {
    // @constraint U4
    const res = await server.hono.request('/__admin/tenants/default/mocks', {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { mocks: Array<Record<string, unknown>> };
    const mock = data.mocks.find((m) => m.id === 'get-user-by-lastname');
    expect(mock?.scenarioCount).toBe(3);
  });

  it('admin /mocks endpoint includes scenarioAttributes (U4)', async () => {
    // @constraint U4
    const res = await server.hono.request('/__admin/tenants/default/mocks', {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const data = await res.json() as { mocks: Array<Record<string, unknown>> };
    const mock = data.mocks.find((m) => m.id === 'get-user-by-lastname');
    expect(Array.isArray(mock?.scenarioAttributes)).toBe(true);
    expect((mock?.scenarioAttributes as string[]).includes('params.lastName')).toBe(true);
  });

  // -- B1: entry without scenarios unaffected --

  it('entry without scenarios continues to work (B1)', async () => {
    const noScenarioEntries: Entry[] = [{
      id: 'no-scenario-entry',
      match: { method: 'GET', path: '/plain', priority: 0 },
      response: { kind: 'static', status: 200, body: { plain: true } },
    }];
    const { server: s2 } = makeServer(noScenarioEntries);
    const res = await s2.hono.request('/t/default/plain');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.plain).toBe(true);
  });
});

// -- T1: single-pass walker guarantee --

describe('single-pass Tier 2 walker on scenario bodies (T1)', () => {
  it('id.named in scenario body returns same value for both occurrences (T1)', async () => {
    // @constraint T1
    // If the walker ran twice, the id.named cache would be rebuilt and values could diverge.
    // Two occurrences of the same named token must produce identical output, proving one pass.
    const { server: s } = makeServer([{
      id: 'named-id-entry',
      match: { method: 'GET', path: '/named-test', priority: 0 },
      response: { kind: 'static', status: 200, body: {} },
      scenarios: [{
        id: 'named-id-scenario',
        when: { query: { trigger: 'yes' } },
        response: {
          status: 200,
          body: {
            first: '{{id.named("tok","",8)}}',
            second: '{{id.named("tok","",8)}}',
          },
        },
      }],
    }]);
    const res = await s.hono.request('/t/default/named-test?trigger=yes');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.first).toBe('string');
    expect((body.first as string).length).toBe(8);
    expect(body.first).toBe(body.second);
  });
});

// -- T7: kind-agnostic scenario short-circuit --

describe('kind-agnostic scenarios (T7)', () => {
  it('scenario short-circuits a dynamic entry (T7)', async () => {
    // @constraint T7
    const entries: Entry[] = [{
      id: 'dyn-entry',
      match: { method: 'POST', path: '/orders', priority: 0 },
      response: { kind: 'dynamic', handler: 'nonExistentHandler' },
      scenarios: [{
        id: 'reject',
        when: { body: { 'order.currency': 'INVALID' } },
        response: {
          status: 422,
          headers: { 'content-type': 'application/json' },
          body: { error: 'invalid_currency' },
        },
      }],
    }];
    const { server: s } = makeServer(entries);
    const res = await s.hono.request('/t/default/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order: { currency: 'INVALID' } }),
    });
    // Scenario fires — handler never invoked
    expect(res.status).toBe(422);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('invalid_currency');
  });
});
