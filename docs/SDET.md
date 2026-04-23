# SDET — test-suite integration

> **Satisfies:** RT-15 (test-runner support matrix spans the three frameworks test teams still use in 2026, on both npm and Bun)

Mockstar ships an ESM-only library entry (`import { launch } from 'mockstar'`)
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
import { launch } from 'mockstar';
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

- You need multi-tenant tests with subdomain tenancy — easier to run
  `bunx mockstar` in a separate process and point `fetch` at it.
- You want to verify the full CLI contract — use the `mockstar` binary
  directly and assert on its network surface.

## When to revisit

- If Jest drops `--experimental-vm-modules` requirement for ESM loader in
  a future major, the Jest 30 example can simplify significantly.
- If Node 22 ships stable ESM-by-default, the Jest 29 example can drop
  `babel-jest`.
