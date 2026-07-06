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
    journal/                   # Request/response journal (replay, assertion)
    matching/                  # URL matching engine — path-trie + discriminators
    observability/             # Prometheus metrics + structured logging
    scenarios/                 # Scenario state machine (switch active scenario per tenant)
    templating/                # {{ }} template engine — request reflection + Faker
    tenancy/                   # Multi-tenant isolation (one directory per tenant)
  features/
    admin/                     # Admin API (/_mockstar/...) for scenario switching, journal query
    enhance/                   # Response enhancement hooks
    openapi/                   # OpenAPI spec generation from mock configs
    proxy/                     # Pass-through proxy for unmatched routes
    spec/                      # Mock spec validation

schema/                        # JSON schemas for mock config files
tests/                         # Tests colocated by feature (admin, cli, config, matching, ...)
examples/                      # Example mock directories (mocks/ + sdet-* for library embed)
bench/                         # Benchmarks
```

## Mock Config Format

```
mocks/
  <tenant>/           # one directory per tenant (default tenant: "default")
    users.json        # mock config file — one file per resource
handlers/             # named JS/TS dynamic handlers
  echo.ts
```

**Pin `$schema` in every mock file** — pre-1.0 shape changes between minors:
```json
{
  "$schema": "https://schemas.mockstar.dev/v0.1/mock.json",
  "routes": [...]
}
```

## Key Patterns

**Library embed** (SDET use case — Jest, Vitest, `bun test`):
```ts
import { launch } from '@dhaneshpurohit/mockstar'
const server = await launch({ mocksDir: './fixtures/mocks' })
// ...tests...
await server.stop()
```

**Scenario switching** (admin API):
```bash
curl -X POST http://localhost:3000/_mockstar/scenarios \
  -d '{"tenant": "default", "scenario": "error-state"}'
```

**Response templating gotcha**: whole-string placeholders in a JSON body preserve source type — `{{ request.body.amount }}` stays a number, not a string. Only interpolated (partial) strings always coerce to string.

**Path trie matching**: more-specific routes win; query params are matched as optional by default. If two routes have the same specificity, first-defined wins — order matters in config files.

**Multi-tenancy**: each tenant is an isolated directory; the `Host` header (or `X-Mockstar-Tenant` override) determines which tenant's mocks are served.

## Gotchas

- `bun run build` must precede `bun run build:binary` — binaries are built from `dist/`, not `src/`
- Handlers are hot-reloaded in dev mode but **not** in Docker — rebuild the image to pick up handler changes
- The journal is in-memory only; it resets on server restart. For persistent replay, use the `--journal-file` flag
- Biome replaces ESLint + Prettier — don't add `.eslintrc` or `.prettierrc`
