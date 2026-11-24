# SDET — test-suite integration

> **Satisfies:** RT-15 (test-runner support matrix spans the three frameworks test teams still use in 2026, on both npm and Bun)

Mockstar ships an ESM-only library entry (`import { launch } from '@dhaneshpurohit/mockstar'`)
that boots a mock server in-process. You can either:

1. **Call `server.hono.fetch` directly** — fastest, zero network. Good for
   assertions where you control the `Request` object.
2. **Bind a real port via `Bun.serve` or `node:http`** — use when the code
   under test needs an actual URL (e.g. integrations that reach for `fetch`
   against a hostname).

Everything below covers option (1); option (2) just wraps it with a port.

## Support matrix

| Framework | Runtime | Example | Notes |
|-----------|---------|---------|-------|
| Jest 30   | Node 20+ | [`examples/sdet-jest30`](../examples/sdet-jest30) | Native ESM via `"type": "module"` + `--experimental-vm-modules` |
| Jest 29   | Node 18+ | [`examples/sdet-jest29`](../examples/sdet-jest29) | ESM via `babel-jest` for the transform edge |
| Vitest 2  | Node 20+ | [`examples/sdet-vitest`](../examples/sdet-vitest) | ESM-native; recommended for green-field projects |
| bun test  | Bun 1.1.8+ | [`examples/sdet-bun-test`](../examples/sdet-bun-test) | Fastest; no transform layer |

## The 20-line test pattern

```ts
import { launch } from '@dhaneshpurohit/mockstar';
import { resolve } from 'node:path';

let stop: (() => Promise<void>) | undefined;
let fetch!: (req: Request) => Response | Promise<Response>;

beforeAll(async () => {
  const launched = await launch({
    configRoot: resolve(__dirname, 'mocks'),
    deterministic: true, // RT-15: reproducible test data across runs
    watch: false,         // no fs watcher under test runners
  });
  stop = launched.stop;
  fetch = launched.server.hono.fetch;
});

afterAll(async () => { await stop?.(); });

test('GET /hello returns the scaffolded static body', async () => {
  const res = await fetch(new Request('http://test.local/hello'));
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.message).toBe('Hello from mockstar');
});
```

## Why `deterministic: true` in tests

The faker templates (`{{faker.name}}`, `{{faker.uuid}}`) seed from a
deterministic RNG when the flag is on. Without it, `{{faker.uuid}}` changes
on every run and test assertions that compare against fixtures will flake.

### What "deterministic" guarantees

- **Same mockstar version, same request sequence → same output.** mockstar
  bundles a pinned `@faker-js/faker`, so your own lockfile does not change the
  values.
- **Each mock has its own sequence per tenant.** faker and `{{id()}}` values
  are seeded from the tenant, the mock entry and the hit number of that entry
  for that tenant: the 1st, 2nd, 3rd ... request that matched it. Traffic to
  other tenants or to other mocks does not change them, and neither do the
  templates of other mocks. So two test files that use different mocks, or
  different tenants, can share one mockstar and run in parallel.
- **Repeat hits on the same mock are still ordered.** If parallel tests call
  the same mock of the same tenant, the hit numbers depend on which request
  arrives first. Give each parallel worker its own tenant, or start one
  mockstar per test file.
- **Webhooks** use a separate stream per webhook, seeded by the same hit
  number as the response that triggered them. Each delivery gets new
  `{{id()}}` values, and a retry sends the same values again. A webhook replay
  re-renders the same `{{faker.*}}` and `{{id()}}` values. It does not keep
  `{{request.*}}` values or an `X-Mockstar-Webhook-Url` override, because
  replay has no request.
- **Counters start at server start and never reset.** A config reload does not
  reset them, and there is no admin reset. A mock's values depend on how many
  earlier tests hit that mock on the same server. To make a test independent
  of test order, give it its own tenant or its own mockstar.
- **`{{requestId}}` is not per mock.** The request id (`req-00000001`, ...) in
  templates, handler `helpers.requestId`, the journal and logs counts all
  requests to the server. Do not
  assert on it in fixtures that must not depend on other traffic.
- **Not across mockstar versions that change the bundled faker.** Faker does
  not keep seeded output stable between its releases. When mockstar upgrades
  faker, the release notes say so, and you must regenerate committed fixtures.
- `{{faker.dateIso}}` does not follow the wall clock in deterministic mode. It
  returns a fixed date in the 24 hours before `2026-01-01T00:00:00Z`, which is
  the same epoch as `{{now.iso}}`. Expect a 2025 date in fixtures.

### Upgrading to 0.6.0: regenerate deterministic fixtures

0.6.0 changes the seed of deterministic `{{faker.*}}` and `{{id()}}` values
(#53). Before, the seed was the request id, which counts the requests to all
tenants and all mocks. Now it is the hit number of the mock for that tenant.
Regenerate every fixture recorded with `deterministic: true` or
`MOCKSTAR_DETERMINISTIC=1`, including `{{faker.dateIso}}` values (the date
stays in the same 24-hour window). Request ids and `{{now.*}}` do not change.

Webhook payloads change too: each delivery now gets new `{{id()}}` values.
Before 0.6.0, every delivery of one webhook repeated the same ids.

### Upgrading to 0.5.0: regenerate deterministic fixtures

0.5.0 changes every deterministic `{{faker.*}}` value, for two reasons:

1. faker moves from 9 to 10 (CVE-2026-73231, see #50). faker 10 returns
   different values for the same seed.
2. Each request now uses its own faker stream, not one stream shared by the
   whole server.

Before 0.5.0, `dateIso` changed on every run, so assertions on it could not
have been stable. Regenerate any fixture that was recorded with
`deterministic: true` or `MOCKSTAR_DETERMINISTIC=1`. `{{id()}}` and `{{now.*}}`
values do not change.

## Framework-specific gotchas

### Jest 30
Requires `NODE_OPTIONS=--experimental-vm-modules` to import mockstar's ESM
entrypoint. Example uses `cross-env` to stay portable on Windows runners.

### Jest 29
Does not support pure ESM well; the example uses `babel-jest` to transform
the `import` statements. If you can upgrade to Jest 30, do — it removes the
Babel dependency.

### Vitest
Works out of the box. Pair with `happy-dom` or `jsdom` if the code under
test touches the DOM.

### bun test
Fastest start-up (no Babel/vm-modules). Use this when iteration speed
matters (TDD, mutation testing) and the suite is Bun-native.

## When NOT to use the library embed

- Note the reverse for subdomain tenancy: tenancy modes can only be set
  through the library (`launch({ server: { tenancyModes: ["subdomain"] } })`).
  The CLI always uses the default `["path", "header"]`.
- You want to verify the full CLI contract — use the `mockstar` binary
  directly and assert on its network surface.

## When to revisit

- If Jest drops `--experimental-vm-modules` requirement for ESM loader in
  a future major, the Jest 30 example can simplify significantly.
- If Node 22 ships stable ESM-by-default, the Jest 29 example can drop
  `babel-jest`.
