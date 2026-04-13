# Design decisions

Mockstar's design emerged from the constraint-first workflow in [`.manifold/mockstar.md`](../.manifold/mockstar.md). This file summarises the headline architectural decisions — the manifold itself holds the full constraint set, tensions, and required truths.

## ADR-1: Built on Hono on Bun (T1)

**Decision:** `Bun.serve()` + Hono router.

Alternatives considered: bare `Bun.serve()` (highest perf ceiling, most plumbing); Elysia (fastest, Bun-locked, TypeBox-first). Hono chosen for mature radix-trie routing, portable Fetch-API semantics, and performance headroom (~1.2M RPS) well in excess of Mockstar's budget.

## ADR-2: Two-phase build sequence (Option A from m3)

**Decision:** Phase 1 = infrastructure-only; Phase 2 = features.

Rationale: RT-6 (hot-path latency) is the binding constraint. Validating it from day 1 requires the benchmark harness + match index + handler registry + config snapshots to exist before any feature layers on. Thin-slice delivery (Option B) was rejected because it would defer RT-6 validation past several slices and accumulate latency debt.

## ADR-3: Crash-only handler isolation (TN2)

**Decision:** Three tiers — per-request try/catch + process-level `unhandledRejection` hook + orchestrator restart.

Why not sandbox handlers? Simplicity + handler ergonomics. Full Bun runtime is available; handlers are just functions. The cost: fire-and-forget rejections cannot be isolated without process-level termination. Bun's 2026 best practice ([Bun v1.3.12](https://bun.com/blog/bun-v1.3.12)) confirms that swallowing these errors is unsafe — the process must exit and restart. Production deployment therefore requires a restart-capable orchestrator.

## ADR-4: File-watch only in v1 (TN1)

**Decision:** Configs mutate through the filesystem. No runtime write-API in v1.

Why: Simplicity, single source of truth. DevOps persona reaches Mockstar via K8s ConfigMap mount or Docker volume. A runtime write-API is scoped for v1.1. The pre-mortem called this a risk ("DevOps never gets adopted"); we mitigated by explicitly documenting the three deployment paths and committing to v1.1 delivery.

## ADR-5: Hardened OpenAPI importer as isolated subprocess (TN6)

**Decision:** The importer runs via `Bun.spawn` as a separate process. External `$ref` is rejected. Path parameters are URL-encoded.

Why: Active 2026 CVEs demonstrate that OpenAPI parsers are a live attack surface. Even "offline" conversion can trigger SSRF or local-file reads via `$ref`. Subprocess isolation means a malicious spec cannot affect the running server's state. URL-encoding addresses FastMCP's path-traversal class.

## ADR-6: Two-tier admin auth (TN5)

**Decision:** Per-tenant admin tokens + optional root token for aggregate metrics.

Why: A single "god token" would break tenant isolation (S1) on compromise. Per-tenant scoping bounds blast radius to one tenant. The root token is explicitly prohibited from reading per-request data.

## ADR-7: Precomputed match index on the hot path (TN3)

**Decision:** Radix trie for `method + path`; discriminator evaluation in priority order with early-exit. Logs/metrics/journal deferred via `queueMicrotask`.

Why: RT-6 budget (p99 < 5 ms) is the binding constraint. Naive linear scanning against 1000 mocks + JSON-body JSONPath + Prometheus histogram update would miss the budget. The engineered hot path is the mechanism by which the budget holds.

## ADR-8: Deterministic mode as a single flag (U6, RT-12)

**Decision:** `MOCKSTAR_DETERMINISTIC=1` atomically disables file-watch, fixes faker seed, zeros jitter, normalises timestamps.

Why: Flaky CI tests destroy SDET trust. Users shouldn't have to wire four settings correctly.

---

For the full design record, see `.manifold/mockstar.md`. The manifold is the source of truth; these ADRs are summaries.
