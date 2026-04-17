# Runbook: Tier 2 bench regression (p95 latency exceeded)

**Trigger:** `bench/tier2.ts` reports p95 > 500µs or p99 > 1500µs in CI.
**Related constraint:** O1 — Tier 2 render path must not blow up the latency budget.
**Severity:** Blocking (PR cannot merge).
**Reversibility of response:** TWO_WAY (code changes are reversible until merged).

---

## What this means

The Tier 2 JSON-walker render path takes one step of an input template and walks it once per
request. Historically the p50 is ~14µs and p95 ~25µs. A regression usually means:

1. An extra pass over the object graph was introduced (e.g. a debug `JSON.parse(JSON.stringify(...))`).
2. The compile-time step is being repeated per-request instead of once (F3-style regression).
3. An ID helper is building a new PRNG on every call inside a hot loop.
4. GC churn from allocating too many small objects per render.

## First steps

1. Re-run locally to confirm it's not CI variance:
   ```
   TIER2_BENCH_N=10000 bun run bench/tier2.ts
   ```
2. Compare the last known-good commit:
   ```
   git log --oneline -- src/core/templating/ src/features/static-mock.ts | head -20
   ```
3. Run with `--smol` or add a CPU profile to narrow the hotspot:
   ```
   bun --smol run bench/tier2.ts
   ```

## Common causes

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| p95 climbs by 5-10µs but p99 stable | New allocation in walker (e.g. new `Map`/`Set` per call) | Hoist outside the hot path |
| p99 balloons, p50 stable | Blocking sync I/O (file read / crypto.randomBytes sync) | Move to compile-time or use `getRandomValues` |
| Both p50 and p95 double | Template being compiled per-request | Check `compileEntryResponses` is called once at load |
| p99 > 10ms | GC pause — too many short-lived objects | Pool the `RenderBudget`/`idHelpers` if safe |

## Verification after fix

```
bun test tests/tier2-*.test.ts tests/templating.test.ts
TIER2_BENCH_N=10000 bun run bench/tier2.ts
```

## Escalation

- **Level 1** (owner): Commit author.
- **Level 2**: Tier 2 feature maintainer (see CODEOWNERS).
- **Level 3**: Core runtime on-call — only if regression is in a shared path (compiler.ts, walker.ts).

## Related docs

- `docs/TIER2.md` — render-path overview
- `.manifold/tier2-request-derived-responses.md` — full constraint set
