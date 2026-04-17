# Tier 2 — Request-derived responses

Tier 2 lets a static mock *respond with values derived from the request*: echo request fields,
mint provider-shape IDs, stamp deterministic timestamps, and reflect query / path / header data.
Everything Tier 1 already did still works; Tier 2 is purely additive.

## What you can write

Inside any static `response.body` field, you can use these template tokens:

| Token | Result |
|-------|--------|
| `{{request.body.<dot.path>}}` | Extract any value from the parsed JSON request body |
| `{{request.query.<name>}}` | Extract a URL query-string value |
| `{{request.params.<name>}}` | Extract a path-param captured by the `match.path` (e.g. `/orders/:id`) |
| `{{request.headers.<name>}}` | Extract a request header (case-insensitive lookup) |
| `{{id("prefix_", 14)}}` | Mint an opaque ID with a prefix and base62 alphabet (14 random chars) |
| `{{id("prefix_", 14, "0123456789abcdef")}}` | Mint an ID with a custom alphabet (hex shown here) |
| `{{now.unix}}` | Current time as unix seconds (number) |
| `{{now.millis}}` | Current time as unix milliseconds (number) |
| `{{now.iso}}` | Current time as ISO 8601 string |
| `{{tenant}}` | The tenant identifier the request was routed to |
| `{{faker.uuid}}`, `{{faker.integer(lo, hi)}}`, ... | The Tier 1 faker helpers continue to work |

## Type preservation

This is the load-bearing Tier 2 behaviour and the reason the walker exists: if a JSON-body leaf
is a **whole-string placeholder** (nothing before or after the `{{...}}`), the rendered value
*keeps its source type*.

```jsonc
// Input
{
  "amount": "{{request.body.amount}}",          // request.body.amount = 50000
  "notes":  "{{request.body.notes}}",           // request.body.notes  = { "k": "v" }
  "label":  "prefix-{{request.body.label}}"    // request.body.label  = "x"
}

// Rendered output
{
  "amount": 50000,              // number — not "50000"
  "notes":  { "k": "v" },       // object — not the string "{\"k\":\"v\"}"
  "label":  "prefix-x"          // string — because the template has literal text around it
}
```

Upstream SDKs validate these shapes with Zod / regex / proto, and a number-coerced-to-string
fails those validators. Type preservation is what makes mockstar fixtures pass `client.orders.create()`
SDK-level tests, not just HTTP contract tests.

## Provider-shape IDs

`{{id(...)}}` takes a prefix, a length, and an optional alphabet. The runtime has **zero** knowledge
of provider-specific shapes — you pick the shape per-fixture. Examples from `examples/mocks/`:

| Provider | Token | Rendered example | Matches |
|----------|-------|------------------|---------|
| Razorpay order | `{{id("order_", 14)}}` | `order_4OwxzMjhPIt4YQ` | `^order_[A-Za-z0-9]{14}$` |
| Stripe customer | `{{id("cus_", 14)}}` | `cus_bBtiZt7WSXYxeg` | `^cus_[A-Za-z0-9]{14}$` |
| Twilio SID | `{{id("SM", 32, "0123456789abcdef")}}` | `SM5e88492417aeb82e81469abcb4615c5d` | `^SM[0-9a-f]{32}$` |
| PayPal order | `{{id("", 17, "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")}}` | `OHNM9O0VBR17U1CIF` | `^[A-Z0-9]{17}$` |

The ID generator is an inline, nanoid-compatible rejection-sampling algorithm. In deterministic
mode (`--deterministic` or `MOCKSTAR_DETERMINISTIC=1`) the seed is `(tenant, endpoint, requestId)` —
so replays produce byte-identical IDs.

## The deterministic clock

In deterministic mode `{{now.*}}` returns a fixed epoch: `2026-01-01T00:00:00.000Z`. This is what
makes CI replays byte-identical. In wall-clock mode it returns the real time, with no caching —
each `{{now.*}}` expansion reads the clock.

## Response-body size cap

The walker tracks an incremental byte estimate during render. If the estimate exceeds the
configured cap (default 1 MB, per-tenant via `tenant.json.limits.maxBodyBytes`), the request gets
a `413 Payload Too Large` response with a structured JSON error body — **before** any serialisation
happens. This is a boundary guard, not a post-hoc check.

## Worked example: Razorpay order creation

```jsonc
// examples/mocks/razorpay/orders.json
{
  "id": "create-order",
  "match": { "method": "POST", "path": "/v1/orders" },
  "response": {
    "kind": "static",
    "status": 200,
    "headers": { "content-type": "application/json" },
    "body": {
      "id":            "{{id(\"order_\", 14)}}",
      "entity":        "order",
      "amount":        "{{request.body.amount}}",
      "amount_paid":   0,
      "amount_due":    "{{request.body.amount}}",
      "currency":      "{{request.body.currency}}",
      "receipt":       "{{request.body.receipt}}",
      "status":        "created",
      "notes":         "{{request.body.notes}}",
      "created_at":    "{{now.unix}}"
    }
  }
}
```

A `POST /t/razorpay/v1/orders` with body `{"amount":50000,"currency":"INR","receipt":"r1","notes":{"k":"v"}}`
renders:

```json
{
  "id": "order_4OwxzMjhPIt4YQ",
  "entity": "order",
  "amount": 50000,
  "amount_paid": 0,
  "amount_due": 50000,
  "currency": "INR",
  "receipt": "r1",
  "status": "created",
  "notes": { "k": "v" },
  "created_at": 1767225600
}
```

`amount` stays a number, `notes` stays an object. The ID matches `^order_[A-Za-z0-9]{14}$`.

## Performance

Typical latency on a developer laptop (see `bench/tier2.ts`):

```
mean: 16µs  p50: 14µs  p95: 23µs  p99: 44µs
```

Run the bench yourself:

```
TIER2_BENCH_N=10000 bun run bench/tier2.ts
```

## Related

- `docs/ENHANCE.md` — how to migrate existing mock files to Tier 2 placeholders
- `docs/CONFIG.md` — the full config reference
- `.manifold/tier2-request-derived-responses.md` — the constraint set this feature was built from
