# Webhooks

Outbound webhook delivery for matched mock requests. Per-route configuration, HMAC signing, retry curves, circuit breakers, sync await, and Prometheus observability — all in-process, no Redis.

## Quick start

```json
// mocks/default/orders.json
{
  "$schema": "https://schemas.mockstar.dev/v0.1/mock.json",
  "mocks": [{
    "id": "orders-create",
    "match": { "method": "POST", "path": "/orders" },
    "response": { "kind": "static", "status": 201, "body": { "id": "{{ id(\"ord_\", 12) }}" } },
    "webhooks": [{
      "id": "order-created",
      "url": "https://api.partner.com/hooks/order-created",
      "method": "POST",
      "headers": { "content-type": "application/json" },
      "body": { "orderId": "{{ request.body.orderId }}", "tenant": "{{ tenant }}" }
    }]
  }]
}
```

When a `POST /orders` request matches this mock, Mockstar serves the 201 response immediately, then **after the response flushes** fires the webhook to `https://api.partner.com/hooks/order-created` with the templated body. Delivery runs on a per-tenant queue; retries follow `[1s, 2s, 4s, 8s, 16s] ±20%` with up to 6 attempts by default.

## URL configuration channels

In precedence order (highest first):

1. **Inbound request header** `X-Mockstar-Webhook-Url` — only honoured when the server is started with `--allow-webhook-url-header` AND the route has `acceptHeaderOverride: true` (default).
2. **Per-route `url` field** — the value above. Templated.
3. **Env-var interpolation in template**: `"url": "{{ env.PARTNER_HOOK_URL }}"` — env-resolved at delivery time.
4. **Per-tenant config defaults**: forthcoming (m6 wiring).

## Templating

URL, body, and header values support the existing Mockstar template engine — `{{ request.body.x }}`, `{{ tenant }}`, `{{ requestId }}`, `{{ faker.uuid }}`, `{{ now.iso }}`, `{{ env.X }}`, etc. Same rules as response bodies, with one caveat: webhook bodies are rendered as strings (no type-preservation for JSON leaves yet — that's a v0.2 enhancement).

## Signing (HMAC-SHA256)

Opt-in per webhook:

```json
"signing": {
  "enabled": true,
  "secretRef": "{{ env.PARTNER_HOOK_SECRET }}",
  "signatureHeader": "x-mockstar-signature",
  "timestampHeader": "x-mockstar-timestamp",
  "replayWindowMs": 300000
}
```

Receiver verification (Stripe-style):

```js
const stringToSign = `${req.headers['x-mockstar-timestamp']}.${rawBody}`;
const expected = crypto.createHmac('sha256', SECRET).update(stringToSign).digest('hex');
const provided = req.headers['x-mockstar-signature'].replace(/^sha256=/, '');
if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'))) reject();
if (Date.now() - Number(req.headers['x-mockstar-timestamp']) > 300_000) reject();
```

`secretRef` MUST be one of:
- `{{ env.NAME }}` — env var, read per delivery
- `file:/path` — file content (trimmed), read per delivery

Inline string secrets are **rejected at config-load**.

## Retry, circuit breaker, expectations

```json
"retry": { "attempts": 6, "backoff": [1000, 2000, 4000, 8000, 16000], "jitterRatio": 0.20 },
"circuit": { "failureThreshold": 5, "cooldownMs": 30000 },
"expectResponse": { "status": [200, 202], "body": { "ok": true } },
"timeoutMs": 5000
```

`expectResponse` is optional — without it, any 2xx counts as success. With it, response must match (partial-equal for objects).

## Admin endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/__admin/tenants/:tenant/webhooks` | List webhooks (secrets redacted) |
| GET | `/__admin/tenants/:tenant/webhooks/journal` | Per-tenant delivery history |
| GET | `/__admin/tenants/:tenant/webhooks/await?id=<deliveryId>&timeoutMs=5000` | Block until delivery terminates |
| POST | `/__admin/tenants/:tenant/webhooks/:deliveryId/replay` | Re-enqueue from journal |

Auth: tenant-scope for all of these (`MOCKSTAR_ADMIN_TOKEN` + tenant token).

## Observability

Prometheus metrics:

| Metric | Type | Labels |
|---|---|---|
| `mockstar_webhook_delivery_total` | counter | tenant, webhook, outcome |
| `mockstar_webhook_delivery_latency_us` | histogram | tenant, webhook |
| `mockstar_webhook_queue_depth` | gauge | tenant |
| `mockstar_webhook_queue_dropped_total` | counter | tenant |
| `mockstar_webhook_circuit_state` | gauge | tenant, webhook (0=closed, 1=open, 2=half-open) |

Each delivery attempt also writes a row to the per-tenant webhook journal (separate from the request journal).

## Limits and caveats

- **In-memory only.** Process restart loses pending and in-flight retries. (Use `--webhook-journal-file` for replay-on-restart.)
- **Drop-oldest under cap.** Default 1024 deliveries per tenant; overflow drops the oldest waiting entry, recorded with `outcome: "dropped"` in journal and `webhook_queue_dropped_total` counter. At-least-once is **bounded by queue capacity and circuit state** — see DECISIONS.md TN2.
- **No Redis.** This is a mock server, not a production broker.
- **Hard skip on admin paths.** Webhooks NEVER fire from `/_mockstar/*`, `/__admin/*`, `/health`, `/ready`, `/metrics` — regardless of how broad your route's `match.path` is.

See `DECISIONS.md` for the option-D rationale (why p-queue, why no p-retry, why no plugin interface) and `SECURITY.md` for the full secret-handling and SSRF model.
