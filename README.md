# Mockstar

[![quickstart-smoke](https://github.com/dhanesh/mockstar/actions/workflows/quickstart-smoke.yml/badge.svg)](https://github.com/dhanesh/mockstar/actions/workflows/quickstart-smoke.yml)
[![release](https://github.com/dhanesh/mockstar/actions/workflows/release.yml/badge.svg)](https://github.com/dhanesh/mockstar/actions/workflows/release.yml)

> **Status:** pre-1.0. Minors may break mocks-file shape — see [docs/VERSIONING.md](./docs/VERSIONING.md). Pin `$schema` to `https://schemas.mockstar.dev/v0.<N>/mock.json` for stability.

> A Bun-based mock server with static + dynamic mocking, JSON config, named JS handlers, pass-through routing, multi-tenancy, and test-data utilities.

## Demo

![mockstar demo — make docker-run + curl](./docs/media/demo.svg)

<sub>Recorded with [asciinema](https://asciinema.org/) — raw cast at [`docs/media/demo.cast`](./docs/media/demo.cast). Regenerate with `make record-demo` (requires `asciinema`, `jq`, `npx`, Docker).</sub>

## For SDETs

Mockstar ships a library embed (`import { launch } from '@dhanesh/mockstar'`) supported
across Jest 30, Jest 29, Vitest, and `bun test`. See [docs/SDET.md](./docs/SDET.md)
+ the [`examples/sdet-*`](./examples) directories.

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md). Maintainers: [docs/TEAM-WORKFLOW.md](./docs/TEAM-WORKFLOW.md).


Mockstar targets three personas equally:

- **SDETs** — library-embed in test suites, ephemeral instances per CI run, deterministic mode
- **Developers** — `bunx @dhanesh/mockstar ./mocks` with file-watch hot reload
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

## Outbound webhooks

Attach `webhooks: [...]` to any mock entry to fire HTTP deliveries **after** the matched response flushes — useful for verifying receiver-side webhook handlers in integration tests, dogfooding partner integrations, and modeling provider behavior in fixtures.

```jsonc
{
  "id": "orders-create",
  "match": { "method": "POST", "path": "/orders" },
  "response": { "kind": "static", "status": 201, "body": { "id": "{{id(\"ord_\", 12)}}" } },
  "webhooks": [{
    "id": "order-created",
    "url": "https://api.partner.example/hooks/order-created",
    "method": "POST",
    "headers": { "content-type": "application/json" },
    "body": { "orderId": "{{request.body.orderId}}", "tenant": "{{tenant}}" }
  }]
}
```

Capabilities at a glance:

| | |
|---|---|
| **Configuration channels** | Per-route `url`, `{{ env.NAME }}` interpolation, admin API, opt-in `X-Mockstar-Webhook-Url` request header (gated by `--allow-webhook-url-header`) |
| **Delivery contract** | At-least-once within queue + circuit bounds, exponential backoff with jitter (default `[1s, 2s, 4s, 8s, 16s]`), idempotent `X-Mockstar-Delivery-Id` header |
| **Signing** | Opt-in HMAC-SHA256, Stripe-style `${ts}.${rawBody}` payload, secrets via `{{ env.X }}` or `file:/path` (inline rejected at config-load) |
| **Reliability** | Per-webhook circuit breaker, drop-oldest queue cap, per-attempt `AbortSignal.timeout`, optional `expectResponse: { status, body }` body assertion |
| **Observability** | `/__admin/tenants/:t/webhooks` list (secrets redacted), `/webhooks/journal` history, `POST /webhooks/await?id=…` for sync test assertions, `POST /webhooks/:id/replay` for recovery |
| **Metrics** | `webhook_delivery_total{outcome}`, `webhook_delivery_latency_us`, `webhook_queue_depth`, `webhook_queue_dropped_total`, `webhook_circuit_state` |
| **Distribution** | In-process (no Redis); single-binary and SDET-embed friendly |

Full guide, decisions log, and security model: [docs/webhooks/README.md](./docs/webhooks/README.md), [docs/webhooks/DECISIONS.md](./docs/webhooks/DECISIONS.md), [docs/webhooks/SECURITY.md](./docs/webhooks/SECURITY.md). Worked example loadable via `bun run dev`: [examples/mocks/default/webhooks-example.json](./examples/mocks/default/webhooks-example.json).

## What's in v1, what's deferred

See [CHANGELOG.md](./CHANGELOG.md). TL;DR: static + dynamic + pass-through + scenarios + outbound webhooks + OpenAPI import + admin read endpoints + multi-tenancy ship in v1. Stateful mocks, GraphQL, gRPC, fault injection, and a config-mutation admin API are explicitly deferred to v1.1.

## HTTPS transparent upstream (`mockstar proxy`)

Point real HTTPS traffic at your local mocks with zero application code changes — `https://api.razorpay.com` resolves to `127.0.0.1`, terminates on a mkcert-trusted leaf, and forwards to mockstar-on-3000. macOS + Linux only in v1.

```bash
mockstar proxy install           # one-time: installs CA, DNS, port-bind grant
mockstar proxy start             # runs the HTTPS listener on :443
```

See [docs/PROXY.md](./docs/PROXY.md) for the full guide and [docs/PROXY-RECOVERY.md](./docs/PROXY-RECOVERY.md) for incident recovery.

## Kubernetes / Helm

Deploy the mock + webhook server with the chart in [`charts/mockstar`](./charts/mockstar) — secure-by-default (read-only root FS, non-root uid 10001, dropped caps, admin token via Secret).

```bash
helm install mockstar oci://ghcr.io/dhanesh/charts/mockstar \
  --version 0.1.0 --namespace mockstar --create-namespace
```

- **Single replica by design** (`replicaCount: 1`, `Recreate`): the journal, scenario state, and webhook queue are in-memory and per-pod — scaling beyond 1 splits that state.
- The TLS-intercepting `mockstar proxy` is a local-only experimental dev tool and is **not** deployed by the chart.

Full guide — tenant ConfigMaps, handlers, admin token Secret, NetworkPolicy egress, probes/metrics, image-by-digest: [docs/deployment/helm.md](./docs/deployment/helm.md).

## Security

See [docs/SECURITY.md](./docs/SECURITY.md) for the threat model, [SECURITY.md](./SECURITY.md) for the security policy and posture. Admin endpoints are disabled by default. Pass-through and OpenAPI import share a hardened URL validator that rejects private-range targets by default (addressing CVE-2026-39885-class OpenAPI `$ref` attacks).

## License & governance

MIT — see [LICENSE](./LICENSE). Governance policy, irreversible-decision watch list, and the protocol for changing project-level commitments live in [docs/GOVERNANCE.md](./docs/GOVERNANCE.md).
