# tenant-selection: Route a request to a tenant by path, header or subdomain

- id: tenant-selection
- proven: bd7f51dddb70eebae32a53289a513f6eb87154a3
- anchors: src/core/tenancy/extractor.ts, src/cli/args.ts:parseTenancyModes
- constraints: mockstar:S1, mockstar:S2

## What it is

Each tenant is its own directory of mocks. mockstar picks the tenant for a request from the
path prefix `/t/<tenant>/…`, the `x-mockstar-tenant` header, or (when enabled) the first
label of the host name. With no selector the request goes to the `default` tenant. A
tenant only sees its own mocks.

## How to reach it

- Path: `/t/acme/orders/o-1` (default mode).
- Header: `x-mockstar-tenant: acme` (default mode).
- Subdomain: `Host: acme.localhost` when the server runs with `--tenancy-modes` or
  `MOCKSTAR_TENANCY_MODES` naming `subdomain` (mockstar 0.7.0+).
- No selector: the `default` tenant.

## Drive it

```sh
eval "$("$SKILL/scripts/instance.sh" env "$INSTANCE")"; mkdir -p "$RUN/out"
curl -sS -o "$RUN/out/tenant-path.json"   -w '%{http_code}\n' "$BASE/t/acme/orders/o-1"
curl -sS -o "$RUN/out/tenant-header.json" -w '%{http_code}\n' -H 'x-mockstar-tenant: acme' "$BASE/orders/o-1"
curl -sS -o "$RUN/out/tenant-default.json" -w '%{http_code}\n' "$BASE/hello"
curl -sS -o "$RUN/out/tenant-isolated.json" -w '%{http_code}\n' "$BASE/orders/o-1"
```

Expected: `200`, `200`, `200`, `404`; each curl exits 0. The first two bodies say
`"tenant":"acme"`, the third `{"message":"hello from default","tenant":"default"}`, the last
`{"error":"unmatched",…,"tenant":"default",…}`.

Subdomain mode needs its own instance, because the modes are fixed at start:

```sh
eval "$("$SKILL/scripts/instance.sh" env "$INSTANCE")"; OUT="$RUN/out"   # keep the artifact in the main instance
MOCKSTAR_TENANCY_MODES=subdomain,path,header "$SKILL/scripts/instance.sh" launch "$INSTANCE-sub"
SUB_PORT=$("$SKILL/scripts/instance.sh" status "$INSTANCE-sub" | "$PYTHON" -c 'import sys,json; print(json.load(sys.stdin)["port"])')
curl -sS -o "$OUT/tenant-subdomain.json" -w '%{http_code}\n' -H "host: acme.localhost:$SUB_PORT" "http://127.0.0.1:$SUB_PORT/orders/o-1"
curl -sS -o "$OUT/tenant-subdomain-ip.json" -w '%{http_code}\n' -H 'x-mockstar-tenant: acme' "http://127.0.0.1:$SUB_PORT/orders/o-1"
"$SKILL/scripts/instance.sh" stop "$INSTANCE-sub"
```

Expected: launch prints `"ready":true`; the two curls print `200` and `200`, both bodies
with `"tenant":"acme"` (the second shows an IP host is skipped and the header mode still
applies); stop prints `{"instance":"…-sub","stopped":true}`.

## Proof

- The same route answers as `acme` through the path prefix and through the header.
- No selector lands in `default`, and `default` cannot see `acme`'s `/orders/:id` (404):
  tenant isolation.
- Subdomain: the `Host` label selects `acme` only when the mode is enabled.
- Side effect: none (reads only).

## Gotchas

- In subdomain mode an IP host (`127.0.0.1`) is never read as a tenant (fixed in 0.7.0;
  before, it became tenant `127`).
- `stop` deletes `.verify-run/<instance>-sub/`, so the subdomain recipe writes its artifacts
  to the main instance's `$RUN/out/`.
