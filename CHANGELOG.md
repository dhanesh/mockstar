## [0.1.3](https://github.com/dhanesh/mockstar/compare/v0.1.2...v0.1.3) (2026-06-23)


### Bug Fixes

* **cli:** derive version from package.json (stop hardcoded constant going stale) ([cde5735](https://github.com/dhanesh/mockstar/commit/cde573529561646eaa62121603a197772137a88c))
* **release:** trigger release.yml on auto-tags (drop [skip ci]) ([b7a340b](https://github.com/dhanesh/mockstar/commit/b7a340b6d74843d7a881216b73d6b5a01e112489))

## [0.1.2](https://github.com/dhanesh/mockstar/compare/v0.1.1...v0.1.2) (2026-06-23)


### Bug Fixes

* **cli:** recognize the `serve` subcommand keyword ([288edc5](https://github.com/dhanesh/mockstar/commit/288edc527d56f09dd5965488e7edd8b0b6e5716d))

## [0.1.1](https://github.com/dhanesh/mockstar/compare/v0.1.0...v0.1.1) (2026-06-23)


### Bug Fixes

* **schema:** regenerate schema/VERSION for 0.1.0 ([7766ad7](https://github.com/dhanesh/mockstar/commit/7766ad777f0cb38c8c0e82930735620e5df59b8c))

# Changelog

All notable changes to Mockstar are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — v1.0 scope (target)

> Satisfies RT-11 (v1 scope explicitly documented).

### In v1.0

- **Mocking.** Static mocks; dynamic mocks via named JS handlers loaded from `handlers/`.
- **Scenarios.** Attribute-keyed branching within a single mock entry — different responses for different request shapes without separate files. See `docs/SCENARIOS.md`.
- **Outbound webhooks.** Per-route `webhooks: [...]` fire after the matched response flushes. HMAC-SHA256 signing (opt-in, env/file secrets), explicit retry curves with circuit breaker, drop-oldest queue cap, sync await admin endpoint for SDET assertions, optional response-body assertion, post-restart JSONL journal file. In-process queue (no Redis). See `docs/webhooks/`.
- **Config.** JSON mock configs validated by Zod at boot (fail-fast) and on hot-reload (warn-and-keep-previous). Exported JSON Schema for editor autocomplete.
- **Request matching.** Method + path + path params + query (exact / partial) + headers (exact / regex) + JSON body (partial + JSONPath). Precomputed match index for O(log n) first-level dispatch.
- **Pass-through.** Per-route opt-in proxy to an explicit upstream with configurable timeout and structured 502 on failure. Upstream URLs validated via the shared hardened URL validator.
- **Multi-tenancy.** Tenants identified by URL path prefix, subdomain, or `X-Mockstar-Tenant` header (deployment-configurable). Per-tenant config directories, per-tenant journal, per-tenant rate limits.
- **Test-data utilities.** `{{ }}` templating with faker-style generators, request-value echo, `{{ env.X }}` interpolation, and fixed/jittered delay simulation.
- **OpenAPI import.** Offline converter `mockstar import openapi.yaml → mocks/{tenant}/`. Runs as an isolated Bun subprocess. External `$ref` resolution disabled.
- **Observability.** JSON stdout logs, Prometheus `/metrics`, per-tenant bounded request journal, `/health` + `/ready`.
- **Error isolation.** Per-request try/catch tier + process-level `unhandledRejection`/`uncaughtException` hooks that flip `/ready` to 503 and exit for orchestrator restart.
- **Deterministic mode.** `MOCKSTAR_DETERMINISTIC=1` makes CI assertions byte-identical across runs.
- **Distribution.** `bunx mockstar`, Docker image, compiled single binary, and library embed (`import { createServer } from 'mockstar'`).
- **Admin read endpoints** (journal, metrics, ready) with two-tier token auth (per-tenant + optional root).

### Deferred to v1.1

- **Admin write API.** Runtime CRUD on mocks without filesystem access. In v1 the DevOps persona deploys via K8s ConfigMap or Docker volume mount.
- **Stateful mocks.** Named state, transitions, sequenced responses. (Scenarios shipped — see "In v1.0".)
- **GraphQL / gRPC mocking.**
- **Fault injection / chaos.**
- **Recording mode.** Record real traffic into mock configs from a live upstream.
- **Webhook auto-resume across restart.** Pending in-flight retries are lost on restart — `--webhook-journal-file` persists delivery records but does not auto-replay them on next boot. Cross-restart replay is a manual admin call.

### Known limitations

- Compiled binary boot SLO is `< 500 ms` vs. `< 200 ms` for bunx / library / Docker-process — runtime init overhead is out of our control (see TN4 in `.manifold/mockstar.md`).
- Production deployment requires a restart-capable orchestrator (Docker `restart=always`, K8s `RestartPolicy: Always`, systemd `Restart=on-failure`). See `docs/DEPLOYMENT.md`.

## Tier 1 — HTTPS transparent upstream (`mockstar proxy`)

_Constraint-first designed in `.manifold/tier1-https-proxy.md`. Binding constraint: RT-1 (local CA)._

### In v1 proxy

- **HTTPS termination** on `127.0.0.1:443` via Bun's TLS stack.
- **Local CA** managed by [mkcert](https://github.com/FiloSottile/mkcert). CA common name includes user + hostname for self-identification (S5).
- **On-demand leaf certificates** with 24-hour TTL (TN4); SNI-gated issuance refuses unknown hostnames (RT-3, S3).
- **DNS** via dnsmasq (default) with automatic `/etc/hosts` fallback on hostile environments (RT-5 + TN2).
- **Port 443 binding** via OS capability grants (Linux setcap / macOS launchd) — no sudo at runtime.
- **Atomic install / uninstall** with append-only journal at `~/.mockstar/install-state.json`; LIFO rollback on failure (RT-7).
- **Environment hostility detection** refuses install in CI/container environments (S4), warns on MDM / VPN DNS overrides (RT-10).
- **Observability** reuses mockstar's logger + metrics primitives (RT-9).
- **CLI** integrated as `mockstar proxy {install|start|uninstall|status|reload}`.
- **Node.js gotcha** prominently documented: `NODE_EXTRA_CA_CERTS` required for Node-based SDKs (U4).

### Deferred to v1.1 (proxy)

- **Windows** native support. v1 is macOS + Linux only (B2). WSL2 works today.
- **Traffic recording** — proxy observes but doesn't persist request/response bodies.
- **Mutual TLS** (client-cert auth).
- **Request transformation** — header rewrites, body mutation, etc.
- **Wildcard hostnames** — configure subdomains explicitly in v1.
- **OS keychain-backed CA key** — rootCA-key.pem lives in mkcert's default path with 0600 file perms today; keychain storage (Touch-ID-gated on macOS) is a v1.1 hardening.

### Proxy known limitations

- First TLS handshake per hostname is slower (~50–100 ms cert generation); subsequent handshakes hit the cache (~sub-ms).
- SDKs that pin certificate fingerprints (not CAs) cannot be proxied. No known Razorpay/Stripe/Twilio SDK currently pins.
- Production deployment is explicitly out of scope — this is a developer-laptop tool (B3).

---

## Outbound webhooks

_Constraint-first designed in `.manifold/webhooks.md`. Binding constraint: RT-1 (in-process queue primitive). 26 constraints, 7 tensions, 16 required truths, all SATISFIED at TESTED level._

### In v1 webhooks

- **Per-route attachment.** `webhooks: WebhookSpec[]` field on any `MockEntry` (T5). Fires after matched response flushes via `queueMicrotask` — served-request latency unaffected (T4).
- **Configuration channels.** Per-route `url`, `{{ env.NAME }}` interpolation, admin API list/journal/replay/await endpoints, opt-in `X-Mockstar-Webhook-Url` request header (B2, B5).
- **Industry-standard delivery contract.** At-least-once-within-bounds, exponential backoff with ±jitter (default `[1s, 2s, 4s, 8s, 16s]`), idempotent `X-Mockstar-Delivery-Id` (B3).
- **HMAC-SHA256 signing.** Opt-in per webhook. Stripe-style `${ts}.${rawBody}` signed payload, configurable signature/timestamp headers, default 5-min replay window. Secrets via `{{ env.X }}` or `file:/path` only — inline rejected at config-load (S1, S3, RT-2).
- **In-process queue.** `p-queue` for concurrency, hand-rolled retry loop for explicit backoff arrays. Per-tenant isolation, drop-oldest cap (default 1024), `webhook_queue_dropped_total` counter on overflow (T1, O1, TN2).
- **Per-webhook circuit breaker.** Three-state machine (closed/open/half-open), default 5-failure threshold + 30s cooldown (O3).
- **Hardened URL validation.** Reuses `validateUpstreamUrl` from the proxy. HTTPS-only by default; per-webhook `allowHttp` and `allowPrivateNetworks` opt-ins are independent (T6, S2, TN4).
- **Admin path skip.** `/_mockstar/*`, `/__admin/*`, `/health`, `/ready`, `/metrics` NEVER trigger webhooks regardless of `match.path` (S4).
- **Sync await.** `POST /__admin/tenants/:t/webhooks/await?id=…` resolves on terminal state — eliminates flaky polling in SDET test suites (U1, TN3).
- **Replay.** `POST /__admin/tenants/:t/webhooks/:deliveryId/replay` re-enqueues using the current snapshot's spec; 410 if the spec was removed since the original delivery (O4, TN7).
- **Optional `--webhook-journal-file <path>`** appends every delivery attempt as JSONL for post-restart forensic replay (T2, INT-1).
- **Observability.** Five Prometheus metrics + Grafana dashboard + alert rules + two runbooks (queue overflow, circuit trip).

### Deferred for webhooks

- **Auto-resume across restart.** In-flight retries are lost on restart by design (TN6, in-memory only). `--webhook-journal-file` plus admin replay is the supported workflow.
- **Type-preserving JSON-body templating for webhook payloads.** Bodies render as strings (whole-string templates only); type-preservation for JSON leaves matches response-body semantics — deferred to v0.2.
- **Pluggable queue interface.** No `WebhookQueue` extension contract pre-1.0 — hand-rolled-lean discipline holds. Re-evaluate if SDETs request durable queuing.
- **Public `# TYPE` lines in metrics output.** Cross-feature gap; counters and histograms also lack them. Tracked separately.

### Webhook known limitations

- HMAC-SHA256 is the only signing algorithm in v0.x.
- Replay templates render against an empty inbound-request snapshot — `{{ request.body.x }}` resolves to empty string. Documented as a recovery-tool semantics, not a wire-replay primitive.
- High-concurrency `AbortSignal.timeout` socket hygiene is functionally tested but not load-tested (post-deploy SRE concern).

---

## [0.1.0] — 2026-06-23

First stable release — consolidates the `0.1.0-alpha`/`rc` line into a signed,
multi-arch, container-first distribution.

### Added
- **Signed multi-arch container** at `ghcr.io/dhanesh/mockstar` (`linux/amd64` +
  `linux/arm64`), cosign-signed by digest with a CycloneDX SBOM + Trivy scan;
  SLSA build provenance on stable tags.
- **Helm chart** (`charts/mockstar`) — single-replica, secure-by-default (non-root
  uid 10001, read-only root FS, dropped caps), `/health` + `/ready` probes,
  per-tenant ConfigMap mounts, optional handlers mount; published as a signed OCI
  artifact at `ghcr.io/dhanesh/charts/mockstar`.
- **Automated versioning** via semantic-release (conventional commits → tag →
  release pipeline). See `docs/releasing.md`.

### Changed
- npm package scoped to `@dhaneshpurohit/mockstar`; npm publish is opt-in via the
  `PUBLISH_NPM` repo variable (container/helm/binaries publish regardless).
- Minimum supported Bun raised to **1.3.0** (pinned toolchain `1.3.14`).

### Verified
- Outbound webhooks (delivery, request-reflection templating, HMAC-SHA256 signing,
  `expectResponse` fan-out); DNS-resolving SSRF guard; circuit-breaker single
  half-open probe. CI green across the Bun matrix (1.3.0 + latest).

## [0.1.0-rc.1] — 2026-04-20

> Satisfies RT-18 (CHANGELOG-gated release) — first tagged artifact the release workflow is expected to build end-to-end.

### Added (distribution-packaging manifold)
- **Pinned Bun runtime** via `.bun-version` (RT-1). All workflows read it.
- **Dual-URL JSON Schema hosting** at `schemas.mockstar.dev/v0/` (rolling) and `/v0.N/` (immutable) via `schema-publish.yml` (RT-2). `docs/SCHEMA-HOSTING.md` documents the contract.
- **`mockstar init [dir]`** — scaffolds `mocks/default/example.json` + `mockstar.config.json` with `$schema` pinned to the current minor (RT-13, RT-14).
- **`mockstar migrate --schema --from vX.Y --to vX.Z`** — rewrites `$schema` URLs when a minor bump ships (RT-2).
- **npm Trusted Publishing via OIDC** with auto-provenance (RT-3, RT-7). No `NPM_TOKEN` in CI.
- **Cosign keyless signing by digest** (never by tag) for container + Helm chart (RT-4).
- **CycloneDX SBOM attestation** via `cosign attest --type cyclonedx` (RT-4).
- **SLSA Level 3 build provenance** on stable releases only (TN1 resolution — pre-releases skip SLSA; RT-5).
- **`halt-clean` job** — deletes unsigned container tags if any publish step fails, so S1 ("every published artifact is signed") is never silently violated (RT-6).
- **Four-target binary matrix** via `bun build --compile` covering darwin-arm64/x64 and linux-arm64/x64, 150 MB ceiling enforced (RT-9, TN2).
- **Multi-arch container** (`linux/amd64,linux/arm64`) with `provenance: mode=max` and SBOM (RT-8).
- **Helm chart as OCI artifact** at `ghcr.io/.../charts/mockstar`, digest-preferred image resolution, labeled-ConfigMap tenant pattern that survives `helm upgrade`/`rollback` (RT-10, RT-11, RT-12, TN5).
- **Per-persona 5-minute quickstart-smoke CI** (Dev / SDET / DevOps) enforcing the SLO at the job level (RT-13).
- **Trivy CVE gate** on release — CRITICAL severity, `ignore-unfixed: true`, fails on fixable CVEs (RT-19).
- **SDET support matrix** covering Jest 30, Jest 29, Vitest 2, and `bun test` with runnable examples (RT-15).
- **Team + versioning docs** — `CONTRIBUTING.md`, `docs/TEAM-WORKFLOW.md`, `docs/VERSIONING.md`, OIDC setup checklist (RT-16, RT-17).

## [0.1.0-alpha.1] — 2026-04-13

- Initial constraint-first scaffold generated from `/manifold:m4-generate`.
