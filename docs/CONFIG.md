# Config reference

Mockstar's JSON config is validated by Zod at boot (fail-fast) and on hot-reload (warn-and-keep-previous). An equivalent JSON Schema is exported to `dist/schema.json` for editor autocomplete.

## Directory layout

```
mocks/
  {tenant}/
    tenant.json           # optional — per-tenant overrides
    *.json                # one or more mock files
handlers/
  *.ts                    # named JS handlers
```

Each top-level directory under `mocks/` is one tenant. Tenant identifiers are `/^[a-zA-Z0-9_-]{1,64}$/`.

## Mock entry shape

```jsonc
{
  "id": "get-user-by-id",
  "match": {
    "method": "GET",                // GET | POST | PUT | PATCH | DELETE | HEAD | OPTIONS | *
    "path": "/users/:id",            // Hono-style with :param
    "query": { "tier": "premium" }, // equals shorthand
    "headers": { "authorization": { "startsWith": "Bearer " } },
    "body": { "partial": { "currency": "INR" } },
    "priority": 10                   // higher wins on tie
  },
  "response": {
    "kind": "static",                 // static | dynamic | passthrough
    "status": 200,
    "headers": { "content-type": "application/json" },
    "body": { "id": "{{request.params.id}}", "uuid": "{{faker.uuid}}" },
    "delay": { "min": 50, "max": 200 } // optional — number (ms) or {min,max}
  }
}
```

### `match` predicates

| Field | Forms |
|---|---|
| `method` | string enum; `*` matches any |
| `path` | Hono-style with `:param` path parameters |
| `query` | `{field: string}` (equals) or `{regex}` / `{startsWith}` / `{contains}` |
| `headers` | same as query |
| `body` | `{equals: …}` / `{partial: {…}}` / `{jsonpath: "$.user.role"}` |
| `priority` | integer (default 0). Higher wins; ties broken by order-of-declaration. |

### `response.kind` variants

**`static`** — return a stored body with optional templating:

```jsonc
{
  "kind": "static",
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": "{{faker.email}}"
}
```

Supported tokens inside a `{{ ... }}` expression (compiled at load time — RT-6.2):

- `tenant`, `requestId`
- `request.method`, `request.path`, `request.query.<k>`, `request.headers.<k>`, `request.body.<path>`, `request.params.<name>`
- `faker.uuid`, `faker.email`, `faker.name`, `faker.integer(min, max)`, `faker.pick(["a", "b"])`, `faker.boolean`, `faker.dateIso`

**`dynamic`** — delegate to a named JS handler:

```jsonc
{ "kind": "dynamic", "handler": "computeOrderTotal" }
```

The handler name must resolve to an export in the `handlers/` directory. See [HANDLERS.md](./HANDLERS.md).

**`passthrough`** — proxy to an upstream:

```jsonc
{ "kind": "passthrough", "upstream": "https://api.real.example.com", "timeoutMs": 10000 }
```

Upstream URLs are validated against the SSRF guard (RT-8 / S6). Private ranges are rejected unless the tenant sets `allowPrivateUpstreams: true` in `tenant.json`.

## Per-tenant overrides (`tenant.json`)

```jsonc
{
  "adminToken": "per-tenant-secret-32-chars-min",   // RT-7.1
  "allowPrivateUpstreams": false,                    // RT-8.1
  "limits": {
    "maxBodyBytes": 1048576,      // S5 — inbound request cap, 1 MB
    "maxResponseBytes": 1048576,  // S4 — outbound Tier 2 render cap, 1 MB
    "requestsPerSecond": 1000,     // S5 — (enforcement in v1.1)
    "journalSize": 1000            // O3 — bounded ring buffer
  }
}
```

## Global server config

Controlled via env or programmatic `launch({ server: {...} })`:

| Setting | Env | Default |
|---|---|---|
| `host` | `MOCKSTAR_HOST` | `127.0.0.1` (S4) |
| `port` | `MOCKSTAR_PORT` | `3000` |
| `tenancyModes` | — | `['path', 'header']` |
| `adminEnabled` | auto-`true` when `MOCKSTAR_ADMIN_TOKEN` is set | `false` |
| `rootToken` | `MOCKSTAR_ADMIN_TOKEN` | unset |
| `deterministic` | `MOCKSTAR_DETERMINISTIC=1` | `false` |
