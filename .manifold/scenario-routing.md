# scenario-routing

## Outcome

Mock consumers can declare value-keyed scenario rules: when a specified request attribute (path param, query, header, or body field) matches a given value, the mock returns a designated response — including non-happy-path bodies and status codes — without needing a separate mock file per case. Example: `lastName = "Test"` → 404, `lastName = "Carpenter"` → 500, `lastName = "Locked"` → 423 with a custom body.

---

## Constraints

### Business

#### B1: Backward Compatibility
Mock files without a `scenarios` field continue to work exactly as before. Adding scenario routing must not require any changes to existing mock files.
> **Rationale:** Existing fixtures in production and CI cannot be broken. Any opt-in feature must be purely additive to the schema.

#### B2: Non-Happy-Path Coverage
Users can produce any HTTP status code (100–599) and any valid JSON body shape for error scenarios, triggered by a request attribute value match — without writing a new mock entry or file.
> **Rationale:** The primary use-case is simulating provider error responses in tests, which today requires duplicating mock entries per case.

#### B3: Colocation
Scenario rules live in the same mock entry as the default response. No separate file, no separate admin API call, no secondary config file.
> **Rationale:** Discoverability — a reader of the mock file sees all possible responses for an entry in one place.

---

### Technical

#### T1: Single Tier 2 Walker Pass
Scenario evaluation runs after route matching and before Tier 2 template rendering. The winning scenario's response fields replace the entry defaults, then the Tier 2 walker runs exactly once on the final merged response. The walker is never run on both the default and the scenario.
> **Rationale:** Tier 2 rendering is stateful (e.g. `id.named` caches per-request); running it twice would produce inconsistent IDs. Type preservation (whole-string placeholder → source type) must apply to scenario bodies exactly as it does to default bodies.
> **Pre-mortem source:** #2c — type preservation broke because the walker was invoked on the default body, then the scenario body was substituted after, bypassing the walker.

#### T2: First-Match-Wins Evaluation
Scenario rules are evaluated in declaration order. The first rule whose predicate matches the request wins. Remaining rules are not evaluated.
> **Rationale:** Deterministic; mirrors how route priority works. Allows users to put specific rules before catch-all fallbacks.

#### T3: Attribute Surface
Scenario predicates can target: path parameters (`:param`), query string values, request headers (case-insensitive), and request body dot-path values. Same attribute set as Tier 2 template tokens.
> **Rationale:** Users already think in terms of these attributes from writing mock bodies. Reusing the same surface avoids learning a new vocabulary.

#### T4: Rule Count Ceiling
Maximum 50 scenario rules per mock entry.
> **Rationale:** Bounds worst-case O(n) matching cost. 50 covers any realistic error-case matrix; beyond that the mock entry should be split.

#### T5: Tier 2 Token Support in Scenario Bodies
Scenario response bodies and headers support the full Tier 2 token set. This is enforced by T1 — the scenario body is substituted before the single walker pass.
> **Rationale:** Users need to echo request fields in error bodies (e.g. include the submitted `orderId` in a 404 body). Restricting tokens in scenario responses would create a confusing inconsistency.

#### T6: Predicate Vocabulary
Value predicates reuse the existing `StringMatch` vocabulary: exact string match (default), `{equals}`, `{regex}`, `{startsWith}`, `{contains}`.
> **Rationale:** `StringMatch` is already defined in `src/core/matching/discriminators.ts` and proven in route predicates. Reusing it avoids a parallel type and keeps the schema consistent.

#### T7: Kind-Agnostic Scenario Evaluation
Scenario routing applies to all three response kinds (`static`, `dynamic`, `passthrough`). A matching scenario short-circuits before the kind-specific handler runs — the handler is never invoked for a matched scenario.
> **Rationale:** Pre-mortem #2a — users expected dynamic and passthrough entries to support scenarios. Restricting to `static` silently degraded coverage for those cases.
> **Source:** pre-mortem

---

### User Experience

#### U1: No-Match Is Silent
When no scenario rule matches, the default mock response is returned without error, warning, or status change.
> **Rationale:** Most requests won't be error-path requests. A miss must be transparent.

#### U2: Partial Response Override
A scenario response overrides only the fields it declares (status, headers, body). Fields absent in the scenario are inherited from the mock entry's default response.
> **Rationale:** Users typically only want to change status + error body; forcing them to redeclare all headers every time is noise.

#### U3: Config-Load Validation with Actionable Errors
Malformed scenario rules are rejected at config-load time with a descriptive error: mock entry ID, scenario index (0-based), invalid field path, and reason. When the T4 ceiling (50 rules) is exceeded, the error message states the limit and suggests splitting the entry.
> **Rationale:** Pre-mortem #3 — users hitting the ceiling received a cryptic Zod error with no hint about the limit or how to fix it. Config-load is the only opportunity to surface this before a broken rule silently mis-routes requests in tests.

#### U4: Scenario Rules Visible in Admin Endpoint
The `/__admin/tenants/:tenant/mocks` endpoint includes each entry's scenario rules: rule count and the attribute key targeted by each rule (not values, to avoid leaking test data). This lets users verify declaration order without reading mock files.
> **Rationale:** Pre-mortem #1b — rule-order bugs were hard to debug because there was no runtime view of evaluation order. The admin endpoint is the logical place to expose this.
> **Source:** pre-mortem

---

### Security

#### S1: ReDoS Guard on Regex Predicates
Regex value predicates in scenario rules are validated against a catastrophic-backtracking heuristic at config-load. Patterns that trigger the heuristic are rejected with an error.
> **Rationale:** Attacker-controlled request values evaluated against an exponential-backtracking regex can hang a request worker. The same guard that applies to existing `{regex}` in route predicates must apply here.

#### S2: No Arbitrary Code Execution
Scenario value matching executes no arbitrary code. Predicates are data-driven comparisons (string equality, regex test, prefix/infix checks) only.
> **Rationale:** Defense-in-depth — the matching path must be closed to code injection regardless of config source.

---

### Operational

#### O1: Scenario ID in Journal
Journal entries record the ID of the activated scenario rule (if any) alongside the normal request log fields. If no scenario matched, the field is absent. If a scenario was evaluated but missed because the attribute was absent from the request (e.g. predicate targets `params.lastName` but route has no `:lastName`), the journal records a `scenario_miss_reason` indicating the unresolved attribute.
> **Rationale:** Pre-mortem #1a — silent attribute key typos (e.g. `params.lastname` vs `params.last_name`) produced no errors and no wrong responses, just the default — which looked correct until the test suite was audited. The journal is the first diagnostic surface.
> **Source:** pre-mortem refinement

#### O2: Hot-Reload Atomicity
When a mock file is updated and the watcher triggers a reload, scenario rule arrays are replaced atomically as part of the config snapshot swap. In-flight requests hold a reference to the old snapshot and complete without error against a consistent rule set.
> **Rationale:** Partial replacement where some in-flight requests see a mix of old and new rules would cause non-deterministic test failures.

#### O3: Compiled Regex Ownership Scoped to Snapshot
Compiled regex predicate objects are owned exclusively by the config snapshot that created them. When a snapshot is superseded by a hot-reload, no external references to that snapshot's regex objects survive — they become eligible for GC with the old snapshot.
> **Rationale:** Pre-mortem #2b — the scenario evaluator held a reference to compiled regex objects outside the snapshot lifecycle, causing a memory leak under frequent hot-reloads during development.
> **Source:** pre-mortem

---

## Tensions

### TN1: Kind-Agnostic Short-Circuit vs Partial Override Inheritance

T7 requires scenarios to short-circuit before the kind-specific handler runs for all response kinds. U2 requires scenarios to inherit unspecified fields from the "default" response. For `static` entries the default is a known JSON value. For `dynamic` and `passthrough` entries, the default is computed at runtime — you cannot inherit from something you bypassed.

> **Resolution (Partition — P1 Segmentation):** Apply different inheritance rules per kind.
> - `static` entries: scenario overrides only declared fields; inherits remaining fields from the default response.
> - `dynamic` / `passthrough` entries: scenario responses must be self-contained (status + headers + body all required). Zod validates completeness at config-load; a missing field on a non-static scenario is a boot-time error.
>
> **Cascade check:** What if the user's self-contained scenario body is an empty string on a JSON API? → U3 config-load validation is the last line of defence, but body content is intentional — if the user writes `"body": ""` that is their decision. No further cascade.

### TN2: Rule Count Ceiling vs Comprehensive Error Coverage

T4 caps scenario rules at 50 per mock entry to bound O(n) matching cost. B2 wants users to cover any error their provider can emit without creating new files. A provider with >50 distinct error codes on one endpoint forces a choice.

> **Resolution (Accept + document — P27 Cheap short-living):** Hold the 50-rule ceiling. Document the split-entry pattern: create two mock entries for the same path with different `priority` values, each carrying a subset of scenarios. The trie routes both entries; each entry's scenarios are evaluated in order. The pattern is tested in examples.
>
> **Propagation:** B2 is TIGHTENED — users with >50 cases per endpoint must restructure. Ceiling is `challenger: stakeholder` so may be raised to 100 if evidence warrants.

### TN3: ReDoS Guard vs Regex Predicate Expressiveness

S1 (INVARIANT) requires rejecting catastrophic-backtracking regex patterns at config-load. T6 (GOAL) includes regex as part of the predicate vocabulary. An overzealous guard breaks legitimate patterns; a permissive guard leaves the server vulnerable.

> **Resolution (Intermediary — P24 + Parameter changes — P35):** Adopt the `safe-regex` npm library as a calibrated intermediary. Its threshold accepts bounded quantifiers (`/^[A-Z]{2,4}$/` passes) while rejecting pathological nested patterns (`/^(a+)+$/` fails). When a pattern is rejected, the error message names it and suggests the equivalent safe predicate (exact/startsWith/contains).
>
> **Propagation:** T6 is TIGHTENED (unbounded quantifiers in complex patterns unavailable). S1 is LOOSENED (library-backed guard is auditable and testable with a known ReDoS corpus).
>
> **Cascade check:** What if `safe-regex` has a false positive on a user's legitimate pattern? → Error message suggests workarounds (exact/startsWith/contains cover most realistic scenario predicates). No further cascade — user can always fall back to an exact match.

### TN4: Kind-Agnostic Evaluation Depends on Pipeline Ordering

T7 (scenarios short-circuit all kinds) is only satisfiable if T1 (pipeline order: scenario eval before kind-dispatch) is implemented first. This is a hard sequencing dependency, not a trade-off.

> **Resolution (Prior action — P10):** T1 is the blocker. Implement the pipeline ordering stage before wiring kind-agnostic scenario evaluation. m4-generate must produce T1 artifacts before T7 artifacts. Dynamic handlers and upstream fetch are only reached when no scenario matched — the kind-dispatch branch is guarded by the scenario result.

### TN5: Predicate Evaluator Depends on Attribute Extractor

T6 (StringMatch predicates) cannot evaluate against request attributes without T3 (attribute surface extractor) providing a consistent extraction API over params, query, headers, and body dot-path.

> **Resolution (Prior action — P10):** T3 is the blocker. The attribute extractor must be built before the predicate evaluator. A missing attribute (e.g. `params.lastName` on a route with no `:lastName`) resolves to `undefined` and never matches — this is the defined semantics per U1 (no-match silent).

---

## Required Truths

### RT-1: Pipeline Insertion Point

The `routeToMock` function in `server.ts` has a clean gap between `hit = matchIndex.match(...)` and `switch (hit.entry.response.kind)` where scenario evaluation inserts. At that point `hit.params`, `req.query`, `req.headers`, and `body` are all already available — no additional extraction pass needed.

**Gap:** No scenario evaluation code exists at this insertion point; `hit.entry` has no `scenarios` field in the schema.

---

### RT-2: Request Attribute Extractor

A function that, given `{params, query, headers, body}` (the already-extracted request view in `routeToMock`) and a scenario predicate attribute reference, returns the corresponding value as a string or undefined. Body uses dot-path navigation. Headers are pre-lowercased.

**Gap:** No extractor function exists; the scenario predicate schema (and therefore its attribute reference type) doesn't exist yet (depends on RT-3).

---

### RT-3: Extended Zod Schema (Binding Constraint)

`src/core/config/schema.ts` gains:
1. `ScenarioPredicate` — `{params?, query?, headers?, body?}` each using the existing `StringMatch` type
2. `ScenarioResponse` — `Partial<{status, headers, body}>` with at least one field required
3. `Scenario` entry — `{id: string, when: ScenarioPredicate, response: ScenarioResponse}`
4. `MockEntry` gains `scenarios?: z.array(Scenario).max(50)`
5. `MockEntry.superRefine` — validates scenario response completeness for non-static entry kinds (TN1 resolution)
6. Regex predicates in `ScenarioPredicate` go through `safe-regex` (S1 / TN3 resolution)

**Gap:** None of these types exist. This is the binding constraint — all TypeScript types downstream (CompiledScenario, evaluator signatures, merger signatures) derive from this schema.

**Binding dependency chain:** RT-3 → RT-4 → RT-5

---

### RT-4: Compiled Scenario Type and Snapshot Compilation

`TenantSnapshot` in `snapshot.ts` gains `compiledScenarios: ReadonlyMap<string, CompiledScenario[]>` (keyed by mock entry ID). The snapshot builder compiles each `Scenario[]` into `CompiledScenario[]`, pre-processing predicates and instantiating regex objects. Compiled scenario responses go through the same Tier 2 compiler as static responses. Satisfies O2 (hot-reload atomicity) and O3 (regex GC'd with old snapshot).

**Gap:** `TenantSnapshot` has no compiled scenario data; snapshot builder doesn't process scenarios.

---

### RT-5: Scenario Predicate Evaluator

A pure function `evaluateScenarios(scenarios: CompiledScenario[], attrs: ScenarioAttrs): {match: CompiledScenario | null, missReason?: string}` applying first-match-wins. Reuses `stringMatchOk` from `src/core/matching/discriminators.ts`. When a predicate references an attribute that resolves to `undefined` (e.g. `params.lastName` on a route with no `:lastName` param), the miss is tracked and returned as `missReason` for the journal (O1).

**Gap:** No evaluator function exists; depends on RT-3 for types.

---

### RT-6: Response Merger

For **static** entries: `mergeStaticResponse(defaultResp, scenarioResp)` — declared scenario fields override, default fills the rest. Merged response goes through the Tier 2 walker exactly once (T1).

For **dynamic / passthrough** entries: scenario response is used as-is (validated complete at config-load by RT-3's superRefine). Tier 2 walker runs on it once.

**Gap:** No merger exists; depends on RT-3 for types, RT-4 for compiled scenario responses.

---

### RT-7: Journal Extended with Scenario Fields

`JournalEntry` in `src/core/journal/ring-buffer.ts` gains `scenarioId?: string` and `scenarioMissReason?: string`. The `routeToMock` → `dispatch` → `queueMicrotask` chain threads the scenario evaluation result through to the journal write.

**Gap:** `JournalEntry` type doesn't have these fields; `routeToMock` return type doesn't carry scenario metadata.

---

### RT-8: Admin Endpoint Exposes Scenario Metadata

`/__admin/tenants/:tenant/mocks` response includes for each entry: `scenarioCount: number` and `scenarioAttributes: string[]` (e.g. `["params.lastName", "query.status"]` — the attribute keys targeted by each rule, not values). Satisfies U4 (scenario order inspectable at runtime).

**Gap:** Current admin endpoint doesn't include scenario data.

---

## Solution Space

### Option A: Inline in `server.ts` and `schema.ts`
Add scenario logic directly into `routeToMock` and the existing schema file without a new module.
- Satisfies: RT-1, RT-3 (partly), RT-5 (inlined)
- Gaps: RT-4 (compilation buried in loader), RT-6 (merger inline, hard to test), all test coverage sparse
- Complexity: Low (small diff surface, but increases server.ts size and mixing concerns)
- Reversibility: TWO_WAY

### Option B: New `src/core/scenarios/` module ← Recommended
Create `src/core/scenarios/evaluator.ts` (RT-2, RT-5), `src/core/scenarios/merger.ts` (RT-6), `src/core/scenarios/index.ts`. Extend `schema.ts` (RT-3), `snapshot.ts` (RT-4), `ring-buffer.ts` (RT-7), `server.ts` with a single insertion block (RT-1), `admin/endpoints.ts` (RT-8).
- Satisfies: All RTs
- Gaps: None
- Complexity: Medium (6 touch-points, 3 new files)
- Reversibility: TWO_WAY
- Rationale: Mirrors existing module pattern (`src/core/matching/`, `src/core/journal/`). Testable in isolation. Clean separation between route selection (matching/) and response selection (scenarios/).

### Option C: Extend `src/core/matching/` module
Add `src/core/matching/scenarios.ts` alongside `discriminators.ts` to reuse StringMatch types directly.
- Satisfies: RT-1, RT-2, RT-3, RT-4, RT-5, RT-7, RT-8
- Gaps: Slight concern separation issue (matching = route selection; scenarios = response selection)
- Complexity: Low-medium
- Reversibility: TWO_WAY
