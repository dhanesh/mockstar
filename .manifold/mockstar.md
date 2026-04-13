# mockstar

## Outcome

A Bun-based mock server that supports the following capabilities:

- **Static mocking** — serve predefined responses for configured routes.
- **Dynamic mocking** — compute responses at request time based on input.
- **JSON-file configuration** — all mocking behavior definable via JSON config files.
- **Named JavaScript function handlers** — special dynamic behavior implemented as named JS functions, referenced from JSON config.
- **Pass-through routing** — specific routes transparently proxy to upstream real services.
- **Multi-tenancy** — isolated mock configurations per tenant.
- **Test data utilities** — built-in helpers to format and generate test-related data.

Quality bar: at parity with established open-source mock servers on GitHub, plus the conveniences Developers, DevOps engineers, and SDETs need for a fully testable environment.

---

## Constraints

### Business

#### B1: Open-source, MIT-licensed, public distribution

Mockstar is licensed under MIT, developed in a public GitHub repository, and published to npm.

> **Rationale:** Matches the OSS norms of WireMock / Mockoon / MSW. MIT maximises embedding freedom in commercial codebases; public dev is a prerequisite for community contribution and trust.

#### B2: Feature parity with core OSS mock-server capabilities

Achieve functional parity with the core open-source capabilities of WireMock and Mockoon for: static + dynamic mocking, JSON-file configuration, pass-through proxying, request matching on method/path/query/headers/body, and test-data utilities.

> **Rationale:** The stated outcome demands parity with established OSS mock servers. Explicit scoping against two reference tools creates a checkable bar. Parity is the price of admission; differentiation comes from Bun performance + multi-tenancy + DX.

#### B3: v1 scope bounded to table-stakes + proxy-record + OpenAPI import

v1 ships: static/dynamic mocks, JSON config, named JS handlers, pass-through proxy (with optional request journaling sufficient for replay analysis), OpenAPI 3.x offline import. v1 explicitly defers: stateful/scenario mocks, GraphQL, gRPC, fault-injection/chaos, full scenario engines.

> **Rationale:** Pre-mortem risk #1-3: ambitious scope with shallow polish loses to established tools. A hard line on v1 protects execution focus.

#### B4: Three personas supported equally

SDETs (CI test harness), DevOps engineers (shared staging / cluster deployment), and Developers (laptop dev-loop) are all first-class users. Feature and UX decisions must work for all three, not favour one.

> **Rationale:** User-stated positioning. Choosing one persona would constrain the tool's reach; choosing all three forces harder architectural trade-offs (captured in downstream constraints).

---

### Technical

#### T1: Bun runtime + Hono HTTP framework

The server is built on Bun (`Bun.serve`) with Hono as the HTTP routing/middleware layer.

> **Rationale:** Hono's radix-trie router is mature and well-matched to mock-server routing needs. Hono on Bun delivers ~1.2M req/s — ample headroom for a mock server and leaves room for per-request work (matching, templating, journaling) within the latency budget (T3). Hono is portable if we ever need non-Bun targets; Elysia would lock us in.

#### T2: Rich request matching

Mock definitions can match on: HTTP method, path + path parameters, query parameters (exact and partial), headers (exact and regex), and JSON request body (partial matching + JSONPath expressions).

> **Rationale:** Modern APIs cannot be mocked with method+path alone. JSON body + JSONPath is table-stakes — both WireMock and MockServer ship it. Without it, dynamic workflows (conditional responses based on request shape) require named handlers for trivial cases and erode ergonomics.

#### T3: Static mock latency p99 < 5ms, p50 < 1ms

For a cache-resident static mock match (no handler invocation, no templating), end-to-end response latency measured from request-received to response-sent must satisfy p99 < 5 ms and p50 < 1 ms on commodity dev hardware under ≥1K RPS load.

> **Rationale:** Bun + Hono's raw performance is the project's primary differentiator vs. WireMock (JVM startup + GC) and Mockoon (Electron). Setting the latency bar aggressively here prevents feature accretion from quietly eroding it.

**Threshold:** `kind: statistical, p99: 5ms, p50: 1ms`

#### T4: Cold boot < 200ms (100-mock config)

`mockstar start` must reach ready-to-serve in under 200 ms when loading a representative ~100-mock config.

> **Rationale:** SDETs set up and tear down per test-run. Slow boots multiply across a CI matrix. Mockoon and WireMock both suffer here; a fast boot is a real differentiator.

**Threshold:** `kind: deterministic, ceiling: 200ms`

#### T5: Named JS handlers loaded from `handlers/` directory

Dynamic handlers are `.ts` / `.js` files in a configured `handlers/` directory, each exporting a named function. JSON config references handlers by name only. Handler loading is restricted to the configured directory — no absolute paths, no `..` path escapes, no inline code in JSON.

> **Rationale:** Simple mental model (name → file). Forbidding inline JS in JSON eliminates a large class of RCE risk when configs are user-generated or shared. Restricting to a single directory prevents path-traversal attacks via crafted config values.

#### T6: Handler-reference integrity enforced at boot

Every handler name appearing in JSON config must resolve to a loaded handler in the registry. Unresolved references cause boot failure with the specific missing names listed.

> **Rationale:** Pre-mortem #2-3: stringly-typed references between JSON config and TS handlers silently rot — a rename in a PR passes type-check, config still points at old name, mocks 404 in CI a week later. Boot-time cross-check eliminates this failure mode.

#### T7: Zod-validated config with fail-fast boot + tolerant hot-reload

All JSON mock configs are validated against a Zod schema. At boot, invalid config causes a hard exit with line-specific errors. On hot-reload, an invalid change is logged as a warning and the previous valid config is retained — the server does not go down mid-test. An equivalent JSON Schema is exported to enable editor autocomplete.

> **Rationale:** Boot is a developer-present event; failure there is recoverable. Runtime failure during a test is not recoverable — preserving last-known-good is the correct bias. Zod is the Bun/TS-native choice; exported JSON Schema gives editor support without handwritten duplicates.

#### T8: Per-tenant-scoped file-watch hot reload

File-watch observes `./mocks/{tenant}/*.json` per tenant directory. Changes to tenant A's files reload only tenant A's config; other tenants are unaffected.

> **Rationale:** Global reloads on a multi-tenant staging instance would blast-radius into unrelated test runs. Per-tenant scoping preserves isolation (S1) during a core developer workflow.

#### T9: Per-route pass-through with timeout + diagnostic errors

Pass-through is declared per mock entry (`passthrough: "https://api.upstream.com"`). Each pass-through has a configurable request timeout (default 30s). Upstream timeouts or network errors surface as a 502 response with a diagnostic body (original upstream, duration, error class).

> **Rationale (GAP-11):** External HTTP dependencies need explicit resilience primitives. Configurable timeout + structured failure response lets downstream tests distinguish "upstream is down" from "mock misconfigured" — the most common debugging confusion in proxying mock servers.

#### T10: Handler crash isolation

Errors thrown, rejected, or otherwise escaping a handler invocation (sync throw, async rejection, timeout) must be caught, logged, and returned as a 500 with a safe diagnostic body. The server process must never crash due to a handler fault.

> **Rationale:** Pre-mortem #1-1. We chose "no sandbox" for simplicity (T5) — this shifts the burden to a robust per-invocation error boundary. Without it, one team's bad handler takes down a shared staging instance and destroys trust.

#### T11: Atomic config hot-swap

Config replacement (file change, reload command) must be atomic from a request's perspective: any in-flight request sees a consistent snapshot of the config it started with, never a partial mix.

> **Rationale (GAP-17):** Bun is single-event-loop per process, but async handlers interleave with reloads. Without immutable snapshot + atomic pointer swap, a mid-request reload could match against one version of routes and template against another. Intermittent, unreproducible failures follow.

---

### User Experience

#### U1: Unmatched requests return diagnostic 404

Requests that match no mock return HTTP 404 with a structured JSON body containing: the received method + path, the tenant context, and up to 3 nearest-match suggestions (mocks that partially matched, with explanations of which predicates failed).

> **Rationale:** "Why didn't my mock fire?" is the #1 pain point across every mock server. A diagnostic 404 turns a silent miss into an actionable error and collapses debug time from minutes to seconds.

#### U2: Four distribution channels

Mockstar ships via: (a) npm package for `bunx mockstar`, (b) Docker image on GHCR, (c) single compiled binary via `bun build --compile`, (d) library-embed API (`import { createServer } from 'mockstar'`) for programmatic use inside test suites.

> **Rationale:** Each channel maps to a persona — bunx for developers, Docker for DevOps, binary for offline/Windows CI, embed for SDETs. Covering all four was an explicit user choice (see B4).

#### U3: Readable CLI output

The CLI produces readable, structured output covering: startup summary (mocks loaded per tenant, ports, tenancy mode), per-request match/miss events in development mode, and reload result summaries. Colour-aware; respects `NO_COLOR`.

> **Rationale:** Developer-loop persona (B4) lives in the terminal. A noisy or unreadable CLI is a daily tax that gets the tool abandoned in favour of ones with better feedback loops.

#### U4: Built-in response-templating helpers

Static mock bodies support templating helpers: faker-style generators (names, emails, UUIDs, dates, booleans, integers), handlebars-like `{{ }}` token interpolation, request-value echo (`{{request.body.userId}}`, `{{request.query.page}}`), and delay simulation (fixed + jittered).

> **Rationale:** These four helpers together eliminate ~70% of cases that would otherwise require a named JS handler. Ergonomics gain; named handlers become the escape hatch, not the norm.

#### U5: OpenAPI 3.x offline converter

`mockstar import openapi.yaml --out ./mocks/default/` consumes an OpenAPI 3.0 or 3.1 document and emits Mockstar JSON config that serves each operation's example response. Converted configs are editable and are the source of truth — no runtime OpenAPI ingestion.

> **Rationale:** Offline conversion keeps the runtime simple and the config Git-versioned. Prism's "live OpenAPI" model couples two sources of truth; our choice avoids it.

#### U6: Deterministic mode for CI

A `MOCKSTAR_DETERMINISTIC=1` mode disables file-watch, seeds faker, disables jittered delays, and normalises timestamps in logs. Output of the same request against the same config must be byte-identical across runs.

> **Rationale:** Flaky tests destroy SDET trust. Deterministic mode lets test authors snapshot-test mock responses and rely on exact comparisons in assertions.

---

### Security

#### S1: Hard tenant isolation

A request routed to tenant A can never match, be served by, or observe mocks defined for tenant B. Tenancy determination is the first routing decision; subsequent routing operates within a tenant scope. Journal and metrics are partitioned by tenant.

> **Rationale:** Cross-tenant leaks undermine the entire multi-tenancy value proposition. One documented cross-tenant bug would force enterprise users to one-instance-per-service and abandon multi-tenancy.

#### S2: Three tenant-identification modes, configurable per deployment

Tenants are identified via one of: (a) URL path prefix `/t/{tenant}/...`, (b) subdomain `{tenant}.mockstar.local`, (c) `X-Mockstar-Tenant` header. At least one mode must be enabled per deployment; multiple may be enabled with documented precedence.

> **Rationale:** Different deployment environments can't rewrite URLs (container sidecars), can't set up DNS (ephemeral CI), or can't add headers (legacy clients). Supporting all three covers the full persona matrix (B4).

#### S3: Admin endpoints disabled by default, bearer-token auth when enabled

Admin-surface endpoints (journal, metrics, `/ready` — excluding `/health`) are disabled unless `MOCKSTAR_ADMIN_TOKEN` env var is set. When enabled, they require an `Authorization: Bearer <token>` header. Token comparison uses constant-time equality to prevent timing side-channels.

> **Rationale:** Safe-by-default. A user who never touches the env var cannot accidentally expose the admin surface. Constant-time compare closes a subtle but well-known attack vector on shared-secret auth.

#### S4: Localhost-bind by default

The HTTP listener binds to `127.0.0.1` by default. Binding to `0.0.0.0` or a public interface requires an explicit `--host` / `MOCKSTAR_HOST` configuration and emits a boot-time warning.

> **Rationale:** Prevents pre-mortem #3-3 (user exposes admin to internet). Developer-laptop and ephemeral-CI don't need external reachability; explicit opt-in for DevOps/staging use.

#### S5: Per-tenant request body size cap + rate cap

Each tenant has a configurable max request body size (default 1 MB) and a configurable request rate cap (default 1000 req/s per tenant). Exceeding returns 413 / 429 respectively with tenant context in the body.

> **Rationale (GAP-10):** Mock endpoints are usually unauthenticated; without caps, a single misconfigured client can exhaust memory (oversized bodies) or starve other tenants (request floods). Per-tenant caps preserve isolation (S1) under abuse.

#### S6: Pass-through URL validation — scheme allowlist + SSRF guard

Pass-through upstream URLs are validated at config parse time: scheme must be in an allowlist (`https` by default; `http` only if explicitly enabled). Private/loopback/link-local IP ranges are rejected unless the deployment opts into `allowPrivateUpstreams: true`. Validation re-runs if templating can alter the upstream URL.

> **Rationale:** Pass-through is a classic SSRF vector — an attacker-controlled mock config pointing upstream at `http://169.254.169.254/` (cloud metadata) or `http://localhost:8080` (internal admin) becomes an exfiltration tool. Scheme allowlist + private-range rejection closes the default-exploitable paths; explicit opt-in remains for legitimate internal-API use.

---

### Operational

#### O1: Structured JSON logs per request

Each served request emits a single structured JSON log line to stdout containing: timestamp, tenant, method, path, matched mock ID (or `null`), status code, latency in microseconds, and a request-ID. No unstructured logs on the hot path.

> **Rationale:** Stdout JSON lines are consumed by every log aggregator without preprocessing. Single-line-per-request simplifies parsing and replay; request-IDs make it trivial to correlate with external tests.

#### O2: Prometheus metrics endpoint

A `/metrics` endpoint (under admin auth per S3) exposes Prometheus-format metrics: request count by tenant / status / matched-mock, latency histogram, match-rate, pass-through request count + upstream-error count, journal size per tenant, reload counters.

> **Rationale:** Shared-staging persona (B4) operates inside Prometheus-instrumented clusters. `/metrics` is the default contract; anything else requires custom exporters and adoption friction.

#### O3: Per-tenant bounded request journal

Each tenant maintains a bounded ring buffer of the last N (default 1000) served requests, queryable via `GET /__admin/tenants/{t}/journal`. Writes are O(1). Reads do not block the request-serving path. Oldest entries are overwritten when full.

> **Rationale:** SDETs need post-hoc assertions ("did my code-under-test hit this endpoint?"). Bounded memory keeps a long-running staging instance from OOMing. Non-blocking reads prevent journal inspection from degrading latency (T3).

#### O4: Health + readiness endpoints

`/health` (unauthenticated, lightweight — returns 200 if the process is up) and `/ready` (returns 200 only when at least one tenant's config has loaded successfully). Both return plain-text JSON; no heavy computation.

> **Rationale:** K8s readiness probes and CI orchestrators depend on these. `/health` must remain unauthenticated for external probing to work; `/ready` distinguishes "process alive" from "ready to serve".

#### O5: CI benchmark gate on latency regression

A benchmark suite runs on every CI build, asserting T3 (latency p99/p50) and T4 (boot time) within tolerance. Regression above threshold (e.g., +10%) blocks merge.

> **Rationale:** Pre-mortem #1-4. Latency drifts silently as features accrete. A CI gate is the only mechanism that catches it before users do.

**Threshold:** `kind: deterministic, ceiling: "+10% vs baseline for p99 and boot time"`

#### O6: Bun version policy + minimal audited dependency surface

The project declares a minimum supported Bun version (e.g., Bun 1.2+) and tests on both the minimum and the latest-stable in CI. Every runtime dependency is audited for Bun compatibility before inclusion; incompatible deps are either replaced or the feature is cut.

> **Rationale:** Pre-mortem #2-4 (Bun ecosystem lag — patched-fork rot) and #3 (Bun breaking changes). Explicit minimum + upper-bound CI matrix catches breaks before users do; dependency audit prevents us from inheriting a vendored-fork maintenance tail.

---

## Tensions

### TN1: File-watch-only config vs. DevOps shared-staging persona

**Between:** T8 (per-tenant file-watch hot reload) ↔ B4 (three personas supported equally — SDETs, DevOps, Developers)

The m1 choice of file-watch as the sole mutation mechanism means DevOps operators deploying Mockstar into a shared staging cluster cannot self-serve mock changes for their tenants via an API. They must have filesystem access to the running container's config volume. This contradicts the expectation that all three personas are first-class in v1.

**TRIZ classification:** Technical contradiction — Simplicity vs Capability. Principle P1 (Segmentation) applied: split "config mutation" from "config editing" — deployment-time mutation goes through filesystem; runtime mutation is explicitly a v1.1 feature.

> **Resolution:** (A) Scope B4 in v1 to filesystem-accessible deployments (K8s ConfigMap mount, Docker volume, git-ops with rolling redeploy). Document this explicitly in README; list admin write-API as a v1.1 deliverable in CHANGELOG. Preserves the user's m1 simplicity choice while honestly communicating the v1 boundary.
>
> **Propagation:** B4 TIGHTENED — persona equality in v1 is narrower than the original phrasing. No other constraints affected.

---

### TN2: No-sandbox JS handlers vs. Handler crash isolation

**Between:** T5 (named JS handlers from `handlers/` directory, no sandbox) ↔ T10 (handler crashes must never kill the server process)

Per-request `try/catch` wrapping catches synchronous throws and awaited promise rejections. But a handler that fires a promise without awaiting it and that promise rejects will reach Node/Bun's process-level `unhandledRejection` event. Bun 2026 best-practice (and the official issue #429 guidance) is that these handlers should log and **exit the process** rather than swallow the error, because a process that has unhandled rejections is already in potentially-corrupted state.

**TRIZ classification:** Physical contradiction — the process must simultaneously "stay up" (T10) and "exit on corrupted state" (Bun best-practice). Principle P11 (Beforehand cushioning: fallbacks) + P24 (Intermediary: per-request wrapper) + P27 (Cheap short-living: crash-only design with fast restart).

> **Resolution:** (A) Three-tier isolation architecture:
> 1. **Per-request try/catch** — catches all synchronous throws and all `await`ed promise rejections. Handler fault becomes a 500 response with safe diagnostic body. Server stays up. This is the common path (~99% of handler errors).
> 2. **Process-level `unhandledRejection` + `uncaughtException` hooks** — for fire-and-forget rejections and truly uncatchable errors. Emits a structured crash log, flips `/ready` to 503 (so load balancers drain), then exits the process.
> 3. **Orchestrator restart** — Docker `restart=always` / K8s `RestartPolicy=Always` / systemd `Restart=on-failure` brings the process back. Documented as a production requirement.
>
> Developer documentation warns: handlers must `await` their promises, and a lint rule catches non-awaited promise returns in the handler directory.
>
> **Propagation:** T10 TIGHTENED (now split into 3 tiers); O4 TIGHTENED (`/ready` flips to 503 on unhandledRejection); O6 TIGHTENED (minimum Bun version raised to 1.1.8+ for reliable process hooks).
>
> **Failure cascade** (GAP-06 analysis — documented in JSON `failure_cascade`):
> - Tier 1 fails (try/catch) → impossible; deterministic wrapping.
> - Tier 2 fails (log write fails) → stderr fallback; if both streams gone, process is terminal anyway.
> - Tier 3 fails (no orchestrator) → documented as local-dev-only path; production requires an orchestrator.
> - Tier 4 fails (orchestrator crash-loops a persistently-faulting handler) → K8s CrashLoopBackOff surfaces to ops; runbook diagnoses via structured crash logs.

---

### TN3: Latency budget vs. rich per-request work

**Between:** T3 (p99 < 5ms, p50 < 1ms) ↔ T2, U4, O1, O2, O3 (JSONPath matching, templating, structured logging, metrics, journal — all on the hot path)

The latency budget is the project's primary differentiator against WireMock and Mockoon. Every per-request feature erodes it. Adding JSON-body JSONPath matching + handlebars-style templating + JSON-line logging + Prometheus metrics + per-tenant journal, naively implemented, would push p99 well past 5ms.

**TRIZ classification:** Technical contradiction — Performance vs. Capability. Principle P10 (Prior action: precompute/cache) + P1 (Segmentation: separate hot path from warm path) + P17 (Another dimension: move work off the request thread).

> **Resolution:** (A) Engineered hot-path design, enforced as sub-constraints:
> - **Matching:** Match index precomputed at config-load time. Primary index is method+pathPattern (radix trie). Discriminators (query, headers, body) checked only on pattern hit, evaluated in priority order with early exit. No linear scan.
> - **Templating:** `{{ }}` expressions compiled at config-load to an op sequence. No per-request parsing of template strings.
> - **Logging:** JSON log serialization + stdout write deferred via `queueMicrotask` after the response is sent. Log formatting never blocks the response.
> - **Metrics:** Atomic counters only on the hot path. Histogram bucket increment is O(1). No allocation per request.
> - **Journal:** Pre-allocated ring buffer, fixed size per tenant. Write is a single indexed assignment. Reads use snapshot semantics to avoid blocking writes.
> - **Cache-invalidation (GAP-16):** When config hot-reloads (T8), the match index is rebuilt in the background; atomic pointer swap makes the new index active. Old index is retained until in-flight requests drain.
>
> **Budget allocation** (at p99, 1ms targets for p50):
> - Matching: ≤ 1ms
> - Response serialization: ≤ 1ms
> - Logging + metrics + journal (deferred): ≤ 0.5ms of post-response work
> - Leaves ~2.5ms headroom for unexpected GC / kernel latency
>
> **Propagation:** T2 TIGHTENED (index-based matching, no linear scan); U4, O1, O2, O3 all TIGHTENED with specific performance properties.

---

### TN4: Four distribution channels vs. fast cold boot

**Between:** U2 (bunx + Docker + compiled binary + library embed) ↔ T4 (< 200ms cold boot)

`bun --compile` bundles the Bun runtime into a standalone executable. Cold-start of that binary includes runtime initialisation (JSC warmup, module load) that a hot bunx invocation skips. Docker container start adds layer unpacking + cgroup setup before Mockstar's own process even begins. Asking all four channels to meet 200ms uniformly is unrealistic; asking none to meet it abandons the SDET boot-speed promise.

**TRIZ classification:** Technical contradiction — Universality vs. Specialisation. Principle P3 (Local quality: different strategies per channel).

> **Resolution:** (A) Per-channel boot SLOs, measured and published:
> - **bunx / npm `npx`:** Mockstar process < 200ms to ready.
> - **Library embed (`createServer()`):** < 200ms to `listen()` callback.
> - **Docker image:** Mockstar process < 200ms post-container-ready; container-start overhead (image pull, cgroup) is out-of-scope.
> - **Compiled binary (`bun --compile`):** < 500ms cold; documented as the trade-off for zero-install portability.
>
> Each channel has its own CI benchmark gate with its own threshold (extends O5).
>
> **Propagation:** T4 TIGHTENED for three channels, LOOSENED for binary; U2 preserved in full.

---

### TN5: Admin endpoints vs. tenant isolation

**Between:** O3 + O2 + S3 (admin journal, metrics, bearer-token auth) ↔ S1 (hard tenant isolation)

A single admin token that can read every tenant's journal effectively becomes a cross-tenant read primitive. One compromised token defeats the isolation promise — a critical failure for the multi-tenant story.

**TRIZ classification:** Technical contradiction — Simplicity vs. Safety. Principle P1 (Segmentation: per-tenant authentication) + P3 (Local quality: per-tenant scope).

> **Resolution:** (A) Two token tiers:
> - **Per-tenant admin token** — defined per-tenant in config. Grants read access only to that tenant's admin endpoints (journal, ready, per-tenant metrics). Cannot read any other tenant.
> - **Root token** (optional, via `MOCKSTAR_ROOT_TOKEN` env var) — grants access to aggregated `/metrics` and cross-tenant health views. Explicitly cannot read per-request data (journal).
>
> Both tokens compared with constant-time equality. Config schema (T7) extended with optional `adminToken` per-tenant and optional global `rootToken`. Compromise blast radius is now one tenant unless the operator has enabled root and that is also leaked.
>
> **Propagation:** S3 TIGHTENED (two token types, distinct scopes); S1 LOOSENED (strengthened in practice — isolation survives admin token compromise); T7 TIGHTENED (schema additions).

---

### TN6: OpenAPI import vs. SSRF / parsing safety

**Between:** U5 (offline OpenAPI import) ↔ S6 (SSRF guard for pass-through URLs) + broader OpenAPI attack surface

Active 2026 CVEs on OpenAPI tooling — [mcp-from-openapi CVE-2026-39885](https://advisories.gitlab.com/pkg/npm/mcp-from-openapi/CVE-2026-39885/) (SSRF + local file read via `$ref` dereferencing) and [FastMCP CVE-2026-32871](https://advisories.gitlab.com/pkg/pypi/fastmcp/CVE-2026-32871/) (path-traversal SSRF via unescaped path parameters) — demonstrate that OpenAPI parsers, even for offline use, are a live attack surface. A malicious spec can exfiltrate cloud metadata, read local files, or pivot to internal services.

**TRIZ classification:** Technical contradiction — Capability vs. Safety. Principle P2 (Extraction: separate the risky parser into its own process) + P24 (Intermediary: validation layer between parser and server).

> **Resolution:** (A) Hardened importer, run out-of-process:
> 1. **Disable external `$ref`** — the importer only follows `$ref` within the same document. `http://`, `https://`, `file://` are rejected with clear errors. No dereferencing happens against the network or filesystem.
> 2. **URL-encode path parameters** — path param substitutions are `encodeURIComponent`-wrapped. `..`, `/`, `?`, `#` are treated as literals.
> 3. **Apply S6 validation to every `servers[].url`** — OpenAPI server URLs flow into Mockstar config as pass-through targets; they must pass S6's scheme allowlist + private-range check at import time.
> 4. **Isolated subprocess** — the importer runs as a separate Bun subprocess invoked by the CLI. It has no access to running-server state or secrets. Its only output is a config file written to the requested directory.
>
> **Propagation:** U5 TIGHTENED (importer complexity grows by ~500 LOC; isolated subprocess architecture); S6 LOOSENED (scope expanded to cover OpenAPI server URLs — a clarification, not a new burden).

---

### TN7: Handler-reference integrity depends on handler registry

**Between:** T6 (handler-reference integrity enforced at boot) ← T5 (named JS handlers loaded from `handlers/` directory)

T6 cannot verify handler references exist unless T5's handler registry is built first. This is a sequencing dependency, not a trade-off. Implementation must land T5 before T6; otherwise T6's tests yield false passes or sequencing errors.

> **Resolution:** (sequencing) T5 is a blocking prerequisite for T6. Recorded in `blocking_dependencies` so m3-anchor treats T5-derived Required Truths as higher priority. m5-verify will check that T6's tests run against a non-empty registry.
>
> **Propagation:** T6 TIGHTENED (formal dependency recorded); T5 is elevated in build order.

---

## Required Truths

For the outcome — *"Bun-based mock server at parity with OSS mock servers, plus the conveniences developers/DevOps/SDETs need for a fully testable environment"* — the following must be true. Backward-derived from the constraint set + 7 tension resolutions, with depth-2 decomposition.

### RT-1: Handler registry exists and is cross-verified at boot

A loaded registry of named JS handlers, populated by scanning the `handlers/` directory at boot, is the substrate for dynamic mocking. Every handler reference in JSON config must resolve to a registry entry before the server accepts requests. *(Structural prerequisite — m2 blocking dependency T5 → T6 maps to this RT. Must land first in m4.)*

**Maps to:** T5, T6, TN7

- **RT-1.1** — `handlers/` directory discovery finds every `.ts` and `.js` file at boot using `Bun.glob` or filesystem walk.
- **RT-1.2** — Each discovered module is introspected via ESM `import()` for its named function exports; the registry is a `Map<string, Function>` keyed by handler name.
- **RT-1.3** — Zod config parse (RT-5) cross-checks every `"handler": "name"` reference against the registry during validation.
- **RT-1.4** — Missing references cause boot to exit non-zero with a line-precise error message listing each missing name and the config file + path where it was referenced.

---

### RT-2: Per-request handler fault isolation (tier 1 of TN2)

Handler exceptions and awaited-promise rejections are caught at the request boundary, converted to a 500 response with a safe diagnostic body, and the process continues serving other requests. Covers ~99% of handler error modes.

**Maps to:** T5, T10, TN2

- **RT-2.1** — Every handler invocation is wrapped: `await` + try/catch, with a fixed-budget timeout (configurable, default 5s).
- **RT-2.2** — Caught errors produce a 500 with body `{ error: "handler_fault", handler: <name>, requestId, message: <safe-slice> }` and emit a structured log entry; no stack traces leak to the client.

---

### RT-3: Process-level crash-only design (tiers 2-4 of TN2)

Fire-and-forget promise rejections and truly uncatchable exceptions trigger a graceful process exit. The orchestrator (Docker / K8s / systemd) restarts. Production deployment requires this.

**Maps to:** T10, O4, O6, TN2

- **RT-3.1** — `process.on('unhandledRejection')` and `process.on('uncaughtException')` hooks are installed at startup on Bun ≥ 1.1.8.
- **RT-3.2** — Hooks emit a structured crash log (tenant context if available, stack, request-ID if correlatable), flip an atomic `ready` flag to `false` (making `/ready` return 503), drain briefly (1s), then `process.exit(1)`.
- **RT-3.3** — Production deployment documentation prescribes restart policies for Docker (`restart=always`), K8s (`RestartPolicy: Always`), and systemd (`Restart=on-failure`). Local `bunx` dev is documented as not-for-production. **(NOT_SATISFIED — docs TBD.)**
- **RT-3.4** — A lint rule (via `eslint-plugin-promise/no-return-wrap` and `no-floating-promises` equivalent) flags non-awaited promises in the `handlers/` directory during CI.

---

### RT-4: Tenant routing is first, atomic, and immutable

The tenant for every request is resolved exactly once, as the first routing decision. All downstream code reads tenant identity from an immutable request context object. Config lookup by tenant is a direct map access — path crossing is structurally impossible.

**Maps to:** S1, S2

- **RT-4.1** — Tenant extraction runs as the first Hono middleware; identifies tenant via path prefix, subdomain, or `X-Mockstar-Tenant` header (per configured mode); attaches an immutable `{ tenant: string }` to the context.
- **RT-4.2** — All downstream handlers, matchers, and logging read tenant from `ctx.var.tenant` only; no downstream code parses headers/host/path to re-derive tenant.
- **RT-4.3** — Config lookup is `configSnapshot.tenants.get(ctx.var.tenant)` — a single map access. Cross-tenant access is not possible through the lookup API.

---

### RT-5: Config registry uses immutable snapshots with atomic swap

The active configuration is an immutable snapshot. File-watch reloads produce a new snapshot; an atomic pointer swap activates it. In-flight requests retain their original snapshot reference for their lifetime.

**Maps to:** T7, T8, T11

- **RT-5.1** — A snapshot builder reads config files, runs Zod validation (RT-1.3), builds the match index (RT-6.1), and returns a frozen object.
- **RT-5.2** — A single module-scoped `currentSnapshot` reference is replaced atomically; `Object.freeze` enforces immutability.
- **RT-5.3** — Each request captures `currentSnapshot` at the start of its middleware chain; subsequent reloads do not affect it.
- **RT-5.4** — Per-tenant file-watch (T8) builds a per-tenant sub-snapshot; tenant-scoped reloads do not touch other tenants' snapshots.

---

### RT-6: Hot path meets the latency budget under load *(BINDING CONSTRAINT)*

p99 < 5 ms, p50 < 1 ms for static-mock match + response at ≥ 1K RPS on commodity dev hardware. This is the differentiator — if it doesn't hold, Mockstar is "a less-polished WireMock" (pre-mortem #1-3).

**Maps to:** T2, T3, T4, U4, O1, O2, O3, O5, TN3

- **RT-6.1** — Match index: radix trie on method + path-pattern (first-level dispatch in O(log n)); discriminator evaluators (query, headers, body) checked in priority order only on pattern hit; compiled at config load.
- **RT-6.2** — Templating: `{{ }}` expressions compiled at config load to an op sequence (array of steps); no per-request parsing.
- **RT-6.3** — Logging + metrics + journal all deferred via `queueMicrotask()` fired after `ctx.res.send()`; response latency does not include their work.
- **RT-6.4** — Profiler-verified: no per-request heap allocation except the response body buffer. **(NOT_SATISFIED — can only be proved after phase-1 infra exists.)**
- **RT-6.5** — CI benchmark gate (per RT-10) asserts p99 < 5 ms, p50 < 1 ms at 1K RPS sustained for 60s, with 1000-mock tenant.

---

### RT-7: Two-tier admin auth enforces tenant scope

Admin endpoints require authentication tokens that cannot escalate across tenants. Compromising a tenant's admin token confines the blast radius to that tenant. A separate optional root token grants aggregate-only access.

**Maps to:** S1, S3, T7, TN5

- **RT-7.1** — Per-tenant `adminToken` field in the tenant config schema (Zod, RT-5.1). Tenant-scoped admin endpoints (`/__admin/tenants/{t}/journal`, `/ready/{t}`) require matching token; 401 otherwise.
- **RT-7.2** — Optional `MOCKSTAR_ROOT_TOKEN` env var. When set, the root token grants access to `/metrics` (aggregate only) and cross-tenant health status; explicitly denied on any per-tenant journal endpoint.
- **RT-7.3** — Both tokens compared with `Bun.password` primitives or `crypto.timingSafeEqual`; no short-circuit on length mismatch.
- **RT-7.4** — Integration test: tenant A's admin token returns 403 on `/__admin/tenants/B/journal`; root token returns 403 on any per-tenant journal.

---

### RT-8: Hardened URL validation is shared by pass-through and OpenAPI import

A single URL-validation primitive is used by both pass-through upstream declarations (S6) and the OpenAPI importer (U5). Current 2026 CVEs (mcp-from-openapi CVE-2026-39885, FastMCP CVE-2026-32871) make this non-optional.

**Maps to:** S6, T9, U5, TN6

- **RT-8.1** — Validator: scheme allowlist (`https` default; `http` opt-in); parsed URL's host is not in the private-range set (RFC 1918, loopback, link-local, CGNAT, IPv4-mapped IPv6 equivalents) unless `allowPrivateUpstreams: true`.
- **RT-8.2** — Validator runs at config parse time AND at request time when templating can alter the upstream URL (detected by presence of `{{` in the `passthrough` field).
- **RT-8.3** — OpenAPI importer constructs its `$ref` resolver with `resolve: { external: false, file: false, http: false }` — internal refs only.
- **RT-8.4** — OpenAPI path parameter substitution wraps each param in `encodeURIComponent` before template substitution; `/`, `?`, `#`, `..` cannot escape the intended path.
- **RT-8.5** — Importer invoked as `Bun.spawn(['bun', 'run', 'importer.js', ...])` subprocess; does not share memory or module cache with the running server.

---

### RT-9: Diagnostic 404 builds on nearest-match search

Unmatched requests return a 404 body that tells the developer *why* — the method + path + tenant, plus up to 3 nearest-match mocks with explanations of which predicate failed.

**Maps to:** U1, T2

- **RT-9.1** — Match index (RT-6.1) exposes a `nearestMatch(method, path)` API returning mock IDs whose method+path matched but whose discriminators (query, headers, body) did not — along with the failing predicate.
- **RT-9.2** — 404 response body structure: `{ error: "unmatched", method, path, tenant, nearest_matches: [{ mockId, failed_predicate, expected, got }] }` capped at 3 entries.

---

### RT-10: Benchmark harness runs per-channel in CI

A single benchmark harness measures RT-6 continuously and per-channel (bunx, library-embed, Docker-process, compiled-binary). Regression gate (O5) blocks merge on > 10% degradation.

**Maps to:** T3, T4, O5, TN4

- **RT-10.1** — Harness: load generator (sustained 1K RPS), latency histogram collector, ring-buffer of recent p50/p99/p999. Reusable as `bun run bench`. **(NOT_SATISFIED — harness TBD in phase 1.)**
- **RT-10.2** — CI matrix asserts: bunx/library/Docker-process p99 < 5ms and boot < 200ms; compiled binary boot < 500ms; each channel separately tracked.
- **RT-10.3** — Baseline stored in `bench/baselines.json` per channel per Bun version; regression > +10% fails the build.

---

### RT-11: v1 scope and deferred items are unambiguously documented

Users, contributors, and future maintainers understand exactly what v1 ships and what is deferred. Prevents pre-mortem #1-3 (ambitious scope with shallow polish) and honours TN1 resolution.

**Maps to:** B3, B4, TN1

- **RT-11.1** — CHANGELOG v1.0 lists shipped features + explicitly-deferred v1.1 items (admin write-API, stateful mocks, scenarios, GraphQL, gRPC, chaos).
- **RT-11.2** — README has a *Persona deployment paths* section with a worked example per persona: SDET using library embed; DevOps using K8s ConfigMap mount; Developer using `bunx mockstar ./mocks/`.

---

### RT-12: Deterministic mode is a single top-level flag

`MOCKSTAR_DETERMINISTIC=1` flips four sub-behaviours atomically, making CI assertions byte-identical across runs.

**Maps to:** U6

- **RT-12.1** — Hot-reload disabled (file watcher not started).
- **RT-12.2** — Faker initialised with a fixed seed (configurable via `MOCKSTAR_FAKER_SEED`, default `0`).
- **RT-12.3** — Delay + jitter ops skip the delay; execute immediately.
- **RT-12.4** — Log timestamps replaced with a monotonic counter; request-IDs replaced with deterministic hash of request envelope.

---

## Binding Constraint

**RT-6 — Hot path meets the latency budget under load.**

This is the emergent property that distinguishes Mockstar from WireMock/Mockoon/json-server. It is the hardest RT to close because it is not a single piece of code — it is a discipline applied across every request-path module. If it is not closed, Mockstar still works *functionally*, but there is no reason for anyone to adopt it over WireMock. The business case (B1 OSS parity + B2 "parity *plus* Bun speed") collapses.

**Dependency chain:**
- RT-5 (immutable snapshots) holds the match index that RT-6 depends on.
- RT-1 (handler registry) is the heaviest hot-path variant; its perf must be measured alongside static mocks.
- RT-10 (benchmark harness) is the instrument that verifies RT-6 continuously.

**m4 handoff:** RT-6 artifacts must be validated continuously from phase-1 day 1. Every merge in phase 2 runs the RT-10 benchmark gate. A red gate blocks merge even for functional features.

**Structural prerequisite:** RT-1 (handler registry) per m2 `blocking_dependencies`: T5 → T6. RT-1 must be implemented *first* in Option A phase 1 — before the matching engine, before any other handler-referencing code.

---

## Solution Space

### Option A: Core-first, two-phase build ← **Recommended**

- **Reversibility:** TWO_WAY
- **Satisfies:** All 12 RTs through sequenced implementation. Addresses RT-6 (binding) continuously. Respects T5 → T6 blocking dependency.
- **Complexity:** Medium. Concrete phase gates prevent scope creep.

**Phase 1 (infrastructure-only, ~3 weeks):**
- RT-1 Handler registry + loader
- RT-4 Tenant routing middleware
- RT-5 Immutable config snapshots + Zod schema + hot-reload primitive
- RT-6.1/6.2/6.3 Match index + templating compiler + microtask deferral primitives
- RT-2 + RT-3 Three-tier error boundary
- RT-10 Benchmark harness (measuring static-mock path)
- Nothing ships to users; internal benchmark + test suite proves the perf baseline.

**Phase 2 (features on top, ~4 weeks):**
- RT-7 Admin endpoints + two-tier token scheme
- RT-8 Pass-through + hardened URL validator
- RT-8 OpenAPI subprocess importer
- RT-9 Diagnostic 404 + nearest-match
- RT-11 CHANGELOG + README persona guides
- RT-12 Deterministic mode
- All four distribution channels (U2) with per-channel benchmark (TN4).

### Option B: Thin-slice continuous delivery

- **Reversibility:** TWO_WAY
- **Satisfies:** All RTs, but RT-6 only converges late — benchmarks are not meaningful until several slices land.
- **Complexity:** Low per slice, high coordination cost for perf refactoring in later slices.

Slice 1: bunx + single-tenant + static mocks → Slice 2: multi-tenant → Slice 3: dynamic handlers → ... Risks accumulating latency debt that must be paid down retroactively.

### Option C: Feature-parallel after interface freeze

- **Reversibility:** REVERSIBLE_WITH_COST ⚠️
- **What this closes:** Inter-module interfaces, once frozen, are expensive to change. Matcher/config/handler boundaries locked before perf validation.
- **Satisfies:** All RTs *if* the upfront design is correct; no continuous RT-6 validation during parallel tracks.
- **Complexity:** High upfront; requires heavy architecture investment before any code.

---

## Tension Validation

All 7 m2 tensions **CONFIRMED** by Option A (see JSON `anchors.tension_validation`). No tensions reopened; no resolution invalidated by the chosen option.

| Tension | Status | Carrier phase |
|---|---|---|
| TN1 (scope B4 to filesystem) | CONFIRMED | Phase 2 docs (RT-11) |
| TN2 (3-tier isolation) | CONFIRMED | Phase 1 (RT-2 + RT-3) |
| TN3 (engineered hot path) | CONFIRMED | Phase 1 (RT-6) |
| TN4 (per-channel boot SLO) | CONFIRMED | Phase 1 harness (RT-10) |
| TN5 (two token tiers) | CONFIRMED | Schema phase 1 (RT-5.1) + endpoints phase 2 (RT-7) |
| TN6 (hardened importer) | CONFIRMED | Phase 2 (RT-8) |
| TN7 (T5 → T6 sequencing) | CONFIRMED | Phase 1 (RT-1 order) |
