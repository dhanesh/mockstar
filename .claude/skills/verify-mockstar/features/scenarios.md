# scenarios: Answer with a scenario when a request matches its `when`

- id: scenarios
- proven: no
- anchors: src/core/scenarios, src/features/admin/endpoints.ts
- constraints: scenario-routing:T2, scenario-routing:O1, mockstar:O3

## What it is

A mock entry can carry `scenarios`. The first scenario whose `when` (params, query, headers
or body) matches the request replaces the entry's response. Otherwise the base response is
served. The request journal records which scenario answered.

## How to reach it

`GET /orders/:id` in tenant `acme`: id `o-404` matches the `missing-order` scenario; any
other id gets the base response. The journal is `GET /__admin/tenants/acme/journal` with
`authorization: Bearer $TOKEN`.

## Drive it

```sh
eval "$("$SKILL/scripts/instance.sh" env "$INSTANCE")"; mkdir -p "$RUN/out"
curl -sS -o "$RUN/out/scenario-hit.json"  -w '%{http_code}\n' "$BASE/t/acme/orders/o-404"
curl -sS -o "$RUN/out/scenario-base.json" -w '%{http_code}\n' "$BASE/t/acme/orders/o-2"
curl -sS -H "authorization: Bearer $TOKEN" -o "$RUN/out/scenario-journal.json" -w '%{http_code}\n' \
  "$BASE/__admin/tenants/acme/journal"
```

Expected: `404`, `200`, `200`; each curl exits 0. `scenario-hit.json` is
`{"error":"order_not_found","id":"o-404"}`. The journal has an entry for `/orders/o-404`
with `"scenarioId":"missing-order"` and one for `/orders/o-2` with no `scenarioId`.

## Proof

- The scenario's status and body replace the base response only for the matching id.
- Side effect: the in-memory request journal gains both requests, and only the scenario
  request carries `scenarioId: "missing-order"`.

## Gotchas

- The journal holds every request of the tenant since the instance started, so find the
  entries by path, not by position.
- The admin API needs the tenant token (`$TOKEN`). The root token gets 403 on tenant routes.
