# webhooks: Fire webhooks after a mock responds

- id: webhooks
- proven: no
- anchors: src/features/webhooks/dispatcher.ts:dispatchWebhooks, src/features/webhooks/compile.ts, src/server.ts:createDeliveryIdGenerator
- constraints: webhooks:B3, webhooks:O4, webhooks:U1, webhooks:U4, webhooks:T4

## What it is

A mock entry can list `webhooks`. After the response is sent, mockstar delivers each one to
its URL with a templated body. Each delivery has its own `X-Mockstar-Delivery-Id` (the same
on its retries) and carries the triggering request's id in `X-Mockstar-Request-Id`. Every
attempt is written to the per-tenant webhook journal, and the admin API can await a
delivery.

## How to reach it

`POST /orders` in tenant `acme` fires two webhooks, `order-created` (object body with
`{{request.body.id}}` and `{{id("evt_", 12)}}`) and `order-audit` (string body), both to
this instance's receiver. Admin: `GET /__admin/tenants/acme/webhooks/journal` and
`GET /__admin/tenants/acme/webhooks/await?id=<deliveryId>&timeoutMs=5000`.

## Drive it

```sh
eval "$("$SKILL/scripts/instance.sh" env "$INSTANCE")"; mkdir -p "$RUN/out"
curl -sS -o "$RUN/out/webhook-trigger.json" -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' -d '{"id":"o-77"}' "$BASE/t/acme/orders"
DLV=$(curl -sS -H "authorization: Bearer $TOKEN" "$BASE/__admin/tenants/acme/webhooks/journal" \
  | "$PYTHON" -c 'import sys,json; print(json.load(sys.stdin)["entries"][-1]["deliveryId"])')
curl -sS -H "authorization: Bearer $TOKEN" -o "$RUN/out/webhook-await.json" -w '%{http_code}\n' \
  "$BASE/__admin/tenants/acme/webhooks/await?id=$DLV&timeoutMs=5000"
curl -sS -H "authorization: Bearer $TOKEN" -o "$RUN/out/webhook-journal.json" "$BASE/__admin/tenants/acme/webhooks/journal"
cp "$RUN/webhooks.jsonl" "$RUN/out/webhook-received.jsonl"
"$PYTHON" -c 'import json,sys; [print(r["path"], r["headers"].get("x-mockstar-delivery-id"), r["headers"].get("x-mockstar-request-id"), r["body"]) for r in map(json.loads, open(sys.argv[1]))]' "$RUN/out/webhook-received.jsonl"
```

Expected: `201`, then `200` from await; each command exits 0. The last command prints two
lines, one per webhook path (`/hooks/order-created`, `/hooks/order-audit`), with two
different `dlv-…` ids and the same `req-…` id. The `order-created` body is
`{"event":"order.created","orderId":"o-77","eventId":"evt_…"}`.

## Proof

- The trigger returns `201` before and independent of delivery.
- Side effect: the receiver got both webhooks (`webhook-received.jsonl`), with distinct
  `X-Mockstar-Delivery-Id` values and one shared `X-Mockstar-Request-Id`.
- The webhook journal shows each delivery with `"outcome":"success"` and `httpStatus` 200,
  and `await` returns the terminal summary for the delivery id.

## Gotchas

- `webhooks.jsonl` accumulates for the whole instance: earlier POSTs show up too. Match the
  rows by `orderId` or count the new ones.
- The receiver is `http://127.0.0.1`, so the fixture sets `allowHttp` and
  `allowPrivateNetworks`. Without them the SSRF guard drops the delivery and only the
  webhook journal shows it.
- In the webhook journal `resolvedUrl` shows the path as `[redacted]`: that is expected.
