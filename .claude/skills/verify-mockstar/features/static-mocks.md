# static-mocks: Serve a static mock with templated values

- id: static-mocks
- proven: no
- anchors: src/features/static-mock.ts, src/core/templating/compiler.ts, src/core/matching
- constraints: mockstar:T2, mockstar:U1, mockstar:U4

## What it is

A request that matches a mock entry gets the entry's status, headers and body. `{{…}}`
tokens in the body are filled from the request (`{{request.params.id}}`), the tenant
(`{{tenant}}`) and faker (`{{faker.name}}`). A request that matches nothing gets a
diagnostic 404 that names the method, path and tenant.

## How to reach it

Any route a mock file declares, here `GET /orders/:id` in the `acme` tenant
(`fixtures/mocks/acme/orders.json`), reached as `/t/acme/orders/<id>` or with the
`x-mockstar-tenant: acme` header. Unmatched: any other path.

## Drive it

```sh
eval "$("$SKILL/scripts/instance.sh" env "$INSTANCE")"; mkdir -p "$RUN/out"
curl -sS -o "$RUN/out/static-hit.json" -w '%{http_code}\n' "$BASE/t/acme/orders/o-1"
curl -sS -o "$RUN/out/static-miss.json" -w '%{http_code}\n' "$BASE/t/acme/nope"
cat "$RUN/out/static-hit.json" "$RUN/out/static-miss.json"
```

Expected: the first curl prints `200`, the second `404`; both exit 0.
`static-hit.json` is `{"id":"o-1","tenant":"acme","customer":"<a name>","status":"paid"}`.
`static-miss.json` is `{"error":"unmatched","method":"GET","path":"/nope","tenant":"acme","nearest_matches":[]}`.

## Proof

- `200` with `id` equal to the path parameter and `tenant` equal to `acme`: the request
  and tenant tokens rendered.
- `customer` is a non-empty name, not the literal `{{faker.name}}`.
- The unmatched request is a `404` with `"error":"unmatched"` and the tenant.
- Side effect: none (a GET to a static mock writes nothing; the in-memory request journal
  is covered by `scenarios`).

## Gotchas

- The instance runs with `--deterministic`: `customer` is the same name for the same hit
  number on every run, but differs between the 1st and 2nd hit of the route.
- A route under a named tenant is not reachable at the bare path: `GET /orders/o-1` goes
  to the `default` tenant and returns 404.
