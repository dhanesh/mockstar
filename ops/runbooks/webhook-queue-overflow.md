# Runbook: webhook queue overflow

**Trigger:** `mockstar_webhook_queue_dropped_total{tenant=...}` is incrementing, OR `mockstar_webhook_queue_depth{tenant=...}` is sustained near the cap.

**Severity:** P3 normally; P2 if the affected tenant is a critical integration and drops mean missed test signals.

**Related constraints:** O1 (queue cap), TN2 (drops are observable), B3 (at-least-once is bounded).

## What's happening

The per-tenant in-memory webhook queue has reached its depth cap (default 1024). The oldest waiting deliveries are being evicted with `outcome: "dropped"`. New deliveries continue to enqueue successfully (cap is enforced by drop-oldest, not block-on-add).

This is **expected behavior**, not a bug — the contract is "at-least-once within queue capacity bounds." Drops happen when the receiver can't keep up.

## Diagnose

1. **Identify the tenant**: which tenant labels are seeing dropped_total increment?
   ```bash
   curl -s http://localhost:3000/metrics | grep mockstar_webhook_queue_dropped_total
   ```

2. **Inspect queue depth**: how full is the queue right now?
   ```bash
   curl -s http://localhost:3000/metrics | grep mockstar_webhook_queue_depth
   ```

3. **Check delivery latency**: is the receiver slow, returning errors, or rate-limiting?
   ```bash
   curl -s http://localhost:3000/metrics | grep mockstar_webhook_delivery_latency_us
   curl -s http://localhost:3000/metrics | grep mockstar_webhook_delivery_total
   # Look at the outcome label distribution: success vs failed vs dropped vs circuit-open
   ```

4. **Check circuit state**: a stuck-open circuit will produce `outcome: "circuit-open"` instead of `dropped`, but a stuck-half-open or flapping circuit might create the failure pattern that fills the queue.
   ```bash
   curl -s http://localhost:3000/metrics | grep mockstar_webhook_circuit_state
   ```

5. **Review recent journal**:
   ```bash
   curl -H "Authorization: Bearer $TENANT_TOKEN" \
     http://localhost:3000/__admin/tenants/<tenant>/webhooks/journal | jq '.entries[-20:]'
   ```

## Mitigate

| Cause | Action |
|---|---|
| Slow receiver, transient | Wait — the queue drains as receiver recovers. Drops are bounded by the cap; nothing else is at risk. |
| Receiver permanently unreachable | The circuit breaker should be tripping; if not, raise `circuit.failureThreshold` or lower `circuit.cooldownMs` per webhook. |
| Sustained legitimate burst exceeds default cap | Raise queue cap. **Currently this requires a code change** (constructor arg in `BoundedRetryQueue`). m6 wires this to `TenantLimits.webhookQueueCap`. |
| Tests asserting at-least-once across queue capacity | This contract was never made — see `DECISIONS.md` TN2. Tests need to either lower their burst or increase cap. |

## Avoid recurrence

- For high-volume integrations, attach an `expectResponse` matcher so the queue gets clear success signals (not just 2xx that the receiver dropped silently).
- Consider per-webhook `retry.attempts: 3` with a tighter window for tests where you expect the receiver to be reliable — keeps queue turnover fast.
- For SDET fixtures: run with `concurrency: 16` (v0.2) or higher per tenant; the default 8 was sized for typical-load expectations.

## Escalation

1. On-call engineer (see `ops/oncall.md` if present).
2. Mockstar maintainers — `feat/webhooks` branch owner: see `git log --format='%an' .manifold/webhooks.json | head -1`.
3. Receiver team if the receiver itself is the failure mode.
