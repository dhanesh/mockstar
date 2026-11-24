# Mockstar

Bun-based mock server — static + dynamic mocking, JSON config, named JS handlers, pass-through routing, multi-tenancy, test-data utilities. Pre-1.0: minors may break mock-file shape; pin `$schema` in each mock config for stability.

**Stack**: TypeScript, Bun 1.3.0+, Hono (HTTP), Zod (validation), Faker.js (test data), Biome (lint/format)

**Three personas**: SDETs (library embed in test suites), Developers (CLI + hot reload), DevOps (Docker + per-tenant ConfigMap mounts)

## Build Commands

```bash
bun install

# Development
bun run dev                    # Run against examples/mocks (hot reload)
bun run src/cli.ts ./mocks     # Run against a custom mocks directory

# Build
bun run build                  # ESM dist + type declarations
bun run build:binary           # Platform binaries (darwin-arm64, linux-x64, etc.)

# Test
bun test                       # All tests
bun test --watch               # Watch mode
bun test tests/matching        # Specific test directory

# Quality
bun run verify                 # Full pre-PR gate: lint + typecheck + build + test (stops on first failure)
bun run typecheck              # tsc --noEmit
bun run lint                   # Biome check
bun run format                 # Biome format --write

# Benchmarks
bun run bench                  # Core matching benchmark
bun run bench:proxy            # Proxy pass-through benchmark
```

## Architecture

```
src/
  cli.ts                       # CLI entry point (bin: mockstar)
  server.ts                    # Hono server setup
  index.ts                     # Library exports (import { launch } from '@dhaneshpurohit/mockstar')
  cli/commands/                # CLI subcommands (serve, proxy, ...)
  core/
    config/                    # Mock config loading + schema validation (Zod)
    errors/                    # Error types
    handlers/                  # Named JS handler loading + execution
    journal/                   # In-memory request journal (per-tenant ring buffer)
    matching/                  # URL matching engine — path-trie + discriminators
    observability/             # Prometheus metrics + structured logging
    scenarios/                 # Per-entry scenarios: `when:` predicates pick an alternate response
    templating/                # {{ }} template engine — request reflection + Faker
    tenancy/                   # Multi-tenant isolation (one directory per tenant)
  features/
    admin/                     # Admin API: /health, /ready, /metrics, /__admin/tenants/:t/{mocks,journal,webhooks...}
    enhance/                   # Response enhancement hooks
    openapi/                   # OpenAPI import — converts an OpenAPI doc into mock configs (no generator; import direction only)
    proxy/                     # Pass-through proxy for unmatched routes
    spec/                      # Mock spec validation

schema/                        # JSON schemas for mock config files
tests/                         # Tests colocated by feature (admin, cli, config, matching, ...)
examples/                      # Example mock directories (mocks/ + sdet-* for library embed)
bench/                         # Benchmarks
```

## Mock Config Format

```
mocks/                # the config root (CLI: `mockstar serve mocks/`)
  <tenant>/           # one directory per tenant (default tenant: "default")
    users.json        # mock config file — one file per resource
handlers/             # named JS/TS dynamic handlers (default: ../handlers next to the config root)
  echo.ts
```

**Pin `$schema` in every mock file** — pre-1.0 shape changes between minors. `mockstar init` writes the URL for the installed minor:
```json
{
  "$schema": "https://schemas.mockstar.dev/v0.6/mock.json",
  "mocks": [
    {
      "id": "hello",
      "match": { "method": "GET", "path": "/hello" },
      "response": { "kind": "static", "status": 200, "body": { "message": "hi {{faker.name}}" } }
    }
  ]
}
```

Response kinds: `static`, `dynamic` (named handler), `passthrough`. Full reference: `docs/CONFIG.md`.

## Key Patterns

**Library embed** (SDET use case — Jest, Vitest, `bun test`):
```ts
import { launch } from '@dhaneshpurohit/mockstar'
const mock = await launch({ configRoot: './fixtures/mocks', deterministic: true, watch: false })
// launch() binds no port: call the Hono app directly (wrap it in Bun.serve if code needs a URL)
const res = await mock.server.hono.fetch(new Request('http://localhost/hello'))
await mock.stop()
```
See `docs/SDET.md` for options and what `deterministic` guarantees.

**Scenarios** are chosen per request, not switched through an API. Each mock entry may carry `scenarios: [{ id, when: { params | query | headers | body }, response }]`; the first matching `when` overrides the response. See `docs/SCENARIOS.md`.

**Admin API** (`/__admin/tenants/:tenant/...`): `GET mocks`, `GET journal`, `GET webhooks`, `GET webhooks/journal`, `GET webhooks/await`, `POST webhooks/:deliveryId/replay`. The admin API is off unless enabled: CLI — set `MOCKSTAR_ADMIN_TOKEN` (16+ chars); library — `launch({ server: { adminEnabled: true } })`. Then send `Authorization: Bearer <token>` where the token is that tenant's `adminToken` from `mocks/<tenant>/tenant.json` (16+ chars). The root token only opens `/metrics`; on tenant endpoints it gets 403 `root_token_cannot_access_tenant_scope`. `/health` and `/ready` need no token.

**Webhooks to localhost** need `"allowHttp": true` and `"allowPrivateNetworks": true` on the webhook. Without them the delivery is rejected by the SSRF guard: the response is still served, and the failure shows only in the webhook journal.

**Response templating gotcha**: whole-string placeholders in a JSON response body preserve source type — `{{ request.body.amount }}` stays a number, not a string. Only interpolated (partial) strings always coerce to string. **Webhook bodies do not preserve type**: every templated value renders as a string (`docs/webhooks/README.md`).

**Faker allowlist**: `{{faker.*}}` supports exactly `uuid`, `email`, `name`, `integer(min, max)`, `pick([...])`, `boolean`, `dateIso`. Any other `faker.x` renders literally as `{{faker.x}}`.

**Deterministic mode** (`--deterministic`, `MOCKSTAR_DETERMINISTIC=1`, `launch({ deterministic: true })`): faker and `{{id()}}` are seeded per (tenant, mock entry, hit number of that entry), so other tenants' and other mocks' traffic does not change a mock's values. Fixture values change when mockstar changes the bundled faker or the seed scheme (0.5.0, 0.6.0) — see "Upgrading" in `docs/SDET.md`.

**Path trie matching**: candidates are ordered strictly by `match.priority` (higher wins), with declaration order as the tiebreaker when priority is equal — there is no path-specificity scoring (`/users/:id` does not automatically lose to `/users/active`). If you need a more-specific route to win, set `priority` explicitly. A query/header/body predicate in `match` must be satisfied (an entry with `query: { tier: "premium" }` does not match a request without `tier`); extra request params the predicate does not name are ignored.

**Multi-tenancy**: each tenant is an isolated directory. Tenancy modes (default `["path", "header"]`): path `/t/<tenant>/...`, header `X-Mockstar-Tenant: <tenant>`, or subdomain. With no tenant, requests go to `default`.

**Handler types**: from 0.7.0 the package exports `MockHandler`, `HandlerHelpers` and `createFaker` (see `docs/HANDLERS.md`).

## Gotchas

- `bun run build` must precede `bun run build:binary` — binaries are built from `dist/`, not `src/`
- Handler changes are **not** hot-reloaded, in dev mode or Docker — `buildHandlerRegistry()` runs once in `launch()` and the file watcher only watches tenant mock-config directories, never `handlersDir`. Restart the process (or rebuild the image) to pick up handler changes
- The request journal is in-memory only; it resets on server restart. Only webhook deliveries can be appended to disk (`--webhook-journal-file`), and that file is not reloaded on start
- Biome replaces ESLint + Prettier — don't add `.eslintrc` or `.prettierrc`
