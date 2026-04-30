# Mockstar

[![quickstart-smoke](https://github.com/your-org/mockstar/actions/workflows/quickstart-smoke.yml/badge.svg)](https://github.com/your-org/mockstar/actions/workflows/quickstart-smoke.yml)
[![release](https://github.com/your-org/mockstar/actions/workflows/release.yml/badge.svg)](https://github.com/your-org/mockstar/actions/workflows/release.yml)

> **Status:** pre-1.0. Minors may break mocks-file shape — see [docs/VERSIONING.md](./docs/VERSIONING.md). Pin `$schema` to `https://schemas.mockstar.dev/v0.<N>/mock.json` for stability.

> A Bun-based mock server with static + dynamic mocking, JSON config, named JS handlers, pass-through routing, multi-tenancy, and test-data utilities.

## Demo

![mockstar demo — make docker-run + curl](./docs/media/demo.svg)

<sub>Recorded with [asciinema](https://asciinema.org/) — raw cast at [`docs/media/demo.cast`](./docs/media/demo.cast). Regenerate with `make record-demo` (requires `asciinema`, `jq`, `npx`, Docker).</sub>

## For SDETs

Mockstar ships a library embed (`import { launch } from 'mockstar'`) supported
across Jest 30, Jest 29, Vitest, and `bun test`. See [docs/SDET.md](./docs/SDET.md)
+ the [`examples/sdet-*`](./examples) directories.

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md). Maintainers: [docs/TEAM-WORKFLOW.md](./docs/TEAM-WORKFLOW.md).


Mockstar targets three personas equally:

- **SDETs** — library-embed in test suites, ephemeral instances per CI run, deterministic mode
- **Developers** — `bunx mockstar ./mocks` with file-watch hot reload
- **DevOps** — Docker image in shared staging with per-tenant ConfigMap mounts

> Built on [Hono](https://hono.dev/) on [Bun](https://bun.sh/). Targets p99 < 5ms for static mock responses. See [DECISIONS.md](./docs/DECISIONS.md) for the constraint-first design record.

## Quick start

```bash
bun install
bun run src/cli.ts ./examples/mocks
# http://localhost:3000
```

A persona-specific deployment walkthrough lives in [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md).

## Config layout

```
mocks/
  default/              # one directory per tenant
    users.json          # a mock config file
    orders.json
handlers/               # named JS function handlers
  echo.ts
```

See [docs/CONFIG.md](./docs/CONFIG.md) for the full schema and [docs/HANDLERS.md](./docs/HANDLERS.md) for dynamic handlers.

## Response templating

Any string value inside `response.body` or `response.headers` can contain `{{ … }}` placeholders. Whole-string placeholders in a JSON body preserve their source type — a number stays a number, an object stays an object.

### Request reflection

| Token | Value |
|---|---|
| `{{request.method}}` | HTTP verb (`GET`, `POST`, …) |
| `{{request.path}}` | Full request path |
| `{{request.params.<name>}}` | Path parameter captured by `:name` in `match.path` |
| `{{request.query.<name>}}` | URL query-string value |
| `{{request.headers.<name>}}` | Request header value (case-insensitive) |
| `{{request.body.<dot.path>}}` | Dot-path into the parsed JSON request body |

### Context

| Token | Value |
|---|---|
| `{{tenant}}` | Tenant identifier the request was routed to |
| `{{requestId}}` | Per-request UUID assigned by mockstar |

### Random data (faker)

| Token | Value |
|---|---|
| `{{faker.uuid}}` | Random UUID v4 |
| `{{faker.email}}` | Random email address |
| `{{faker.name}}` | Random full name |
| `{{faker.integer(min, max)}}` | Random integer in `[min, max]` |
| `{{faker.pick(["a","b","c"])}}` | Random element from the array |
| `{{faker.boolean}}` | `true` or `false` |
| `{{faker.dateIso}}` | Random recent date as ISO 8601 string |

### Provider-shape IDs

| Token | Value |
|---|---|
| `{{id("prefix_", 14)}}` | `prefix_` + 14 random base62 chars — e.g. `order_4OwxzMjhPIt4YQ` |
| `{{id("prefix_", 14, "0123456789abcdef")}}` | Same with a custom alphabet (hex shown) |
| `{{id.named("key", "prefix_", 14)}}` | Mint once per request per name — repeated calls with the same `key` return the identical value, useful when the same ID appears in multiple fields |

### Timestamps

| Token | Value |
|---|---|
| `{{now.unix}}` | Current time as Unix seconds (number) |
| `{{now.millis}}` | Current time as Unix milliseconds (number) |
| `{{now.iso}}` | Current time as ISO 8601 string |

In `--deterministic` mode (`MOCKSTAR_DETERMINISTIC=1`) all faker and `now.*` tokens return fixed seed-derived values so CI replays are byte-identical.

Full reference including type-preservation rules and worked examples: [docs/TIER2.md](./docs/TIER2.md).

## What's in v1, what's deferred

See [CHANGELOG.md](./CHANGELOG.md). TL;DR: static + dynamic + pass-through + OpenAPI import + admin read endpoints + multi-tenancy ship in v1. Stateful mocks, scenarios, GraphQL, gRPC, fault injection, and a config-mutation admin API are explicitly deferred to v1.1.

## HTTPS transparent upstream (`mockstar proxy`)

Point real HTTPS traffic at your local mocks with zero application code changes — `https://api.razorpay.com` resolves to `127.0.0.1`, terminates on a mkcert-trusted leaf, and forwards to mockstar-on-3000. macOS + Linux only in v1.

```bash
mockstar proxy install           # one-time: installs CA, DNS, port-bind grant
mockstar proxy start             # runs the HTTPS listener on :443
```

See [docs/PROXY.md](./docs/PROXY.md) for the full guide and [docs/PROXY-RECOVERY.md](./docs/PROXY-RECOVERY.md) for incident recovery.

## Security

See [docs/SECURITY.md](./docs/SECURITY.md) for the threat model. Admin endpoints are disabled by default. Pass-through and OpenAPI import share a hardened URL validator that rejects private-range targets by default (addressing CVE-2026-39885-class OpenAPI `$ref` attacks).

## License & governance

MIT — see [LICENSE](./LICENSE). Governance policy, irreversible-decision watch list, and the protocol for changing project-level commitments live in [docs/GOVERNANCE.md](./docs/GOVERNANCE.md).
