# Runbook: webhook circuit breaker tripped

**Trigger:** `mockstar_webhook_circuit_state{tenant=...,webhook=...} == 1` (open) OR sustained `outcome: "circuit-open"` outcomes.

**Severity:** P3 — circuits are protective. The trip is a SIGNAL, not the problem.

**Related constraints:** O3 (circuit breaker), TN2 (circuit-open is observable), B3 (at-least-once bounded by circuit state).

## What's happening

The named webhook has hit `circuit.failureThreshold` (default 5) consecutive failures. The breaker has opened; for `circuit.cooldownMs` (default 30s) all deliveries to this webhook fast-fail to `outcome: "circuit-open"` (no HTTP attempt). After cooldown, the breaker enters half-open: the next attempt is allowed; success closes the breaker, failure re-opens it and restarts the cooldown.

## Diagnose

1. **Confirm circuit state per webhook**:
   ```bash
   curl -s http://localhost:3000/metrics | grep mockstar_webhook_circuit_state
   # 0 = closed, 1 = open, 2 = half-open
   ```

2. **What was the failure mode?** Inspect the journal — the last 5+ attempts before the trip:
   ```bash
   curl -H "Authorization: Bearer $TENANT_TOKEN" \
     "http://localhost:3000/__admin/tenants/<tenant>/webhooks/journal" \
     | jq '[.entries[] | select(.webhookId == "<wh-id>")] | .[-15:]'
   ```

   Look at:
   - `outcome` distribution: failed-vs-success ratio
   - `httpStatus`: 5xx (receiver errors), 4xx (likely auth/signing), missing (network/timeout)
   - `error` field: timeout, DNS, TLS, refused-connection patterns

3. **Test the receiver directly**:
   ```bash
   curl -v -X POST <webhook-url>
   ```

## Mitigate

| Failure pattern | Action |
|---|---|
| Receiver returning 5xx | Wait for receiver to recover; circuit closes on next successful half-open probe. |
| Auth/signing 4xx (401, 403) | Verify `signing.secretRef` env var is set correctly; rotate if leaked. |
| Network timeout | Either raise `timeoutMs` per webhook OR investigate network path. |
| TLS errors (cert expired, untrusted CA) | Receiver-side cert renewal needed. |
| 404 (URL mistemplated) | Inspect `resolvedUrl` field in journal entries — likely a `{{ request.body.x }}` expansion produced an invalid URL. |
| Receiver returning 200 but `expectResponse` mismatch | Check if receiver's response shape changed; update `expectResponse` if intentional. |

## Manual recovery

If you need to clear the circuit immediately (e.g. confident the receiver is fixed):

- **Currently:** restart Mockstar (loses queue but resets all circuits). m6 will add `POST /__admin/tenants/:tenant/webhooks/:id/circuit/reset`.
- **Workaround:** patch the webhook config to lower `cooldownMs` temporarily, hot-reload, then revert.

## Avoid recurrence

- For receivers known to flap, raise `circuit.failureThreshold` (e.g. 10) and lengthen `cooldownMs` (e.g. 60_000) — fewer trips but each trip lasts longer.
- For receivers that need test parity with production retry curves, set `retry.attempts: 8` and tune backoff to match the production receiver's expected curve.
- Add `expectResponse` so silent receiver failures are caught early — better to fail loud and trip the circuit than to silently lose deliveries to a 200-but-broken receiver.

## Escalation

1. On-call engineer.
2. Receiver team if the receiver itself is the failure mode (5xx, timeout patterns).
3. Mockstar maintainers if the circuit appears to behave incorrectly (e.g. doesn't trip at threshold, doesn't half-open after cooldown).
