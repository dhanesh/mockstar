# Runbook — Mockstar latency regression

> Trigger: CI bench gate fires (p99 > baseline × 1.10) OR Grafana `mockstar_request_latency_us_bucket` p99 rising in a deployed instance.
> Addresses: the binding constraint (RT-6).
> Severity: P1 for CI gate (merge blocked); P2 for runtime drift (users may not notice yet).

## Is it CI or runtime?

### CI gate fired

Check the failing workflow's `bench.yml` artifacts. Compare `bench/results/<scenario>-<channel>-<ts>.json` against `bench/baselines.json`.

The diff is usually one of:

- **A new feature added allocation on the hot path.** Look for `new Object` / `new Map` / `.map()` / spread inside the request handler. Move to config-load or use atomic counters.
- **JSONPath matching introduced over a large body.** The JSONPath engine is not free; ensure only match entries that need it pay for it. Most matchers should use `partial` or `equals`.
- **Logging moved synchronously onto the hot path.** All log writes must be inside `queueMicrotask` after the response is sent (RT-6.3).
- **Match index rebuild triggered on every request.** The index is per-snapshot; should only rebuild on hot-reload (T11).

Common fix shapes:

```ts
// bad — allocates per request
const matches = entries.filter((e) => e.match.method === method);

// good — precomputed at config load, fetched from snapshot
const matches = tenantSnap.matchIndex.match(method, path, req);
```

### Runtime drift

Compare p99 latency across deployments in Grafana. If the regression correlates with a deploy:

1. Roll back to the previous Mockstar image.
2. Re-run `bun run bench` against that image tag to establish a true baseline.
3. Bisect between the last good and first bad commit.

If the regression correlates with a load increase:

- Check tenant concurrency from `mockstar_requests_total` by tenant. A single noisy tenant can evict the match-index cache line in the CPU. Consider sharding tenants across replicas.

## Profile to confirm

```bash
BUN_INSPECT=1 bun run bench/harness.ts --duration=10
# Attach Chrome DevTools to the inspector URL, CPU Profile, look for hot frames.
```

The hot path should be dominated by `Hono.fetch` + `routeToMock` + `renderStatic`. Anything consuming > 5% CPU that is NOT one of those is suspect.

## Prevention checklist

Before merging any PR that touches `src/core/matching/`, `src/core/templating/`, `src/features/static-mock.ts`, or `src/server.ts`:

- [ ] Ran `bun run bench` locally; p99 within +5% of baseline
- [ ] No new per-request allocations introduced (profile verified)
- [ ] Any new per-request work is deferred via `queueMicrotask` unless strictly on the response path
