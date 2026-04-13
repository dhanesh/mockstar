# Mockstar

> A Bun-based mock server with static + dynamic mocking, JSON config, named JS handlers, pass-through routing, multi-tenancy, and test-data utilities.

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
