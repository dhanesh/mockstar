# Scenario routing

Scenario routing lets a single mock entry return different responses depending on the value of a request attribute — without needing a separate mock file or entry per case.

## Quick start

```jsonc
{
  "id": "get-user-by-lastname",
  "match": { "method": "GET", "path": "/users/:lastName" },
  "response": {
    "kind": "static",
    "status": 200,
    "headers": { "content-type": "application/json" },
    "body": { "found": true, "name": "{{request.params.lastName}}" }
  },
  "scenarios": [
    {
      "id": "not-found-test",
      "when": { "params": { "lastName": "Test" } },
      "response": { "status": 404, "body": { "error": "user_not_found" } }
    },
    {
      "id": "server-error-carpenter",
      "when": { "params": { "lastName": "Carpenter" } },
      "response": { "status": 500, "body": { "error": "internal_server_error" } }
    },
    {
      "id": "locked",
      "when": { "params": { "lastName": "Locked" } },
      "response": {
        "status": 423,
        "headers": { "content-type": "application/json", "retry-after": "60" },
        "body": { "error": "account_locked" }
      }
    }
  ]
}
```

`GET /users/Test` → 404. `GET /users/Carpenter` → 500. `GET /users/Locked` → 423 with `retry-after: 60`. Any other last name → 200 with the default body.

## Using scenarios in tests (library embed)

Scenarios work the same way in test suites as they do in the CLI — add a `scenarios` array to your mock config file and `launch()` picks it up automatically.

**`fixtures/mocks/default/users.json`**
```jsonc
{
  "mocks": [
    {
      "id": "get-user",
      "match": { "method": "GET", "path": "/users/:lastName" },
      "response": {
        "kind": "static",
        "status": 200,
        "body": { "found": true, "name": "{{request.params.lastName}}" }
      },
      "scenarios": [
        {
          "id": "not-found",
          "when": { "params": { "lastName": "Test" } },
          "response": { "status": 404, "body": { "error": "user_not_found" } }
        },
        {
          "id": "server-error",
          "when": { "params": { "lastName": "Carpenter" } },
          "response": { "status": 500, "body": { "error": "internal_server_error" } }
        }
      ]
    }
  ]
}
```

**`users.test.ts`**
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { launch } from '@dhanesh/mockstar';
import { resolve } from 'node:path';

let fetch: (req: Request) => Response | Promise<Response>;
let stop: () => Promise<void>;

beforeAll(async () => {
  const launched = await launch({
    configRoot: resolve(import.meta.dir, 'fixtures/mocks'),
    deterministic: true,
    watch: false,
  });
  fetch = launched.server.hono.fetch;
  stop = launched.stop;
});

afterAll(() => stop());

describe('GET /users/:lastName', () => {
  it('returns 200 for a normal user', async () => {
    const res = await fetch(new Request('http://test/t/default/users/Smith'));
    expect(res.status).toBe(200);
    expect((await res.json() as any).found).toBe(true);
  });

  it('returns 404 for lastName=Test (scenario: not-found)', async () => {
    const res = await fetch(new Request('http://test/t/default/users/Test'));
    expect(res.status).toBe(404);
    expect(res.headers.get('x-mockstar-scenario')).toBe('not-found');
  });

  it('returns 500 for lastName=Carpenter (scenario: server-error)', async () => {
    const res = await fetch(new Request('http://test/t/default/users/Carpenter'));
    expect(res.status).toBe(500);
  });
});
```

`server.hono.fetch` is an in-process call — no real HTTP port, no `listen()`, negligible overhead. `deterministic: true` seeds Faker so `{{…}}` tokens produce stable values across runs. `watch: false` disables the file watcher (unnecessary in CI).

The `x-mockstar-scenario` response header tells you which rule fired, which is useful in test assertions to confirm the right scenario matched.

## Schema

### `scenarios` array (on any mock entry)

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | Unique name for the rule within the entry |
| `when` | object | Yes | Predicate — which attribute and value triggers this scenario |
| `response` | object | Yes | Override response fields |

Maximum 50 rules per entry. If you need more, split the entry across two entries with different `priority` values (see below).

### `when` — predicate

One or more of:

| Key | Matches |
|---|---|
| `params` | Path parameters captured by `:name` in `match.path` |
| `query` | URL query-string values |
| `headers` | Request headers (case-insensitive key lookup) |
| `body` | Request body fields via dot-path (e.g. `"user.lastName"`) |

Each value uses the same `StringMatch` vocabulary as route predicates:

| Form | Matches when |
|---|---|
| `"value"` | Exact string equality (shorthand for `equals`) |
| `{ "equals": "value" }` | Exact string equality |
| `{ "regex": "^pattern$" }` | Regular expression test |
| `{ "startsWith": "prefix" }` | String starts with prefix |
| `{ "contains": "substring" }` | String contains substring |

All keys in a single `when` object must match for the rule to fire (AND semantics). Rules are evaluated in declaration order; the first match wins.

### `response` — override

At least one of `status`, `headers`, or `body` must be present.

| Field | Type | Notes |
|---|---|---|
| `status` | integer 100–599 | HTTP status code |
| `headers` | object | Key/value pairs — merged over default headers |
| `body` | any | JSON value — supports Tier 2 `{{…}}` tokens |
| `delay` | number or `{min, max}` | Millisecond delay override |

Fields not declared in a scenario response are **inherited from the default response** (for `static` entries). See the inheritance rules below.

## Inheritance rules

### Static entries

Absent scenario fields are filled from the entry's default `response`:

| Scenario declares | Result |
|---|---|
| Only `status` | Scenario status + default body + merged headers |
| Only `body` | Default status + scenario body + default headers |
| `status` + `headers` | Scenario status + merged headers + default body |

### Dynamic and passthrough entries

There is no computed default at scenario-evaluation time, so scenario responses must declare all three fields: `status`, `headers`, and `body`. A missing field is a boot-time validation error.

## Tier 2 tokens in scenario bodies

Scenario response bodies support the full Tier 2 token set, exactly like default response bodies. The merged response goes through the Tier 2 walker exactly once.

```jsonc
{
  "id": "bad-scenario",
  "when": { "params": { "orderId": { "startsWith": "ERR_" } } },
  "response": {
    "status": 422,
    "body": { "error": "invalid_order", "orderId": "{{request.params.orderId}}" }
  }
}
```

`request.params.orderId` echoes the path parameter into the error body.

## Security

Scenario matching is **data-driven only**. The evaluator calls one of four string operations — exact equality, `RegExp.test`, `startsWith`, or `includes` — against extracted request attribute values. No `eval`, `new Function`, or dynamic code execution exists in any code path that touches request data. This is a structural invariant: all operations are enumerated in `src/core/scenarios/evaluator.ts`.

Compiled `RegExp` objects are created once at snapshot build time and are owned by the `TenantSnapshot`. They are garbage-collected when the snapshot is replaced on hot-reload — no `CompiledScenario` reference survives beyond the snapshot that owns it.

## Regex safety guard

Regex predicates are validated at config-load against a catastrophic-backtracking heuristic. Patterns with nested quantifiers (like `(a+)+` or `(foo|bar)+`) are rejected with a descriptive error that suggests exact/startsWith/contains alternatives.

Safe patterns like `/^[A-Z]{2,4}$/` are accepted.

## Rule count ceiling

Maximum 50 scenario rules per entry. If a provider endpoint has more than 50 distinct error cases, split into two entries:

```jsonc
[
  {
    "id": "get-order-errors-a",
    "match": { "method": "GET", "path": "/orders/:id", "priority": 10 },
    "response": { "kind": "static", "status": 200, "body": {} },
    "scenarios": [ /* first 50 rules */ ]
  },
  {
    "id": "get-order-errors-b",
    "match": { "method": "GET", "path": "/orders/:id", "priority": 0 },
    "response": { "kind": "static", "status": 200, "body": {} },
    "scenarios": [ /* remaining rules */ ]
  }
]
```

Both entries match the same path. The trie routes to both; each entry evaluates its own scenarios. The higher-priority entry is checked first.

This split pattern applies to `static` entries. For `dynamic` or `passthrough` entries, each split entry needs its own handler or upstream target — if both halves should return the same default response, use a `static` entry with a catch-all `dynamic` entry at lower priority instead.

## Observability

### Response headers

When a scenario fires, mockstar adds:

| Header | Value |
|---|---|
| `x-mockstar-scenario` | The matched scenario's `id` |

### Journal

The per-tenant journal (`/__admin/tenants/:tenant/journal`) includes two fields per request:

| Field | Present when |
|---|---|
| `scenarioId` | A scenario rule matched |
| `scenarioMissReason` | A predicate targeted an attribute that was absent from the request (e.g. `params.lastName` on a route with no `:lastName` — likely a typo in the scenario definition) |

### Admin mock list

`GET /__admin/tenants/:tenant/mocks` includes for each entry:

| Field | Description |
|---|---|
| `scenarioCount` | Number of declared scenario rules |
| `scenarioAttributes` | List of attribute keys targeted (not values) — e.g. `["params.lastName", "query.status"]` |

## Related

- `docs/TIER2.md` — Tier 2 token reference
- `docs/CONFIG.md` — Full config schema reference
- `.manifold/scenario-routing.md` — Constraint set this feature was built from
