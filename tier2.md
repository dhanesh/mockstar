# Tier 2 — Request-derived identifiers and echoed fields in mock responses

## Problem

The current imported mocks (from both OpenAPI and Postman) return
**verbatim-baked responses**. Every call to `POST /v1/orders` returns exactly
the Razorpay example body, which contains the example's hard-coded
`order_R79imLhexM52Pi` as the order ID, `receipt: "Receipt no. 1"`, a
specific `amount`, and a fixed `created_at`. This means:

1. **IDs are duplicates.** Two calls to create-order return the same ID.
   Applications that store the returned ID in a local DB hit unique-key
   violations. Applications that dedupe by ID silently drop the second
   creation.
2. **Request fields are ignored.** An application calling `POST /v1/orders`
   with `amount: 50000, currency: 'USD', receipt: 'order_X'` receives a
   response claiming `amount: 10000, currency: 'INR', receipt: 'Receipt no.
   1'`. The response has no connection to the request.
3. **Timestamps are frozen in the past.** Example `created_at` values are
   Unix timestamps from whenever the Razorpay team last regenerated the
   collection. Application code that asserts "resource was created within the
   last 5 minutes" fails immediately.
4. **Response shapes look plausible, behavior does not.** The dev can render
   the response in the UI and it looks right, but nothing about it reflects
   what the user actually submitted.

The consequence is that mockstar is usable for "response parsing smoke tests"
and completely unusable for any workflow that involves checking that a created
resource's attributes match what was submitted, or that a returned ID is
unique, or that creation time is approximately now.

## Outcome

For a targeted set of high-value write endpoints, the mock response:

1. Generates a **Razorpay-format unique ID** per request (correct prefix,
   correct character set, correct length — indistinguishable from a real
   Razorpay ID by shape).
2. **Echoes request body fields** where the real Razorpay API would:
   `amount`, `currency`, `receipt`, `notes`, `description`, `contact`,
   `email`, `name`, etc. — whatever the request sent is what the response
   reports back.
3. Sets **`created_at`** (and similar timestamp fields) to the current Unix
   timestamp.
4. Preserves **static structure** where Razorpay's real responses always
   include fixed fields (e.g., `entity: "order"`, `status: "created"`,
   `amount_paid: 0`).

In-scope endpoints:

| # | Endpoint | ID prefix | Why top-5 |
|---|---|---|---|
| 1 | `POST /v1/orders` | `order_` | Every payment flow starts here; ID is referenced by subsequent calls |
| 2 | `POST /v1/customers` | `cust_` | User-onboarding first step; ID is stored in the app's user table |
| 3 | `POST /v1/payments/:id/capture` | `pay_` (echoed from path) | Payment flow terminus; ID must match path |
| 4 | `POST /v1/refunds` | `rfnd_` | Support flow; ID is used in webhook correlation |
| 5 | `POST /v1/payment_links` | `plink_` | Ad-hoc charging; URL and ID both must be unique per call |

After Tier 2, an application calling `POST /v1/orders` with
`{amount: 50000, currency: 'USD', receipt: 'RCPT-42', notes: {user: 'alice'}}`
receives:

```json
{
  "id": "order_<unique>",
  "entity": "order",
  "amount": 50000,
  "amount_paid": 0,
  "amount_due": 50000,
  "currency": "USD",
  "receipt": "RCPT-42",
  "offer_id": null,
  "status": "created",
  "attempts": 0,
  "notes": {"user": "alice"},
  "created_at": <now>
}
```

## Scope

### In scope

- The five endpoints listed above.
- **ID generation helpers** callable from templating: a way for a template to
  emit a Razorpay-shaped ID with a given prefix (e.g.
  `{{razorpay.id("order")}}` → `order_NqP8jK3mL5vX9y`).
- **Request-body echo via existing templating** (`{{request.body.amount}}`).
  Where a field is missing or of the wrong type, the response uses a
  sensible default (the current example value, or a type-appropriate null).
- **Current timestamp via templating helper**
  (`{{now.unix}}` or equivalent) so `created_at` is always now.
- **Regression tests** covering each of the five endpoints: at least one test
  per endpoint asserting (a) ID shape is correct and (b) request echo is
  accurate and (c) `created_at` is within one second of the test's own clock.
- **Continues to work under deterministic mode** (RT-12). In deterministic
  mode the "unique" IDs become seed-driven and the timestamp becomes the
  deterministic counter.

### Out of scope

- **Cross-request memory** (Tier 3). The `order` returned by `POST /v1/orders`
  is not fetchable by `GET /v1/orders/:id`. That's stateful handler territory.
- **ID persistence / collision avoidance across calls** beyond what
  randomness provides. We don't maintain a generated-IDs set.
- **Request validation.** Razorpay rejects `amount < 100` (1 rupee). We do
  not enforce this; we mirror whatever the request sent. Validation mocking
  is its own tier.
- **Webhooks.** Creating an order in the mock does not fire any webhook.
  Webhook simulation is Tier 4.
- **Error response mocking.** All Tier 2 responses are 200/201/happy-path.
  Error scenarios are Tier 6.
- **Other endpoints.** Subscriptions, invoices, items, QR codes, smart
  collect, settlement fetches, route transfers — all remain on the
  baked-example path until they are explicitly prioritised into later tiers.
- **Bulk / batch creation** endpoints (e.g. `POST
  /v1/customers/create_with_list` style). Only the singular create paths are
  in scope.

## Success criteria

An application running against mockstar after Tier 2 ships can:

1. **Create 100 customers in a loop** and insert each one into its local DB
   without hitting a unique-key violation on the returned `cust_*` ID.
2. **Read back the `amount`** from a `POST /v1/orders` response and assert
   it equals the submitted amount.
3. **Parse `created_at`** from any Tier-2 response and compute `(now -
   created_at)` as a value less than 2 seconds.
4. **Generate Razorpay-format IDs** that pass Razorpay's own regex checks
   (`/^(order|pay|cust|rfnd|plink)_[A-Za-z0-9]{14}$/` — verify exact length
   and charset with the Razorpay team or SDK source).
5. **Run in deterministic mode** (RT-12) and see byte-identical responses
   across runs for identical inputs. Non-deterministic mode produces unique
   IDs.
6. **Pass every regression test** covering the five endpoints — tests must
   run in CI on every commit; bench must not regress more than 25% from the
   existing baseline.

Acceptance tests should cover at minimum:

- Per endpoint: create → parse response → verify (ID shape, request echo,
  timestamp).
- Deterministic mode: two runs with the same input produce identical output.
- Concurrency: 100 parallel creates yield 100 unique IDs.
- Missing request field: default value substituted, response still valid
  JSON matching the Razorpay schema.
- Integration: existing Petstore and other non-Razorpay mocks continue to
  work unaffected.

## Known decision points

| Decision | Reasonable options | Trade-offs |
|---|---|---|
| **ID generation primitive** | (a) `faker.string.alphanumeric(14)`; (b) a custom Razorpay-shaped generator using base-62 encoding; (c) `nanoid` with a custom alphabet | Razorpay uses `[A-Za-z0-9]{14}`. `nanoid` with a custom alphabet is 1 line and guaranteed unique at reasonable scale. |
| **Template helper namespace** | (a) Add `{{razorpay.id("order")}}` (provider-specific); (b) generic `{{id("order")}}`; (c) `{{faker.id(prefix, length)}}` | Generic with a prefix arg is Razorpay-agnostic — reusable for Stripe (`cus_`, `pi_`), Twilio (`AC...`), etc. |
| **Timestamp helper** | (a) `{{now.unix}}` (seconds); (b) `{{now.millis}}`; (c) `{{now.iso}}`; (d) all three | Razorpay uses seconds (`created_at: 1755595499`). Provide all three so templates for other APIs work. |
| **Request echo semantics** | (a) Plain token `{{request.body.amount}}` (works today for string leaves); (b) type-preserving token that emits numbers as numbers when the response field is typed; (c) explicit `{{request.body.amount.as("int")}}` | Type preservation is the big decision. Templates today always stringify. For `amount: 50000` to stay a number in the response JSON, the tokenizer needs type awareness. |
| **Where the Razorpay-specific mock files live** | (a) In the existing `/tmp/razorpay-mocks/` output (overwrite converter output); (b) in a `tier2/` subdir; (c) directly hand-authored in `examples/mocks/razorpay/` committed to the repo | Committed examples make the demo reproducible; overwrite-on-convert means the work is lost on re-import. A post-import patch script is a middle path. |
| **How to distinguish Tier-2-enhanced mocks from baseline** | (a) A comment in the mock file; (b) an `_tier` field; (c) naming convention (`orders-v2.json`); (d) no distinction — replace in-place | Dev clarity matters; manifold tracking wants coverage. `_tier: 2` field ignored by Zod is one option. |
| **Deterministic ID generator under RT-12** | (a) Seeded PRNG — same input, same ID; (b) monotonic counter (`order_00000001`); (c) fail-fast: reject templates requiring randomness in deterministic mode | Counter is easiest to assert in tests. PRNG is more Razorpay-shaped. Both are acceptable. |
| **Handling of rarely-sent optional fields** | (a) Omit from response when absent from request; (b) include with `null`; (c) include with Razorpay example default | Razorpay includes `null` for absent fields (`offer_id: null`). Match that behavior. |
| **Migration path for existing mocks** | (a) Script that upgrades in place; (b) regenerate from source (Postman) with a Tier-2-aware converter; (c) hand-edit (5 files) | For 5 endpoints, hand-edit is fastest and clearest. For later tiers covering dozens, a migration script becomes worth it. |
| **Regression test fixture placement** | (a) `tests/razorpay-tier2.test.ts`; (b) `tests/integration/razorpay.test.ts`; (c) a new `examples/tests/` directory showing "how to test against mockstar" | Putting in `tests/` subjects them to the existing suite. Putting in `examples/` documents the pattern for users. |

## Known tensions (for m2-tension)

### TN-A: Hot-path complexity vs. RT-6 budget

Each request-echo template evaluates at request time. We have RT-6's
p99 < 5 ms budget. Today's templates are compiled at config load (RT-6.2);
Tier 2 doesn't change that, but it adds more work per request — JSON
walking with type-preserving substitution, timestamp generation, ID
generation (crypto.randomBytes or PRNG). Mitigations:
- Measure. The current bench shows p99 = 285 µs, so we have roughly 4.7 ms
  of headroom. ID generation is sub-µs; timestamps are sub-µs; echoing is
  an object lookup. Budget-wise this is safe, but verify with the bench.
- If `{{now.unix}}` uses `Date.now()` per call, that's 100ns on modern
  hardware. Cache once per request in the templating context.

### TN-B: Fidelity vs. the 85 skipped endpoints

After Tier 2, the 5 top endpoints look real. The other 141 mocked endpoints
still return frozen example bodies. The 85 endpoints the Postman collection
had no example for still return 404. The user's experience is non-uniform:
"it works like a real API for the things I care about, and like a placeholder
everywhere else." Documentation needs to be explicit about this — a
per-endpoint status table.

### TN-C: Type preservation vs. the existing template contract

Today, every template token renders to a string. `{{request.body.amount}}`
inside a JSON body string becomes `"50000"`. Razorpay's API returns
`50000` (number). Making templates type-aware is a legitimate change to the
templating contract:
- Breaking change? Arguably not — today's behavior was wrong for numeric
  fields, just tolerated.
- Does it cascade to other parts of the system? Headers are strings;
  string-mode templates should stay string-mode. Only JSON-value templates
  need this.
- How does the tokenizer know whether the source field is numeric?
  Two paths: (a) infer from `typeof request.body.amount`; (b) explicit
  type cast syntax.

### TN-D: Razorpay-specific helpers vs. a generic identity helper

Building `razorpay.id(...)` locks us in. Building a generic `id(prefix,
length, alphabet)` supports Stripe, Twilio, etc. from day one. The cost
is one extra argument on every call. For five endpoints, that's trivial.

### TN-E: Deterministic mode vs. real-Razorpay shape

RT-12 deterministic mode wants byte-identical output. A counter-based ID
(`order_00000001`) is deterministic but won't pass Razorpay's SDK regex
validation. A seeded PRNG produces a proper-shaped ID that is also
deterministic. The latter requires the PRNG state to be scoped to the
tenant (or the whole process) so parallel requests don't interfere.

## References

- [Razorpay API documentation](https://razorpay.com/docs/api/) — especially
  the schema sections for orders, customers, payments, refunds, payment
  links.
- Mockstar constraint `U4` — templating helpers.
- Mockstar constraint `RT-6.2` — templates compiled at config load. Tier 2
  must honour this.
- Mockstar constraint `RT-12` — deterministic mode. Tier 2 must degrade
  gracefully into byte-identical output here.
- Mockstar's `scripts/import-postman.ts` — the source of the initial
  imported mocks. Tier 2 either patches its output in place, re-runs
  against a modified input, or layers on top.
- Mockstar finding `F3` (closed) — established the `CompiledJsonValue`
  pipeline Tier 2 will lean on for type-aware substitution.
- Mockstar finding `F2` (open, non-blocking) — importer doesn't synthesize
  schemas into examples. Tier 2 is scoped to endpoints that have examples;
  F2 is the orthogonal work for expanding coverage.
