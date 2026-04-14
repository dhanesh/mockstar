# tier2-request-derived-responses

## Outcome

Any API that can be represented as an **OpenAPI 3.x spec (JSON or YAML) or a Postman collection** should, after import into mockstar, return **dynamic, request-derived responses** — not verbatim example bodies. The primitives are provider-agnostic; Razorpay is the worked example used to validate shape, not the scope.

The mock response must:

1. Generate a **provider-shaped unique ID per request** via a generic templating primitive. The primitive accepts `prefix`, `length`, and `alphabet` so it produces Razorpay-style (`order_` + 14-char base-62), Stripe-style (`cus_` + 14-char base-62, `pi_` + 24, `ch_` + 24), Twilio-style (`AC` + 32-char hex, `SM` + 32), Square-style (`sqp_` + 22-char UUID-like), PayPal-style (UUIDs), UUID-v4 generic, or any future provider's convention. Razorpay-compatible IDs specifically pass `/^(order|pay|cust|rfnd|plink)_[A-Za-z0-9]{14}$/`; equivalent provider regexes pass for their own prefixes.
2. **Echo request body fields** into the response via type-preserving templating (`{{request.body.amount}}` stays a number; `{{request.body.receipt}}` stays a string; nested objects and arrays are preserved). Works regardless of which provider's schema the field belongs to.
3. Set **`created_at` / timestamp fields** to the current time via helpers that support multiple granularities (`{{now.unix}}` seconds, `{{now.millis}}` ms, `{{now.iso}}` ISO-8601) so the same primitives serve Razorpay (unix-seconds), Stripe (unix-seconds), Twilio (ISO), PayPal (ISO), and others without per-provider code.
4. **Preserve static structure** from the source spec/collection (fields that are always present with fixed values — `entity: "order"`, `status: "created"`, `object: "customer"` for Stripe, etc.) — whatever the example in the OpenAPI/Postman source declared as constant.

**Key design constraint:** the feature is **import-pipeline-level**, not provider-specific. The OpenAPI and Postman importers should produce Tier-2-enhanced mocks automatically, or an adjacent post-import enhancement step should operate on ANY imported mock set. The 5 Razorpay endpoints are the **acceptance scenario** — they prove the primitives compose correctly — but the deliverable is the set of primitives themselves, not Razorpay-hardcoded mocks.

**Success is measured behaviorally via Razorpay as the concrete test case.** An application running against mockstar-with-Tier-2 — where the Razorpay Postman collection has been imported — can:
- Create 100 customers in a loop and insert each `cust_*` ID into a local DB with a unique constraint without collision.
- Read back `amount`, `currency`, `receipt` from a `POST /v1/orders` response and assert they equal what was submitted (numbers stay numbers).
- Parse `created_at` and compute `(now - created_at)` as < 2 seconds.
- Run in deterministic mode (RT-12 from mockstar core) and see byte-identical output for identical inputs; non-deterministic mode produces unique IDs.

**And equivalently** for a Stripe OpenAPI import, a Twilio Postman import, a PayPal OpenAPI import, etc. — the same five behaviors hold because the primitives are generic. We don't ship per-provider code paths.

**Regression bar:** must pass regression tests covering at least five endpoints of the Razorpay integration scenario plus at least one endpoint from one other provider (TBD during m1 — likely Stripe or Petstore) on every commit. Bench must not regress more than 25% from the existing Tier 1 baseline (p99 < 5ms).

**Explicitly out of scope** (to keep Tier 2 small and shippable): cross-request memory (Tier 3 stateful mocks — the mock returned by `POST /v1/orders` is NOT fetchable by a later `GET /v1/orders/:id`); request validation (rejecting `amount < 100` — we mirror whatever the request sent); webhook simulation (Tier 4); error response mocking (Tier 6 — all Tier 2 responses are happy-path); bulk/batch creation endpoints; provider-specific auth flows or signature verification.

**Decision-point frame** (resolve during m1/m2):
- ID generation primitive: nanoid with configurable alphabet vs `faker.string.alphanumeric` vs hand-rolled base-62 vs `crypto.randomBytes` + base-62 encoder.
- Template helper surface: `{{id(prefix, length, alphabet)}}` generic form vs provider namespaces (`{{razorpay.id("order")}}`, `{{stripe.id("cus")}}`) as thin wrappers, and which forms ship in v1.
- Timestamp helpers: all three (`{{now.unix}}`, `{{now.millis}}`, `{{now.iso}}`) vs a single formatter (`{{now(format)}}`).
- Type preservation tokenisation: infer from `typeof request.body.x` vs explicit cast syntax `{{request.body.amount.as("int")}}`.
- Where enhanced mocks live: overwrite importer output, add a `tier2/` subdir, hand-author in `examples/mocks/<provider>/`, or layer via a post-import enhancement pass.
- Deterministic-mode ID strategy: seeded PRNG (real-shaped output) vs monotonic counter (simpler assertions).
- Handling of absent optional fields: omit vs `null` vs the example's default value from the source OpenAPI/Postman doc.
- Regression test fixture placement: `tests/` (enforced by suite) vs `examples/tests/` (user-facing documentation of the pattern).
- Whether importers enhance by default or only when `--tier2` is passed (backward-compat consideration for existing users who re-run the importer).

**Key tensions** already visible (seeds for m2):
- **TN-A** hot-path template evaluation cost vs RT-6 p99 < 5ms budget (~4.7ms headroom today per existing bench, so likely safe — verify).
- **TN-B** per-endpoint fidelity is non-uniform. Even after Tier 2, an imported collection has SOME endpoints that are request-derived (those whose source example uses placeholder-able fields) and SOME that still return frozen examples. Documentation must be explicit about this.
- **TN-C** type preservation is a legitimate change to the existing templating contract — today tokens always stringify. String-mode templates (headers, URL params) should stay string-mode; only JSON-value templates become type-aware.
- **TN-D** generic `id(prefix, length, alphabet)` vs provider namespaces vs both. Resolving toward "generic primitive + optional provider wrappers shipped as examples, not core" keeps the core provider-agnostic.
- **TN-E** deterministic mode wants byte-identical output while provider SDKs often validate ID shape via regex. A seeded PRNG satisfies both; a counter fails some SDKs. PRNG state scoping (per-tenant vs per-process) must be explicit.
- **TN-F** (new, from the scope-generalisation) the importers today produce Tier-1-style baked-example mocks; Tier 2 changes the contract of what they produce. Either both importers are updated in lockstep, or a post-import enhancement step is added (cleaner — keeps importers simple).

**References:** mockstar core constraints U4 (templating helpers), RT-6.2 (templates compiled at config load), RT-12 (deterministic mode); finding F3 (closed — established `CompiledJsonValue` pipeline Tier 2 will extend for type-aware substitution); finding F2 (open, non-blocking — schema synthesis into examples is orthogonal). Razorpay API docs for the five validation endpoints: https://razorpay.com/docs/api/. Stripe API docs, Twilio API docs, and Petstore OpenAPI spec are candidate cross-provider validation targets for m1 to select one of.

---

## Constraints

### Business

#### B1: Provider-agnostic primitives

Core contains zero provider-specific code paths. All provider shapes (Razorpay, Stripe, Twilio, PayPal, Square, any future provider representable as OpenAPI 3.x or Postman collection) are expressible via generic templating primitives (`id(prefix, length, alphabet)`, `now.*`, type-preserving `request.body.X`). Adding a new provider costs ZERO core code changes — only new fixtures under `examples/mocks/<provider>/`.

> **Rationale:** Mockstar mocks "any API representable as OpenAPI/Postman" per the project scope. Provider-lock-in in core would (a) force mockstar maintainers to chase every provider's ID-format change, (b) bloat the binary with per-provider modules, (c) make third-party provider contributions require core-code review rather than a fixture PR.

#### B2: Lift mockstar from response-parse smoke to created-resource workflow testing

An application running against mockstar-after-Tier-2 can reliably test workflows that (a) create a resource and store its returned ID in a local DB with a unique constraint, (b) read back and assert submitted-field echo, (c) assert creation-timestamp is approximately now. These three are the GOAL; the target applications are real enough that an integration test against mockstar produces the same pass/fail signal as against the real API for happy-path write flows.

> **Rationale:** The current verbatim-baked mocks satisfy "does my parser handle the response shape" but not "does my write-path actually work." That gap is the single biggest blocker to mockstar being the default mock target in CI.

#### B3: Ship within scope

Tier 2 ships the primitives + enhancer + 4-provider regression. It does NOT include: cross-request state (Tier 3), GET-by-ID read-back of created resources, request validation (amount-bounds etc.), webhook simulation (Tier 4), error-response mocking (Tier 6), subscriptions/invoices/items/QR/smart-collect/settlement/route-transfer endpoints, bulk-creation endpoints, provider-specific auth flows, signature verification. Any of these surfaces as a NEW feature (Tier 3+), not a scope expansion of Tier 2.

> **Rationale:** Tier 2 is the single-sprint deliverable that establishes dynamic response generation. Adding statefulness or error modes doubles scope and delays the shippable primitive set.

#### B4: Cross-provider regression coverage

Regression tests exist for at least 4 providers demonstrating the primitives work generically: Razorpay (5 endpoints — orders, customers, payments capture, refunds, payment-links), Stripe (≥1 endpoint — likely customers or payment_intents), Twilio (≥1 endpoint — message create or account fetch), PayPal (≥1 endpoint — orders create or capture).

> **Rationale:** One-provider regression would not prove B1. Stripe validates variable-length IDs ("opaque ≤ 255 chars"); Twilio validates hex alphabet + ISO timestamps; PayPal validates uppercase-alphanumeric. Razorpay alone covers only 14-char base62 + unix seconds.

---

### Technical

#### T1: p99 response time ≤ 5ms after Tier 2

Total request-handling time at p99 must remain within mockstar core's RT-6 budget of 5ms, including all Tier-2 template evaluation (ID generation, timestamp capture, request-body JSON walk with type-preserving substitution, response serialization).

> **Rationale:** Current bench (Tier 1 baseline) shows p99 ≈ 1.65ms, so ~3.35ms of headroom. ID gen is sub-µs (nanoid); timestamps are sub-µs; the JSON walker cost scales with response-body size. Budget-wise this is safe, verified by bench gate O1.

> **Threshold:** statistical, p99 ≤ 5ms.

#### T2: Generated IDs pass target-provider conformance

IDs produced by the `id(prefix, length, alphabet)` primitive conform to the target provider's shape rules:
- **Razorpay:** `/^(order|pay|cust|rfnd|plink)_[A-Za-z0-9]{14}$/` — fixed length, base62 alphabet.
- **Stripe:** Prefix + base62; length varies per entity (`cus_` → 14, `pi_` → 24, `ch_` → 24). Spec is "treat as opaque, ≤255 chars" — we conform to observed current lengths but don't guarantee future-length exactness.
- **Twilio:** 2-letter uppercase prefix + exactly 32 hex lowercase chars = total 34; alphabet is `[a-f0-9]` not base62.
- **PayPal:** Orders v2 uses 17-char uppercase alphanumeric (`[0-9A-Z]{17}`), not UUID.

The primitive accepts `prefix`, `length`, and `alphabet` arguments and produces strings matching each pattern.

> **Rationale:** Visual resemblance is insufficient. SDKs and application code run regex validation; IDs failing the regex break integration test assertions. Confirmed via web search against 2026 provider docs.

#### T3: Type-preserving JSON templating

Response template substitution preserves JavaScript types across the request→response boundary. When the response template is a JSON body, the templating engine parses the template as JSON-with-placeholders (Mockoon `bodyRaw` prior art), walks the template tree, and substitutes placeholder tokens with the corresponding request values while preserving type:
- `request.body.amount = 50000` (number) → response `"amount": 50000` (number, not string).
- `request.body.notes = {"user": "alice"}` (object) → response `"notes": {"user": "alice"}` (nested object).
- `request.body.tags = ["a", "b"]` (array) → response `"tags": ["a", "b"]` (array).
- `request.body.missing` (undefined) → response uses T8 fallback.

> **Rationale:** Today mockstar's templating stringifies every token — `"amount": "50000"` is wrong for every provider. Parsing the template as JSON-with-placeholders sidesteps the string-escaping pitfalls observed in WireMock/Hoverfly (which require manual unquoting with triple-stache syntax).

#### T4: Deterministic mode produces byte-identical output

When `MOCKSTAR_DETERMINISTIC=1` (mockstar core RT-12), two invocations with the same request must produce byte-for-byte identical response bodies — including IDs and timestamps. Implemented via a seeded PRNG (Mulberry32 or equivalent) whose seed is derived from request context (tenant + endpoint + monotonic counter), not process-global state or clock time.

> **Rationale:** Deterministic mode is what lets CI snapshot-compare responses across runs. A counter-based ID (`order_00000001`) also satisfies determinism but fails provider SDK regex validation. A seeded PRNG satisfies both.

#### T5: Templates compile at config-load, not per-request

Following mockstar core RT-6.2, all Tier-2 template parsing (including detecting which JSON nodes are placeholders, binding them to helpers, and validating helper arity) happens once at config load or at file-watch reload. At request time, only the compiled placeholder closures run. No per-request template-AST walks; no per-request JSON parsing of the template.

> **Rationale:** Per-request compilation would blow the p99 budget for mocks with large or deeply-nested templates. Compile-once keeps the hot path minimal.

#### T6: 100 parallel creates yield 100 unique IDs

A burst of 100 concurrent `POST /v1/orders` (or equivalent) calls against a Tier-2 mock must return 100 distinct `order_*` IDs. No collisions under normal (non-deterministic) operation.

> **Rationale:** Users chain created-resource IDs into local DBs with unique constraints. Collisions produce silent test failures that look like DB bugs. At nanoid@21 with length 14 base62, the expected collision count in 100 draws is `< 2 × 10^-20` — effectively impossible.

> **Threshold:** statistical, 100/100 unique at length 14 base62.

#### T7: Enhancer is a separate command

Tier-2 mock enhancement runs as `mockstar enhance <dir>`, a new top-level subcommand that reads existing imported mocks and rewrites response bodies in place. OpenAPI and Postman importers are NOT modified. The separation means:
- Users who re-run the importer don't lose Tier-2 enhancement (they run `enhance` again after).
- Future importers (Bruno, Insomnia, HAR) inherit Tier 2 for free.
- The enhancer's complexity doesn't leak into the importers.

> **Rationale:** Coupling Tier 2 into both importers in lockstep (option B) means every future importer must know Tier 2; hand-editing (option C) doesn't scale past 5 endpoints.

#### T8: Missing request fields fall back gracefully

When a response template references `request.body.<field>` and the request omits that field, the substitution uses, in order: (a) the source example's value for that field (from the OpenAPI example or Postman collection's example response); (b) a type-appropriate default (`0` for numbers, `""` for strings, `null` for objects, `[]` for arrays); (c) if the response field has no source example AND the field is typed, the type's zero value. The response must remain valid JSON and match the source schema.

> **Rationale:** Applications may send partial requests during testing. Crashing on a missing field makes mockstar too brittle; silently emitting `undefined` makes response validation fail downstream.

#### T9: nanoid with custom alphabet is the core ID primitive

The `id(prefix, length, alphabet)` helper is backed by `nanoid`'s custom-alphabet constructor in non-deterministic mode (CSPRNG via `crypto.getRandomValues`), and a Mulberry32 seeded PRNG wrapper in deterministic mode. Alphabet defaults to base62 `[A-Za-z0-9]`; length defaults to 14. Prefix is required. Both branches produce IDs that satisfy T2.

> **Rationale:** nanoid is the de facto JS-ecosystem standard, CSPRNG-backed, sub-µs per call, and its alphabet parameter is exactly what T2 needs. Hand-rolling the encoder is code we don't need to own.

#### T10: Seeded PRNG scoped per-request

Under deterministic mode, the PRNG state is instantiated per request (seed = hash of tenant + endpoint + request-monotonic-counter), not as a shared process-wide Math.random. Parallel requests produce stable, independent, non-interfering PRNG streams. There is no shared mutable state between concurrent request handlers. **(Validated by pre-mortem — "PRNG state-leak" failure story was pre-emptively raised and tightened.)**

> **Rationale:** Process-global PRNG state under concurrent deterministic-mode requests would produce different IDs depending on request ordering, breaking RT-12's byte-identical guarantee.

#### T11: Enhancer preserves user-made post-enhancement edits (pre-mortem)

Running `mockstar enhance <dir>` twice on the same directory must produce the same result (idempotency, O3). AND: if a user hand-edits an enhanced mock between runs (e.g., changes a template, adds a custom handler directive), the next `enhance` run must preserve those edits, not wipe them. Mechanism is a marker (e.g., `_tier: 2` + optional `_userEdited: true` or section-scoped diff) that the enhancer respects.

> **Rationale (pre-mortem):** Without this, devs lose work on every re-run. A tool that destroys user edits is a tool devs disable.

#### T12: Field-mapping rules are documented and overridable (pre-mortem)

The enhancer must declare how it maps request fields to response fields — by name match (`request.body.amount` → `response.amount`), by position in a Postman example's request/response pair, or via an explicit per-endpoint override (`_tier2Mapping: {responseField: "request.body.otherName"}`). Cases where no mapping can be inferred are left as literal source-example values (not silently corrupted) and surfaced in a warning.

> **Rationale (pre-mortem):** OpenAPI/Postman examples don't always declare request→response correspondence. Heuristic field-name matching fails in subtle ways (e.g., `amount` in request vs `total_amount` in response). Users need a way to override.

#### T13: Deterministic JSON key ordering (pre-mortem)

The template walker emits response JSON keys in deterministic order: keys present in the source example appear in their source order first, then any echoed-but-not-in-source keys appear in alphabetical order. This guarantees byte-identical output under T4 and stable snapshot-test / HMAC-signature compatibility.

> **Rationale (pre-mortem):** Some downstream consumers (HMAC signature validation, snapshot-diff tests) break on key-order drift. Object-discovery order in a JS Map is insertion-order, which may differ from template-author intent.

#### T14: Cycle detection + max recursion depth (pre-mortem)

The type-preserving JSON walker has (a) a visited-set cycle detector for self-referencing objects, and (b) a configurable max recursion depth (default 32). Pathological inputs (recursive schemas, adversarial request bodies with 10K-deep nesting) produce a structured 422 error response, not a stack overflow or infinite loop.

> **Rationale (pre-mortem):** Real-world OpenAPI specs have `$ref` cycles for nested entities. Mockstar's core process isolation (unhandled-rejection crash handler) would restart the whole process on a stack overflow — a regression from Tier 1.

#### T15: Format version detection (pre-mortem)

The enhancer declares supported OpenAPI and Postman collection format versions (e.g., "OpenAPI 3.0.x + 3.1.x, Postman 2.1.0"). Unknown versions produce a clear error at start time, not silent corruption at runtime. The supported versions are visible via `mockstar enhance --help` and declared in docs.

> **Rationale (pre-mortem):** Postman has been through v2.0 → v2.1 → v2.2; v3 is on the horizon. An enhancer that silently accepts v3 and emits garbage is worse than one that refuses v3.

---

### User Experience

#### U1: Helper surface is generic-first

Core ships a generic helper set: `{{id(prefix, length, alphabet)}}`, `{{now.unix}}`, `{{now.millis}}`, `{{now.iso}}`, `{{now(format)}}` for custom formats, type-preserving `{{request.body.X}}`, `{{request.query.X}}`, `{{request.params.X}}`. Provider-specific namespaces (`{{razorpay.id("order")}}`, `{{stripe.id("cus")}}`) may be added as thin wrappers in `examples/` but are NOT part of the core helper surface.

> **Rationale:** B1 (provider-agnostic) is enforced at the API-surface level, not just in the implementation.

#### U2: Existing non-JSON-body templates remain string-mode

Tier 2 does NOT break existing mockstar users whose templates live in HTTP headers, URL-path params, or query-string builders. Those templates stay string-mode (stringified substitution). Only JSON-value templates (response body fields parsed as JSON) become type-aware. Migration note in CHANGELOG: "if you previously used `{{request.body.amount}}` in a response body expecting `"50000"` (string), you will now get `50000` (number) — adjust assertions accordingly. Header and URL-param templates are unchanged." **(Validated by pre-mortem — "type preservation broke existing templates" story pre-empted; scope restricted to JSON-body context.)**

> **Rationale:** Silently type-changing all template tokens everywhere would break current users.

#### U3: Provider-shaped mock examples shipped as documentation

`examples/mocks/razorpay/` contains the 5 Tier-2-enhanced Razorpay endpoints. `examples/mocks/stripe/`, `examples/mocks/twilio/`, `examples/mocks/paypal/` contain ≥1 enhanced endpoint each for the cross-provider regression (B4). These directories serve as documentation ("here's how the primitives compose for your API") and as the input corpus for the regression tests.

> **Rationale:** Primitives alone don't show users how to compose them. Working, runnable examples do.

#### U4: `mockstar enhance` is discoverable

`mockstar --help` lists `enhance`. `mockstar enhance --help` documents the command. README has a top-level section on Tier 2 linking to `docs/ENHANCE.md` (to be created in m4). CHANGELOG calls out the new command explicitly under a Tier 2 section.

> **Rationale:** Unsurfaced commands are unusable commands. Tier 1 tried to make `mockstar proxy` findable; Tier 2 does the same for `mockstar enhance`.

---

### Security

#### S1: Malformed request body must not crash templating

Invalid JSON, truncated bodies, wrong Content-Type, oversized bodies, and missing bodies all produce structured error responses (400 or 422) with a clear message. No unhandled rejection, no stack trace in response, no process crash. Mockstar core's per-request try/catch tier catches templating errors and routes them to the core error response.

> **Rationale:** Mockstar is a test tool; developers intentionally send weird payloads to test error handling. Crashing the mock kills the dev's session.

#### S2: ID generation is CSPRNG-backed in production, seeded-PRNG in deterministic mode

Non-deterministic mode uses nanoid → `crypto.getRandomValues` (CSPRNG). Deterministic mode uses a seeded Mulberry32 wrapper (NOT CSPRNG, but deterministic by design). Nothing in Tier 2 may use `Math.random()`. This is enforced by a test that monkey-patches `Math.random` to throw and runs the ID-gen path.

> **Rationale:** Math.random is predictable enough that an attacker who observes a few mockstar-generated IDs could predict future IDs, which matters if mockstar is used in shared staging environments where one tenant's IDs should be unguessable to another.

#### S3: Echo helpers access body/query/params only — never headers

`{{request.body.X}}`, `{{request.query.X}}`, `{{request.params.X}}` are the ONLY request-echo helpers. `{{request.headers.X}}` is deliberately NOT added. This prevents an application accidentally echoing an `Authorization: Bearer <token>` header into a response body (a response body that may later be logged, cached, or displayed in a UI).

> **Rationale:** Auth tokens, session cookies, and PII live in headers by convention. Echoing them into response bodies is an observed real-world mistake (GitHub leaked-token-via-response-body incidents). Preempt it.

#### S4: Bounded response size

Response bodies (including echoed request fields) must respect mockstar core's body-size limit (1MB by default). A request with a 10MB `notes` field that gets echoed into the response triggers a 413 Payload-Too-Large before serialization, not a memory exhaustion.

> **Rationale:** Amplification via echo is a cheap DoS. One 10MB request creates a 10MB response; at 10 req/s that's 100MB/s of egress per attacker.

> **Threshold:** deterministic, max response bytes = 1MB (inherits mockstar core body limit).

#### S5: Template evaluator is sandboxed (pre-mortem)

The template syntax is a grammar with a fixed helper surface — NOT a JavaScript `eval` or `Function()` call. Templates cannot access `process`, `require`, `import`, `fetch`, the filesystem, or any host capability. A mock-config author cannot craft a template that executes arbitrary code. Helper arity and argument types are statically validated at compile-time (T5).

> **Rationale (pre-mortem):** If a template expression syntax accidentally grew into a full expression evaluator, a malicious mock config (which in CI often comes from a shared repo with a large committer pool) could achieve RCE on the mockstar process. This has happened in other mocking tools; we prevent it by design.

---

### Operational

#### O1: Bench regression cap ≤ 25%

Tier 2 must not regress mockstar's p99 by more than 25% over the Tier 1 baseline (measured via `mockstar proxy bench` — current baseline warm p99 1.65ms, so Tier 2 ceiling is ~2.06ms warm p99). A CI job runs the bench on every PR; regressions beyond the cap block merge.

> **Rationale:** Without a bench gate, per-request template eval cost compounds over time. Tier 1 caught the cost of SNI lookup early; Tier 2 must do the same for type-preserving walks.

> **Threshold:** statistical, p99 regression ≤ 25% over Tier 1 baseline.

#### O2: Regression tests live in `tests/`, run every commit

`tests/tier2-razorpay.test.ts`, `tests/tier2-stripe.test.ts`, `tests/tier2-twilio.test.ts`, `tests/tier2-paypal.test.ts` each cover their provider's endpoints with assertions on (a) ID regex conformance, (b) request-field echo accuracy, (c) timestamp freshness (within 2s of test clock), (d) deterministic-mode byte-identity across two runs. The full suite runs on every `bun test` invocation and on every CI commit.

> **Rationale:** Tests outside the default suite are tests that rot. B4 is only protected if the CI sees it on every commit.

#### O3: Enhancer is idempotent

Running `mockstar enhance <dir>` twice on the same input directory produces byte-identical output. No timestamp in the enhanced files, no random sort order, no non-deterministic anchors. This is property-tested (run enhance, diff; run enhance, diff-expect-zero).

> **Rationale:** Idempotency is what makes the enhancer safe to run repeatedly in CI / pre-commit hooks / IDE-save hooks.

#### O4: Deterministic-mode byte-compare CI

A specific CI job runs two mockstar instances in deterministic mode against the same fixture set and byte-compares responses. Any divergence fails the job. This exercises T4 + T10 + T13 (key ordering) in combination.

> **Rationale:** RT-12 deterministic mode is a strong claim that only means something if it's continuously tested under real conditions.

#### O5: Bench checkpoint at m4 milestones (pre-mortem)

During m4-generate, the bench runs after each major artifact group lands (templating engine → enhancer → provider fixtures), not only at m5. Any regression > 25% raises a flag before later phases compound the cost.

> **Rationale (pre-mortem):** Discovering a 10× bench regression at m5 means rewinding a lot of work. Early checkpoints catch compounding cost while it's cheap to fix. This is a process constraint, testability is weak (score 2/2/2).

#### O6: ID collision stress test (pre-mortem)

A test draws 1M IDs at length 14 base62 via the default non-deterministic path and asserts zero collisions. Runs on every commit (fast — ~2s). A separate long-running stress test runs nightly at 100M draws and asserts zero collisions.

> **Rationale (pre-mortem):** A subtle change to the CSPRNG source or a nanoid bump with a regression could re-introduce collisions. The 1M test catches most regressions in CI time; the nightly 100M catches edge cases.

> **Threshold:** statistical, 0 collisions in 1M draws at length 14 base62.

---

## Tensions

### TN1: p99 budget vs type-preserving walker cost

**Between:** T1 (p99 ≤ 5ms) and T3 (type-preserving JSON walker).

Type-aware substitution that walks request.body and preserves JS types on every request adds compute to the hot path. With mockstar core's existing p99 around 1.65ms (measured in Tier 1 bench), we have ~3.35ms of headroom — not unlimited. Templates with deeply nested echoes could compound the cost, and once that cost lands in master, rolling it back is painful.

**TRIZ:** Technical contradiction. Parameters: speed vs correctness. Principles: P10 prior-action, P11 beforehand-cushioning, P1 segmentation.

> **Resolution:** Compose three existing constraints to keep the hot path bounded — (a) T5 (compile at load-time) means the template AST walk happens ONCE per config reload, not per request; at request time only bound closures run; (b) U2 (string-mode for non-JSON contexts) narrows type-aware work to JSON-body substitutions only — headers and URL-path templates stay on the cheap path; (c) S4 (bounded response size, 1MB) + incremental size tracking during walk (see TN9) cap total walker work per request. Bench gate O1 (≤ 25% regression cap) enforces the outcome in CI. Expected per-request cost for a typical response body: ~50-200μs added, well inside headroom. **Propagation:** T5 TIGHTENED (compile-time output is a closure tree, not just a helper lookup); O1 TIGHTENED (becomes load-bearing for this resolution).

---

### TN2: Cross-provider coverage vs ship-in-scope

**Between:** B4 (cross-provider regression) and B3 (Tier 2 ships within scope).

Full 5-endpoint coverage per provider × 4 providers = 20 fixtures + 20 tests. That's a scope-creep trap — most of it would be mechanical duplication proving the same primitive works. But without some multi-provider coverage, B1's "provider-agnostic" claim is unfalsifiable.

**TRIZ:** Technical contradiction. Parameters: simplicity vs capability. Principles: P1 segmentation, P27 cheap-short-living.

> **Resolution:** Segment by intent. Razorpay keeps 5-endpoint coverage (full Tier 2 demo). Stripe, Twilio, PayPal each get EXACTLY ≥1 endpoint — enough to exercise a non-Razorpay ID shape and timestamp format, not enough to duplicate coverage. Fixtures are pure JSON (no SDK integrations) so they're cheap to maintain. Total: 5 + 1 + 1 + 1 = 8 regression endpoints. **Propagation:** B4 TIGHTENED (minimum is now literally ≥1 per non-Razorpay, documented explicitly).

---

### TN3: Don't break existing templates vs type-preserving JSON

**Between:** U2 (existing non-JSON-body templates unchanged) and T3 (type-preserving walker).

Silently making all template tokens type-aware would break users whose existing templates emit strings into HTTP headers, URL paths, or query-string builders. But the feature is worthless if `{{request.body.amount}}` in a JSON body still stringifies.

**TRIZ:** Physical contradiction (same element must be both string-preserving and type-preserving). Parameters: standardisation vs flexibility. Principles: P1 segmentation, P3 local-quality.

> **Resolution:** Segmentation by template context. A template's context (JSON-body value vs header value vs URL-path value) is known at compile time (T5). JSON-body contexts get the type-preserving walker; all other contexts retain today's string-substitution behavior. This is codified in U2 (already validated by pre-mortem) as the explicit contract. Migration notes in CHANGELOG for users who had `"amount": "{{request.body.amount}}"` expecting strings. **Propagation:** U2 TIGHTENED (now an explicit API-level distinction, not just a mental model); T3 LOOSENED (smaller scope is easier to implement correctly).

---

### TN4: Deterministic byte-identity vs provider SDK regex

**Between:** T4 (deterministic byte-identical output) and T2 (IDs pass provider SDK regex).

Deterministic mode wants reproducible IDs — easiest with a monotonic counter (`order_00000001`). But `order_00000001` fails Razorpay's `[A-Za-z0-9]{14}` regex (needs exactly 14 base62 chars; `00000001` is 8 chars with leading zeros) and any real SDK's shape validation.

**TRIZ:** Approximate match (nearest: global vs local optimum — actually more precisely reproducibility vs authenticity). Principles: P10 prior-action, P40 composite.

> **Resolution:** A composite approach (P40) — a seeded PRNG (Mulberry32 or equivalent) whose input is deterministic (tenant + endpoint + request-counter, NEVER Date.now) and whose output is alphabet-and-length-configurable to match each provider's regex. T9 already commits to nanoid's `customRandom` form which accepts an external PRNG; T10 adds per-request seed scoping. Deterministic input → deterministic output, AND output matches provider regex. Both constraints satisfied without compromise. **Propagation:** T9 TIGHTENED (must use nanoid's customRandom form, not the default); T10 TIGHTENED (becomes load-bearing).

---

### TN5: No provider-specific core vs provider-shaped examples shipped

**Between:** B1 (zero provider-specific code in core) and U3 (`examples/mocks/{razorpay,stripe,twilio,paypal}/` ship as documentation).

If we ship provider-named directories, aren't we provider-specific? This is a surface tension — B1 says "core" and U3 says "examples" — but it's worth documenting explicitly so we don't later leak provider names into `src/`.

**TRIZ:** Physical contradiction (same project must be both provider-agnostic and ship provider-shaped content). Parameters: standardisation vs flexibility. Principles: P1 segmentation, P2 extraction.

> **Resolution:** Segment "core" (= `src/`) from "examples" (= `examples/`). Core contains zero `grep -i 'razorpay\|stripe\|twilio\|paypal'` matches (outside comments/tests). Fixtures are JSON data, not code. Examples are opinionated documentation of how the generic primitives compose for each provider — swappable, extensible, deletable. Test gate: a grep check in CI fails any PR that introduces provider names into `src/` outside `examples/` paths. **Propagation:** B1 TIGHTENED (moves from aspiration to testable boundary).

---

### TN6: Enhancer adjacency vs field-mapping info

**Between:** T7 (enhancer is separate from importers) and T12 (enhancer needs request→response field mapping).

The enhancer needs to know which response fields should become echoes of which request fields. That mapping lives in the original OpenAPI/Postman source — which the importers consume but the enhancer (per T7) doesn't touch.

**TRIZ:** Technical contradiction. Parameters: simplicity vs capability. Principles: P1 segmentation, P24 intermediary.

> **Resolution:** Enhancer accepts `--spec <path>` and re-parses the original OpenAPI/Postman file itself. This duplicates some parser logic from the importer (mitigated by extracting a shared `src/features/spec/` parser module that BOTH importer and enhancer use — neither owns it). When `--spec` is absent, enhancer falls back to heuristic field-name matching across request/response example pairs (for Postman) and emits a warning listing mappings it couldn't infer. Ambiguous mappings are NEVER silently substituted — they're left as the source example's literal value, and the user sees a warning with the field path to hand-patch. T12 now has a concrete mechanism; T7 (enhancer ≠ importer) is preserved because both tools share a third-party parser, neither imports the other. **Propagation:** T7 LOOSENED (shared parser module is a cleaner factoring than either tool owning the parse); T12 TIGHTENED (explicit override mechanism + warning path required).

---

### TN7: Enhancer idempotency vs preserving user edits

**Between:** O3 (enhancer idempotent — enhance twice → same output) and T11 (enhancer preserves user edits made between runs).

These sound contradictory — "always produce the same output" and "preserve edits the user made to that output" pull in opposite directions. Without a clear boundary, the enhancer would either wipe user work (violating T11) or produce different output on re-runs (violating O3).

**TRIZ:** Physical contradiction (same file must be both enhancer-owned and user-editable). Parameters: standardisation vs flexibility. Principles: P1 segmentation, P17 another-dimension.

> **Resolution:** Spatial segmentation within the JSON file via a well-known top-level key. Enhanced fields live inside `_mockstarGenerated`:
>
> ```json
> {
>   "_mockstarGenerated": {
>     "id": "{{id('order', 14)}}",
>     "amount": "{{request.body.amount}}",
>     "created_at": "{{now.unix}}"
>   },
>   "customField": "user-added",
>   "anotherUserField": 42
> }
> ```
>
> Enhancer ONLY writes/overwrites keys inside `_mockstarGenerated`. Any sibling key the user adds at top-level (or elsewhere outside the generated region) is preserved verbatim on re-enhance. The response assembler merges `_mockstarGenerated` into the top level at request time so the final response JSON doesn't expose the internal boundary. **The key name is `_mockstarGenerated` — tool-named, not manifold-internal jargon like `_tier2*`** (explicit user preference: avoid naming user-facing fields after manifold framework concepts). **Propagation:** O3 TIGHTENED (idempotency scope narrows to inside the boundary); T11 LOOSENED (mechanism is now a single well-known key, trivial to test).

---

### TN8: Per-request PRNG scoping vs compile-time helper binding

**Between:** T10 (PRNG state per-request, not process-global) and T5 (templates compile at config load, helpers bound then).

Compile-time binding implies a stable reference for the helper. Per-request state implies fresh state each request. Binding a single PRNG instance at compile-time would mean shared state across requests (violates T10). Binding nothing at compile-time and resolving everything at request time would violate T5.

**TRIZ:** Technical contradiction. Parameters: performance vs reliability. Principles: P10 prior-action, P24 intermediary.

> **Resolution:** Compile-time binding produces a FACTORY closure, not an instance. Each `{{id(...)}}` template node at compile time becomes a closure of type `(requestCtx) => string` — when invoked at request time, it materialises a per-request PRNG (seeded from requestCtx in deterministic mode) and emits an ID. Factory state is shared across requests (it's just a function reference, immutable); PRNG state is per-invocation. Both T5 and T10 satisfied. This is essentially the intermediary pattern (P24) — the factory mediates between compile-time binding and request-time execution. **Propagation:** T5 TIGHTENED (compile-time output must be factory closures, a stricter shape than plain helper references); T10 LOOSENED (per-request scoping is a natural consequence of the factory pattern).

---

### TN9: Size bound vs type preservation of large nested objects

**Between:** S4 (1MB response body cap) and T3 (type-preserving echo of request fields).

If a user's request contains a 10MB nested `notes` object and the response template echoes it via `{{request.body.notes}}`, type preservation says "emit the object exactly" but S4 says "≤1MB total." Naive implementation: serialize the whole response, THEN check size, THEN reject — wastes work. Worse: serialize, send, then truncate — produces invalid JSON on the wire.

**TRIZ:** Technical contradiction. Parameters: speed vs safety. Principles: P11 beforehand-cushioning, P35 parameter-changes.

> **Resolution:** The walker tracks cumulative byte-count during substitution (not post-serialization). When an echoed field's serialized size would push the total over 1MB, the walker short-circuits: aborts the substitution, emits a structured 413 Payload-Too-Large response, and skips the rest of the walk. The 413 body is itself bounded small (< 1KB), and T14 (cycle detection + max-depth) is the first-order safeguard for pathological request shapes. **Propagation:** T3 TIGHTENED (walker needs incremental size-tracking state per walk); S4 LOOSENED (size bound is now enforced incrementally, which is both cheaper and more precise than post-check).

---

<!-- Added in m3-anchor. Draft RTs in JSON's `draft_required_truths` seed m3. -->

