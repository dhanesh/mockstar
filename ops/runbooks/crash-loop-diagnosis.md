# Runbook — Mockstar pod / container crash loop

> Trigger: repeated `unhandledRejection` process faults; pod restart count climbing; Grafana `mockstar_restart_total` spiking.
> Addresses: failure cascade tier 4 of TN2.
> Severity: P2 — traffic to that tenant is degraded; other tenants on the same instance are also at risk until fix.

## 1. Confirm the pattern

```bash
kubectl logs <pod> --previous --timestamps | grep -E 'process_fault|handler_fault'
```

Look for the last `process_fault` event — its `kind` tells you which hook fired:

- `unhandledRejection` — a handler returned a promise without `await` and it rejected. Most common.
- `uncaughtException` — a handler threw synchronously outside the per-request try/catch boundary (rare; usually indicates a bug in Mockstar itself).

## 2. Identify the faulting handler

Group recent `handler_fault` events by `handler` name:

```bash
kubectl logs <pod> --previous --since=10m | jq -c 'select(.event == "handler_fault") | .handler' | sort | uniq -c | sort -nr
```

The top handler is almost certainly the culprit.

## 3. Reproduce locally

```bash
bunx mockstar ./mocks --deterministic
# Replay the failing request with curl or the recorded journal entry
```

If reproducible: fix the handler (most likely cause — non-awaited promise).

If not reproducible: check the request-ID in the crash log, then cross-reference the tenant's journal (if the journal ring buffer still holds it):

```bash
curl -H "Authorization: Bearer $TENANT_TOKEN" http://<mockstar-host>/__admin/tenants/<tenant>/journal \
  | jq '.entries[] | select(.requestId == "<ID>")'
```

## 4. Temporary mitigation

If the fix will take > 30 min and the crash loop is user-visible:

- Remove the faulting mock entry from the tenant's config. File-watch will hot-reload automatically.
- If the entry must stay: flip its `response.kind` to `static` with a placeholder body; re-add dynamic handling after the fix.

## 5. Permanent fix

Common fixes for non-awaited rejection:

```ts
// bad
export async function bad(ctx) {
  someAsyncCleanup(); // fires and forgets
  return new Response('ok');
}

// good
export async function good(ctx) {
  await someAsyncCleanup();
  return new Response('ok');
}
```

Enable the lint rule in your `handlers/` directory (RT-3.4):

```json
{
  "rules": {
    "@typescript-eslint/no-floating-promises": "error"
  }
}
```

## 6. Post-incident

- Add a regression test that exercises the failure path.
- File an issue tagged `handler-crash` with the pod logs attached.
- If crash frequency suggests a systemic issue (multiple tenants affected), revisit whether handler sandboxing should move off the v1.1 deferred list.
