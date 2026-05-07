// Shared test helpers for webhook integration tests.
// Keeping fixture boilerplate out of individual test files.

import { createServer } from '../../src/server.ts';
import type { CreateServerOptions, RunningServer } from '../../src/server.ts';
import { SnapshotHolder } from '../../src/core/config/snapshot.ts';
import { buildMatchIndex } from '../../src/core/matching/index.ts';
import { compileEntryResponses } from '../../src/core/templating/compiler.ts';
import { compileWebhookSpecs } from '../../src/features/webhooks/compile.ts';
import type { Entry } from '../../src/core/config/schema.ts';
import { TenantLimits } from '../../src/core/config/schema.ts';
import type { HandlerRegistry } from '../../src/core/handlers/index.ts';

export const ADMIN_TOKEN = 'test-admin-token-32-chars-xxxxxxxx';

export const emptyRegistry: HandlerRegistry = Object.freeze({
  get size() { return 0; },
  has: () => false,
  get: () => undefined,
  names: () => [],
});

export interface TestServerOptions {
  entries: Entry[];
  serverOpts?: Partial<Omit<CreateServerOptions, 'holder' | 'registry'>>;
  allowPrivateUpstreams?: boolean;
}

export function makeTestServer(opts: TestServerOptions): { server: RunningServer; holder: SnapshotHolder } {
  const holder = new SnapshotHolder({
    version: 1,
    server: {
      host: '127.0.0.1',
      port: 3000,
      tenancyModes: ['path', 'header'],
      deterministic: true,
      adminEnabled: true,
      rootToken: ADMIN_TOKEN,
    },
    tenants: new Map([['default', {
      name: 'default',
      entries: opts.entries,
      matchIndex: buildMatchIndex(opts.entries),
      compiledResponses: compileEntryResponses(opts.entries),
      compiledScenarios: new Map(),
      compiledWebhooks: compileWebhookSpecs(opts.entries),
      limits: TenantLimits.parse({}),
      adminToken: ADMIN_TOKEN,
      allowPrivateUpstreams: opts.allowPrivateUpstreams ?? true,
    }]]),
    handlers: emptyRegistry,
  });

  const server = createServer({
    holder,
    registry: emptyRegistry,
    deterministic: true,
    installCrashHandlers: false,
    ...opts.serverOpts,
  });
  return { server, holder };
}

/** Default webhook spec scaffold — override fields per-test. */
export function webhookSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'wh-test',
    url: 'http://127.0.0.1:1',  // unbound by default — override in tests that need a real receiver
    method: 'POST',
    body: { ok: true },
    headers: {},
    retry: { attempts: 1, backoff: [], jitterRatio: 0 },
    circuit: { failureThreshold: 5, cooldownMs: 30_000 },
    timeoutMs: 100,
    allowHttp: true,
    allowPrivateNetworks: true,
    acceptHeaderOverride: true,
    ...overrides,
  };
}

/** Sleep helper for awaiting microtask + delivery completion. */
export function tick(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Spawn an ephemeral receiver on 127.0.0.1:<port> using Bun.serve.
 * Returns { port, url, hits, close } — `hits` is a list of incoming-request snapshots
 * captured for later assertions.
 */
export interface CapturedHit {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export function spawnReceiver(handler: (req: Request) => Response | Promise<Response>): {
  url: string;
  port: number;
  hits: CapturedHit[];
  close: () => void;
} {
  const hits: CapturedHit[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: Bun global
  const Bun = (globalThis as any).Bun;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,  // ephemeral
    fetch: async (req: Request) => {
      const text = await req.clone().text();
      hits.push({
        url: req.url,
        method: req.method,
        headers: Object.fromEntries(req.headers as unknown as Iterable<[string, string]>),
        body: text,
      });
      return handler(req);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port,
    hits,
    close: () => server.stop(true),
  };
}
