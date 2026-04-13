# Changelog

All notable changes to Mockstar are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — v1.0 scope (target)

> Satisfies RT-11 (v1 scope explicitly documented).

### In v1.0

- **Mocking.** Static mocks; dynamic mocks via named JS handlers loaded from `handlers/`.
- **Config.** JSON mock configs validated by Zod at boot (fail-fast) and on hot-reload (warn-and-keep-previous). Exported JSON Schema for editor autocomplete.
- **Request matching.** Method + path + path params + query (exact / partial) + headers (exact / regex) + JSON body (partial + JSONPath). Precomputed match index for O(log n) first-level dispatch.
- **Pass-through.** Per-route opt-in proxy to an explicit upstream with configurable timeout and structured 502 on failure. Upstream URLs validated via the shared hardened URL validator.
- **Multi-tenancy.** Tenants identified by URL path prefix, subdomain, or `X-Mockstar-Tenant` header (deployment-configurable). Per-tenant config directories, per-tenant journal, per-tenant rate limits.
- **Test-data utilities.** `{{ }}` templating with faker-style generators, request-value echo, and fixed/jittered delay simulation.
- **OpenAPI import.** Offline converter `mockstar import openapi.yaml → mocks/{tenant}/`. Runs as an isolated Bun subprocess. External `$ref` resolution disabled.
- **Observability.** JSON stdout logs, Prometheus `/metrics`, per-tenant bounded request journal, `/health` + `/ready`.
- **Error isolation.** Per-request try/catch tier + process-level `unhandledRejection`/`uncaughtException` hooks that flip `/ready` to 503 and exit for orchestrator restart.
- **Deterministic mode.** `MOCKSTAR_DETERMINISTIC=1` makes CI assertions byte-identical across runs.
- **Distribution.** `bunx mockstar`, Docker image, compiled single binary, and library embed (`import { createServer } from 'mockstar'`).
- **Admin read endpoints** (journal, metrics, ready) with two-tier token auth (per-tenant + optional root).

### Deferred to v1.1

- **Admin write API.** Runtime CRUD on mocks without filesystem access. In v1 the DevOps persona deploys via K8s ConfigMap or Docker volume mount.
- **Stateful mocks / scenarios.** Named state, transitions, sequenced responses.
- **GraphQL / gRPC mocking.**
- **Fault injection / chaos.**
- **Recording mode.** Record real traffic into mock configs from a live upstream.

### Known limitations

- Compiled binary boot SLO is `< 500 ms` vs. `< 200 ms` for bunx / library / Docker-process — runtime init overhead is out of our control (see TN4 in `.manifold/mockstar.md`).
- Production deployment requires a restart-capable orchestrator (Docker `restart=always`, K8s `RestartPolicy: Always`, systemd `Restart=on-failure`). See `docs/DEPLOYMENT.md`.

---

## [0.1.0-alpha.1] — 2026-04-13

- Initial constraint-first scaffold generated from `/manifold:m4-generate`.
