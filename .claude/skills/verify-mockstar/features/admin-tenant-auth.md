# admin-tenant-auth: Tenant admin endpoints accept only that tenant's token

- id: admin-tenant-auth
- proven: no
- anchors: src/features/admin/auth.ts, src/features/admin/endpoints.ts
- constraints: mockstar:S3

## What it is

The admin API is off unless a root token is set (`MOCKSTAR_ADMIN_TOKEN`). A tenant endpoint
(`/__admin/tenants/<tenant>/…`) accepts only that tenant's own `adminToken` (from
`mocks/<tenant>/tenant.json`). The root token is refused there with 403
`root_token_cannot_access_tenant_scope`, and a request with no token is refused with 401
`missing_token`.

## How to reach it

`GET /__admin/tenants/acme/journal` with `authorization: Bearer <token>`. In the harness the
tenant token is `$TOKEN`; the root token is the same string with the prefix `root-`
(`instance.sh launch` starts the server with `MOCKSTAR_ADMIN_TOKEN=root-$TOKEN`). Both are
fake, per instance, and live only under `.verify-run/`.

## Drive it

```sh
eval "$("$SKILL/scripts/instance.sh" env "$INSTANCE")"; mkdir -p "$RUN/out"
ROOT="root-$TOKEN"; J="$BASE/__admin/tenants/acme/journal"
curl -sS "$BASE/t/acme/orders/o-1" >/dev/null   # puts one entry in the journal
curl -sS -H "authorization: Bearer $TOKEN" -o "$RUN/out/admin-tenant-token.json" -w '%{http_code}\n' "$J"
curl -sS -H "authorization: Bearer $ROOT"  -o "$RUN/out/admin-root-token.json"   -w '%{http_code}\n' "$J"
curl -sS                                   -o "$RUN/out/admin-no-token.json"     -w '%{http_code}\n' "$J"
```

Expected: `200`, `403`, `401`; each curl exits 0. The bodies: `{"tenant":"acme","count":1,
"entries":[…/orders/o-1…]}`, `{"error":"root_token_cannot_access_tenant_scope"}`,
`{"error":"missing_token"}`.

## Proof

- The tenant's own token reads that tenant's journal (200, the `o-1` request is listed).
- The root token on the same route gets 403 `root_token_cannot_access_tenant_scope`.
- No token gets 401 `missing_token` (a rejection, but 401, not 403).
- Side effect: none (reads only). The rejected calls must not add entries or leak the journal:
  the 403 and 401 bodies contain no `entries`.

## Gotchas

- The no-token status is 401, not 403. Do not "fix" the map to 403.
- Record the three artifacts in one `record` call; they have unique names.
