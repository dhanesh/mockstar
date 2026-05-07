# webhooks

## Outcome

Send outbound webhooks for configured requests using a lightweight queue (BullMQ or
something simpler — to be selected during constraint discovery). The webhook URL
must be configurable through all standard industry-supported channels: per-route
mock config, per-tenant config, environment variables, admin API at runtime, and
optionally HTTP request headers for ad-hoc test scenarios.

The feature must support the standard webhook delivery contract expected in fintech
and SaaS integrations: at-least-once delivery with retries and exponential backoff,
HMAC request signing for receiver verification, idempotency keys, configurable
timeouts, and a dead-letter path for permanent failures. Delivery must be observable
via the existing journal and Prometheus metrics, and surface in the admin API for
inspection and replay.

Lightweight is a hard constraint: this is a mock server, not a production message
broker. If BullMQ's Redis dependency is too heavy for the SDET-embed and
single-binary distribution use cases, a smaller in-process queue (or a tiered
approach — in-memory by default, BullMQ opt-in) is preferred.

---

## Constraints

### Business

#### B1: Single-binary distribution preserved

Webhook feature MUST NOT introduce a default-on external dependency (Redis, RabbitMQ, message broker). The single-binary `bun build --compile` artifact and Helm/Docker single-image distribution remain self-contained.

> **Rationale:** Mockstar's distribution model (CLI + ESM library + single binary + Helm) is a competitive feature versus WireMock/Mockoon. A Redis dep breaks the SDET embed (`launch({ mocksDir })` in a unit test must not require sidecar infra) and the single-binary deploy.

#### B2: All standard URL configuration channels covered

Webhook URL MUST be configurable through every channel the outcome enumerates: (a) per-route in mock config files, (b) per-tenant config defaults, (c) environment variables (`MOCKSTAR_WEBHOOK_URL_<name>` interpolation), (d) admin API runtime override, (e) optional inbound `X-Mockstar-Webhook-Url` header for ad-hoc test scenarios. Precedence MUST be deterministic and documented (header > admin > per-route > per-tenant > env).

> **Rationale:** Outcome explicitly enumerates these channels. Test parity with how production webhook receivers are configured (Stripe/GitHub/Slack patterns).

#### B3: Industry-standard delivery contract

Feature MUST implement the canonical outbound-webhook contract: at-least-once delivery, exponential backoff with jitter, HMAC-SHA256 signing available, stable delivery-id idempotency header, configurable per-attempt timeout, dead-letter path after retry exhaustion, and replay capability.

> **Rationale:** Mockstar's primary value proposition is "behaves like the real thing for tests." A non-standard webhook contract defeats the purpose.

#### B4: SDET embed remains zero-config

`launch({ mocksDir })` MUST continue to work without webhook-specific environment variables, Redis, or sidecar infra, even when mock configs declare webhooks. Webhooks are inert by default if no receiver is reachable; tests opt-in.

> **Rationale:** SDET embed (Jest/Vitest/`bun test`) is a primary persona per `CLAUDE.md`. Adding boot-time required env breaks the persona's flow.

#### B5: Webhook URL header channel is opt-in at server level

The `X-Mockstar-Webhook-Url` channel from B2 MUST be gated by a server-level CLI/config flag `--allow-webhook-url-header` defaulting to **off**. When off, the header is silently ignored; when on, per-route `acceptHeaderOverride: false` provides a second-tier opt-out. Header value still passes S2 (URL validation) and S4 (admin-path skip) per delivery attempt.

> **Rationale:** Introduced by TN5 resolution. Without the gate, B2's header channel is an SSRF foot-gun for any operator who didn't read the docs. Defaulting off + tiered opt-in matches Mockstar's other security defaults (admin auth, URL validator) in posture.

### Technical

#### T1: Queue is in-process only

Default and only-shipped queue is in-process (p-queue or hand-rolled `setTimeout` ladder). No BullMQ, no tiered/pluggable layer in v0.x. Queue state lives in the same process as the HTTP server.

> **Rationale:** User decision (m1 interview). BullMQ requires Redis, which conflicts with B1. A tiered approach doubles the code paths to test and support pre-1.0. Re-evaluate post-1.0 if SDET feedback demands durability.

#### T2: In-memory persistence with optional journal-file replay

Pending and in-flight webhook deliveries MUST live in memory only by default. An optional `--webhook-journal-file` flag (parallel to existing `--journal-file`) writes append-only delivery records for offline replay. No SQLite, no JSONL spool, no fsync hot-path.

> **Rationale:** User decision. Mockstar already enforces ephemeral state for the request journal — webhook persistence should follow the same pattern, not invent a new one.

#### T3: Default retry budget = 6 attempts / ~63s window

Default retry policy: 6 attempts, exponential backoff `[1s, 2s, 4s, 8s, 16s, 32s]` with ±20% jitter, total window ~63s. Per-webhook overrides via `retry: { attempts, backoff: 'exponential' | 'linear' | number[] }`.

> **Rationale:** User decision. Mock-server use cases mostly verify retry _behavior_ (curve shape, header presence, idempotency-id stability), not survive long outages. Override left open for users dogfooding production-shape retry curves.

#### T4: Delivery is post-response only (microtask-deferred)

Webhook scheduling MUST run as a microtask after the served response is flushed, exactly as the existing journal write does (`RT-6.3`). Served-request hot path latency MUST NOT include webhook URL resolution, signing, or HTTP setup.

> **Rationale:** Pre-mortem #2 — a regression where webhook work creeps into served-request latency would silently degrade the entire mocking story. The journal already proves the microtask pattern works.

#### T5: Trigger surface = mocks + passthrough, per-route

Webhook config attaches via a new `webhooks: WebhookSpec[]` field on `MockEntry`. Both static/dynamic mocks AND pass-through routes can fire webhooks. Webhooks are NOT a 4th `MockResponse.kind` — they are a side-effect attached to any matched route.

> **Rationale:** User decision. Outcome calls for "configured requests" generically — pass-through-driven webhook flows are valuable for receiver-side dogfooding. Per-route attachment matches the discriminated-union shape of `MockResponse` without polluting it.

#### T6: URL validation reuses `src/features/url-validator.ts`

Webhook URL validation MUST reuse the existing URL validator that today guards proxy upstreams. HTTPS-only by default; `http://` blocked unless `allowHttp: true` per webhook; private/loopback (RFC1918, 127/8, ::1, link-local) blocked unless `allowPrivateNetworks: true` per webhook.

> **Rationale:** Codebase already has hardened SSRF guards. Duplicating logic risks divergence. SDET workflows commonly target `localhost` receivers, so the opt-in flag must exist.

#### T7: Payload templating reuses existing `{{ }}` engine

Webhook URL and body templates MUST resolve through `src/core/templating/` with the same semantics as response bodies: `{{ request.body.x }}`, `{{ faker.uuid }}`, whole-string-placeholder type preservation. No separate template engine for webhooks.

> **Rationale:** User decision. Engine exists, is tested, and the type-preservation rule is non-trivial — re-implementing it would create subtle divergence.

#### T8: Per-attempt HTTP timeout configurable, default 5s

Each delivery attempt MUST be bounded by a per-attempt timeout (default 5000ms, override per-webhook via `timeoutMs`). Timeout firing classifies the attempt as transient-failure → retry.

> **Rationale:** Industry standard (Stripe 30s, GitHub 10s — 5s is conservative for a mock). Without a timeout, a hung receiver wedges the queue.

#### T9: Hot-reload preserves in-flight retry curves

Config snapshot swaps MUST NOT drop, duplicate, or re-curve in-flight deliveries. A delivery scheduled against snapshot N continues against snapshot N's webhook config until terminal state, even if snapshot N+1 changed or removed the webhook.

> **Rationale:** Mockstar's `SnapshotHolder` pattern already handles this for served requests (in-flight requests bind to the snapshot at match time). Webhooks must do the same or hot-reload becomes a footgun.

### User Experience

#### U1: Synchronous await endpoint for tests

Admin API MUST expose `POST /__admin/tenants/:tenant/webhooks/await?id=...&timeoutMs=...` that resolves when the named delivery reaches a terminal state (`success`, `dlq`, or `circuit-open`). Returns delivery summary on resolve, 408 on timeout.

> **Rationale:** User decision. Without this, SDETs poll the journal and write flaky timing-dependent tests. The admin endpoint matches the existing scenario-switching/journal API style.

#### U2: Optional response-body assertion per webhook

Webhook config MAY declare `expectResponse: { status?: number | number[]; body?: object | string }`. When set, only matching responses count as `success`; mismatches retry as transient failure. Absent → 2xx counts as success (default).

> **Rationale:** Pre-mortem #3 — receiver returning `200 OK` while silently dropping the payload is otherwise invisible. Optional, so the simple case stays simple.

#### U3: Admin responses redact signing secrets

Admin endpoints listing webhook config MUST return shape-only signing info (`signing: { enabled: boolean, algorithm: 'sha256' }`). The raw secret MUST NEVER appear in admin response bodies, journal entries, structured logs, or metric labels.

> **Rationale:** Pre-mortem #2. A leaked secret invalidates the entire authenticity guarantee. Codebase already redacts auth tokens in journal — same pattern.

#### U4: Delivery journal entries are first-class

The per-tenant request journal MUST gain webhook-delivery rows with: `webhookId`, `attempt`, `outcome` (`success` | `retry` | `dlq` | `circuit-open`), `httpStatus`, `durationUs`, `requestId` (linking the inbound request that triggered the webhook).

> **Rationale:** Codebase journal pattern is the existing observability surface. Webhook deliveries inherit it for free, enabling replay via the existing journal endpoint.

### Security

#### S1: HMAC-SHA256 signing is opt-in per webhook

Signing MUST be off by default and explicitly enabled per webhook via `signing: { secret: <env-ref>, algorithm: 'sha256', includeTimestamp: true }`. When enabled, emit `X-Mockstar-Signature: sha256=<hex>` and `X-Mockstar-Timestamp` headers; recipient is expected to verify within a 5-minute replay window.

> **Rationale:** User override of recommendation — explicit opt-in beats implicit-when-secret-set. Reduces "I forgot the secret was set and shipped signed-by-accident" surprises in shared configs.

#### S2: Outbound URL validation is mandatory

Every delivery attempt (including retries) MUST re-run URL validation. Validator rejects: non-`https://` (unless `allowHttp:true`), private/loopback addresses (unless `allowPrivateNetworks:true`), URLs with embedded credentials, malformed/unparseable URLs.

> **Rationale:** Re-validate every attempt because the URL may be templated from request data per attempt; a per-request injection vector cannot be one-shot validated at config-load.

#### S3: Secrets sourced from env or secret-store paths only

Signing secrets MUST be sourced via env-var reference (`{{ env.WEBHOOK_SECRET_X }}`) or file-path-with-perms-check, NEVER inline as a string in mock config files. Loader rejects inline secrets with a fail-fast error. Templating renders before logging — raw template tokens (not resolved values) appear in structured logs.

> **Rationale:** Inline secrets in mock config are a foot-gun (committed to git, mounted via ConfigMap into a pod where many people can read). Pre-mortem #2 partial — also covers the templating-leaks-into-logs failure mode.

#### S4: Internal admin paths never trigger webhooks

Webhooks MUST NEVER fire when the inbound request path matches the internal admin/health/metrics surface: `/_mockstar/*`, `/__admin/*`, `/health`, `/ready`, `/metrics`. Hard-coded skip-list, NOT user-configurable.

> **Rationale:** Pre-mortem #2. A too-broad `match.path` (e.g., `/`) accidentally hooking `/health` would explode delivery volume and could DDoS the configured receiver. Hard-coded because there is no legitimate use case for webhooks on internal paths.

### Operational

#### O1: Per-tenant queue depth cap with drop-oldest

Each tenant has an independent queue with a depth cap (default 1024 pending deliveries). Overflow drops the OLDEST entry (not the newest, so the most recent activity wins) and increments `webhook_queue_dropped_total{tenant=...}`. Cap configurable per-tenant.

> **Rationale:** Pre-mortem #1. Slow receivers are the most likely real-world failure; unbounded queue → OOM is the cheapest-to-prevent worst case. Drop-oldest matches Mockstar's "tests care about recent state" posture.

#### O2: Prometheus metrics for delivery and queue health

Emit: `webhook_delivery_total{tenant,webhook,outcome}`, `webhook_delivery_latency_us` histogram (re-using existing bucket layout), `webhook_queue_depth{tenant}` gauge, `webhook_queue_dropped_total{tenant}` counter, `webhook_circuit_state{tenant,webhook}` gauge (`0=closed,1=open,2=half-open`).

> **Rationale:** Codebase metrics pattern (`src/core/observability/metrics.ts`) — webhooks must be first-class observable, not a side-channel.

#### O3: Circuit breaker per webhook

Each webhook has an independent circuit breaker. After N consecutive failures (default 5), circuit opens for a cooldown window (default 30s); during cooldown, deliveries fast-fail to outcome `circuit-open` (no HTTP attempt). Half-open probe after cooldown. Per-webhook overrides via `circuit: { threshold, cooldownMs }`.

> **Rationale:** Pre-mortem #3 — slow/dead receiver poisons concurrency budget; every retry attempt eats the full timeout window. Circuit breaker bounds the damage.

#### O4: Admin API for inspection and replay

Admin API surfaces: `GET /__admin/tenants/:tenant/webhooks` (list active webhooks, redacted), `GET /__admin/tenants/:tenant/webhooks/journal` (delivery history), `POST /__admin/tenants/:tenant/webhooks/:deliveryId/replay` (one-shot redelivery, including from DLQ), `POST /__admin/tenants/:tenant/webhooks/await` (sync await — see U1).

> **Rationale:** Outcome explicitly requires "surface in the admin API for inspection and replay." Existing admin router/auth pattern is the obvious slot.

---

## Tensions

### TN1: Default retry curve vs canonical contract bound

**Between:** T3 (default 6 attempts / 63s window) ↔ B3 (industry-standard contract supports up to ~8 attempts / 72h)
**Type:** trade_off (Standardisation vs Flexibility)
**TRIZ:** Approximate match — P1 Segmentation, P15 Dynamization

Mock-server defaults are pitched at fast test feedback; canonical production curves can run for days. Both must be expressible.

> **Resolution:** T3 sets the *default* (6 attempts / 63s). B3 is refined to require that the per-webhook `retry: { attempts, backoff }` override accept values up to 8 attempts and arbitrary explicit backoff arrays — no upper-window cap enforced by Mockstar; users who want a 72h curve specify it. Default vs override is a documentation contract, not a code branch.
>
> **Validation criteria:**
> - Per-webhook `retry: { attempts: 8, backoff: [...] }` validates and executes
> - Default config produces exactly the 6-attempt / 63s curve
> - Documentation cross-references Stripe/GitHub/Slack/Svix curves as override examples

### TN2: Drop-oldest queue cap numerically violates at-least-once

**Between:** O1 (per-tenant queue depth cap with drop-oldest) ↔ B3 (at-least-once delivery)
**Type:** direct conflict (Speed vs Correctness, Cost vs Quality)
**TRIZ:** Exact match — P22 Blessing in disguise (drop becomes observable signal), P1 Segmentation, P11 Beforehand cushioning

A mock server has no external state; promising true at-least-once durability is dishonest. Drop-oldest under overflow is a correctness violation if read literally.

> **Resolution:** Refine B3's contract scope. B3 reads "at-least-once *within the bounds of O1 (queue capacity) and O3 (circuit-open fast-fail)*." Drop events are first-class observables — counter `webhook_queue_dropped_total{tenant}` increments, journal row written with `outcome: "dropped"`, admin journal endpoint surfaces them. Honest contract beats silent loss.
>
> **Validation criteria:**
> - Queue-overflow drop emits journal row with `outcome: "dropped"`
> - `webhook_queue_dropped_total` counter increments on drop
> - Circuit-open fast-fail emits journal row with `outcome: "circuit-open"`
> - Documentation explicitly states at-least-once is bounded by O1 and O3 (no "exactly the contract Stripe makes" claim)

### TN3: Sync await endpoint vs post-response microtask deferral (false conflict)

**Between:** U1 (sync `/webhooks/await` endpoint) ↔ T4 (delivery deferred to post-response microtask)
**Type:** trade_off (resolved by lifecycle separation)
**TRIZ:** Approximate match — P1 Segmentation (lifecycle split), P17 Another dimension

Reading the constraints naively, sync-await seems to contradict post-response deferral. It does not — they live on separate request lifecycles.

> **Resolution:** Document the lifecycle split explicitly. T4 governs the *triggering* request: response flushes, microtask schedules webhook work, request lifecycle ends. The U1 await endpoint is a *separate inbound request* that subscribes to the in-process delivery-state event bus and resolves when the named delivery reaches a terminal state. The two lifecycles never share a response object; T4 cannot be re-violated by U1.
>
> **Validation criteria:**
> - Trigger request response flush latency unchanged with vs without webhook configured (within p99 noise)
> - `/webhooks/await` blocks until terminal state, not until trigger response flush
> - Concurrent: trigger request returns 200 immediately while await endpoint still blocks

### TN4: HTTPS-only default vs SDET localhost workflows

**Between:** T6 (HTTPS-only via url-validator) ↔ B4 (zero-config SDET embed against `http://localhost:NNNN`)
**Type:** trade_off (Privacy vs Usability)
**TRIZ:** Exact match — P1 Segmentation (per-webhook flags), P10 Prior action (validator runs first)

SSRF protection wants strict HTTPS-only public addresses; SDET fixtures point at `http://localhost:9000`. Both legitimate.

> **Resolution:** Two **granular** per-webhook flags: `allowHttp: true` (relaxes HTTPS-only) and `allowPrivateNetworks: true` (relaxes RFC1918/loopback block). Each guards a distinct threat (cleartext exposure vs SSRF target). No single `developmentMode` umbrella — explicit opt-in to each protection knob is the safer default and reads self-documentingly in mock files.
>
> **Validation criteria:**
> - Default config rejects `http://example.com` (HTTPS-only)
> - Default config rejects `https://127.0.0.1:9000` (private-net block)
> - `{ allowHttp: true, allowPrivateNetworks: true }` accepts `http://localhost:9000`
> - `{ allowHttp: true }` alone still rejects `http://10.0.0.1` (private-net still blocked)

### TN5: Header URL channel vs SSRF/admin-path safety

**Between:** B2 (`X-Mockstar-Webhook-Url` header is a configuration channel) ↔ S2 (URL validation) + S4 (admin-path skip)
**Type:** trade_off (Privacy vs Usability, Autonomy vs Control)
**TRIZ:** Exact match — P1 Segmentation (server flag + per-route flag), P22 Blessing in disguise (dynamic test scenarios), P10 Prior action, P24 Intermediary

Per-request user-supplied URLs are a textbook SSRF vector; without gating, any inbound request can redirect webhook delivery anywhere.

> **Resolution:** Tiered opt-in. (1) Server-level CLI flag `--allow-webhook-url-header` defaults OFF — when off, `X-Mockstar-Webhook-Url` is silently ignored. (2) When on, per-route `acceptHeaderOverride: false` lets shared mock files protect specific routes. (3) Header value still passes S2 (URL validator with `allowHttp` / `allowPrivateNetworks` rules per-webhook) and S4 (admin-path skip-list). (4) Header value logged as raw template token, not as resolved URL, in structured logs. New constraint introduced: see B5 below.
>
> **Validation criteria:**
> - With `--allow-webhook-url-header` off: header is ignored, configured URL used
> - With flag on + route `acceptHeaderOverride: false`: header is ignored
> - With flag on + route accepts: header URL still validated by S2; rejected URLs surface clear error
> - Header URL targeting `/_mockstar/*` rejected by S4 skip-list
> - Structured logs show raw `${header.X-Mockstar-Webhook-Url}` template token, not the resolved value

### TN6: In-flight retry preservation vs in-memory persistence

**Between:** T9 (snapshot swap preserves in-flight retry curves) ↔ T2 (in-memory only)
**Type:** hidden_dependency
**TRIZ:** No strong TRIZ mapping — resolve via direct analysis (consistency note)

T9 reads as "in-flight retries always continue against scheduling snapshot." T2 caps that promise to process lifetime: process restart loses pending retries.

> **Resolution:** T9 preservation is **process-lifetime only** — explicitly. Snapshot swaps within the same process preserve in-flight retry curves; process restart does not. Acceptable per B1 (no external broker) and T2 (in-memory). Restart contract documented in operator-facing docs.
>
> **Validation criteria:**
> - Snapshot swap mid-curve: in-flight retries observably continue against the original snapshot's webhook config
> - Process restart with a non-empty queue: in-flight retries do NOT resume on next boot
> - Optional `--webhook-journal-file` flag enables post-restart replay via O4 admin endpoint, not automatic resume

### TN7: Admin replay scope vs ring-buffer eviction

**Between:** O4 (admin replay endpoint) ↔ T2 (in-memory journal ring buffer)
**Type:** hidden_dependency
**TRIZ:** No strong TRIZ mapping — resolve via direct analysis

Replay can only target deliveries still resident in the per-tenant ring buffer. Once evicted (by capacity rollover or process restart), replay has no payload to redeliver.

> **Resolution:** Replay endpoint returns `404 { code: "delivery_not_in_journal" }` for missing entries with documentation cross-link to `--webhook-journal-file`. No new constraint required — surfaces the natural bound.
>
> **Validation criteria:**
> - Replay of an evicted deliveryId returns 404 with code `delivery_not_in_journal`
> - Replay of a resident deliveryId enqueues a fresh delivery attempt and returns 202
> - With `--webhook-journal-file` enabled, replay of restart-evicted entries succeeds via file-backed lookup

---

## New Constraints Introduced by Tension Resolution

- **B5** — see `### Business / #### B5` above. Introduced by TN5.

---

## Required Truths

### RT-1: In-process queue primitive with depth cap and concurrency control

A queue primitive exists (or is buildable) supporting: per-tenant isolation, exponential backoff retries with jitter, configurable concurrency cap, and **drop-oldest depth-cap eviction**. Selected stack: `p-queue` (concurrency control) + `p-retry` (retry curve) — wrapped with ~50 LOC depth-cap wrapper since p-queue's native queue is unbounded.

**Maps to:** B1, T1, B4, O1
**Status:** NOT_SATISFIED
**Gap:** No queue exists in the codebase. Must add `p-queue` + `p-retry` to dependencies (4 → 6 runtime deps), then build a thin `BoundedRetryQueue` wrapper enforcing O1's drop-oldest semantics on top of p-queue's unbounded backing array. Wrapper resolves evicted entries' Promises with `outcome: "dropped"` (does not reject) to preserve U1's terminal-state contract.

### RT-2: Bun's `node:crypto` provides timing-safe HMAC-SHA256

`createHmac` and `timingSafeEqual` from `node:crypto` work in Bun and produce identical output to Node. Replay-window verification is a stateless timestamp delta — no nonce store required.

**Maps to:** S1, S3
**Status:** SATISFIED
**Evidence:** `src/features/admin/auth.ts:5` already imports `timingSafeEqual` from `node:crypto`; `src/features/proxy/install-journal.ts:11` uses `createHash` from same. `createHmac` follows the same shim contract.

### RT-3: `queueMicrotask` defers post-response work without affecting flush

Post-response work scheduling via `queueMicrotask(...)` is the proven Mockstar pattern (`RT-6.3` lineage). Trigger request flushes; microtask runs immediately after; webhook scheduling happens in the microtask. Served-request latency is unaffected.

**Maps to:** T4
**Status:** SATISFIED
**Evidence:** `src/server.ts:157-158` and `src/features/proxy/server.ts:138`. Both with the comment "Defer observability writes to after the response goes out (RT-6.3)."

### RT-4: Per-webhook circuit breaker state machine

Independent state machine per webhook with three states (closed → open → half-open), failure-count threshold, cooldown timer, half-open probe. ~80 LOC of pure state-transition code, no dependency.

**Maps to:** O3
**Status:** SPECIFICATION_READY
**Gap:** Spec is well-known (Hystrix, Polly, p-circuit-breaker patterns); pick a simple implementation when m4 generates.

### RT-5: `validateUpstreamUrl()` is reusable for outbound webhook URLs

The existing URL validator at `src/features/url-validator.ts:35` already accepts the two flags TN4 needs: `allowedSchemes` (for `allowHttp` mapping) and `allowPrivateUpstreams` (for `allowPrivateNetworks` mapping). IPv4-mapped-IPv6 + CGNAT + link-local checks all in-place. Drop-in reuse, no refactor.

**Maps to:** T6, S2
**Status:** SATISFIED
**Evidence:** `src/features/url-validator.ts:5-10, 35-62, 64-100`.

### RT-6: `SnapshotHolder.get()` returns ref-stable snapshot

Closures capturing a snapshot reference at delivery-schedule time continue to read the same snapshot's webhook config across subsequent swaps. In-flight retry curves preserve their original config.

**Maps to:** T9, TN6
**Status:** PARTIAL
**Gap:** Need to read `src/core/config/snapshot.ts` to confirm the holder's reference semantics under swap. Per existing journal+metrics+logger pattern (all post-response writes hold their own refs), this is highly likely true — but unverified for webhook delivery's longer-lived closures (up to 63s by default, longer with override).

### RT-7: Industry-standard webhook contract is publicly documented

Stripe (`https://stripe.com/docs/webhooks`), GitHub (`https://docs.github.com/webhooks`), Slack (`https://api.slack.com/messaging/webhooks`), and Svix (`https://docs.svix.com/`) all document their HMAC signing, idempotency-id, retry curve, and replay-window practices publicly. The contract is replicable.

**Maps to:** B3, S1, S4
**Status:** SATISFIED
**Evidence:** Public documentation, all four sources cross-referenced in m1 domain context.

### RT-8: `MockEntry` Zod schema accepts a `webhooks?: WebhookSpec[]` extension

The discriminated-union pattern at `src/core/config/schema.ts` admits a sibling field on `MockEntry` (alongside `match`, `response`, `scenarios`) that holds an array of webhook specs. `WebhookSpec` is a new Zod object covering: URL (templatable), method, payload (templatable), retry override, signing config (with secret-source guard), expectResponse, allowHttp, allowPrivateNetworks, acceptHeaderOverride, circuit overrides.

**Maps to:** T5, S3, B2, B5
**Status:** NOT_SATISFIED
**Gap:** Schema extension is purely additive (no breaking change for existing mocks). Strict-mode rejection of inline `signing.secret` strings (S3) requires a Zod `.refine()` distinguishing `{{ env.X }}` template tokens from raw strings.

### RT-9: Templating engine supports `{{ env.X }}` namespace

The templating engine resolves `env.X` template tokens to `process.env.X` at render time (so env reads happen per delivery, not at config-load — supports hot-reload of env-supplied secrets across re-execs).

**Maps to:** B2, S3
**Status:** NOT_SATISFIED
**Gap:** `src/core/templating/` has `request.*`, `faker.*`, `tier2/id` namespaces but no `env.*`. Add a thin `env.X` resolver that reads `process.env` at render time. ~30 LOC.

### RT-10: CLI `parseArgs` extends with new flags

`src/cli.ts:39-80` already uses a clean `parseArgs(argv)` switch with `getFlag(rest, '--name')` extraction. Adding `--allow-webhook-url-header` (boolean) and `--webhook-journal-file <path>` follows the existing `--allow-private` / `--watch` precedent exactly.

**Maps to:** B5, T2
**Status:** SPECIFICATION_READY
**Gap:** Mechanical extension to `ParsedArgs` interface and `parseArgs()`.

### RT-11: Per-tenant journal accommodates webhook delivery rows

The current `JournalEntry` is request-shaped (`method`, `path`, `status`, `matchedMockId`, …). Webhook delivery rows have a different shape (`webhookId`, `attempt`, `outcome`, `httpStatus`, `requestId`-link, `durationUs`). Resolution: discriminator field `kind: "request" | "webhook"` on `JournalEntry` OR a sibling `WebhookJournal` ring buffer per tenant.

**Maps to:** U4, O4
**Status:** NOT_SATISFIED
**Gap:** Two viable shapes — m4 to pick. Sibling ring buffer is simpler (no JSON discriminator complexity in admin responses); discriminator is more parsimonious. Mild preference for sibling ring buffer to keep `RingBuffer<JournalEntry>` type clean.

### RT-12: `Metrics` module supports gauges

Add `setGauge(name, labels, value)` and update `format()` output to emit `# TYPE <name> gauge` lines. Existing counter + histogram emission patterns extend cleanly.

**Maps to:** O2
**Status:** PARTIAL
**Gap:** Counters and histograms exist (`src/core/observability/metrics.ts:14-54`); gauges TBD. Single new method + a `Map<string, number>` for gauge values. ~30 LOC.

### RT-13: Admin router hosts `/webhooks/*` endpoints

`src/features/admin/endpoints.ts` already mounts per-tenant routes under `adminAuthMiddleware({scope:'tenant'})`. New endpoints — list, journal, replay, await — slot in as siblings to the existing `/mocks` and `/journal` paths.

**Maps to:** O4, U1, U3
**Status:** SPECIFICATION_READY
**Gap:** Mechanical addition; secret-redaction logic for the list endpoint (U3) is the only non-trivial bit (~10 LOC).

### RT-14: In-process delivery-state event registry

A `Map<deliveryId, { resolve, reject, timeout }>` registry per tenant lets the await endpoint subscribe to a deliveryId and receive the terminal outcome. Queue worker resolves the deferred on success/dlq/circuit-open/dropped.

**Maps to:** U1
**Status:** NOT_SATISFIED
**Gap:** No event-bus / EventEmitter precedent in the codebase. This is a green-field primitive — but it's small (~60 LOC: registry + cleanup-on-resolve + timeout sweep). Promise-registry pattern beats EventEmitter for our case (single subscriber per deliveryId, terminal-once semantics).

### RT-15: `JournalEntry.requestId` exists and is stable

`JournalEntry.requestId` is already a field at `src/core/journal/ring-buffer.ts:9`. Webhook delivery rows reference it for inbound-request → outbound-delivery linkage in admin queries.

**Maps to:** U4
**Status:** SATISFIED
**Evidence:** `src/core/journal/ring-buffer.ts:9` (`requestId: string` on the JournalEntry interface).

### RT-16: Bun `fetch` supports per-request timeout via `AbortSignal`

Bun implements `fetch` with the standard `AbortSignal.timeout(ms)` option. Per-attempt T8 timeout is a one-liner: `fetch(url, { signal: AbortSignal.timeout(timeoutMs), ... })`.

**Maps to:** T8
**Status:** NOT_SATISFIED
**Gap:** Verification needed — confirm Bun's `fetch` honors `AbortSignal.timeout` cleanly under concurrent load (no leaked sockets / hung handles). Bun 1.1.8+ does support it per docs; m5 verifies in practice.

---

## Binding Constraint

**RT-1 — In-process queue primitive with depth cap and concurrency control**

> **Why binding:** Without RT-1, four other RTs have nothing to attach to: RT-4 (circuit breaker wraps queue-emitted attempts), RT-14 (event registry fires from queue's terminal-state hook), RT-6 (snapshot binding lives in queue closures), RT-11 (journal rows are written by the queue worker). RT-1's design choice — in particular, how the depth-cap wrapper resolves dropped entries' Promises — propagates directly into RT-14's terminal-state contract.
>
> **Dependency chain:** RT-1 → RT-4, RT-14, RT-6, RT-11
>
> **m4 priority:** generate RT-1's `BoundedRetryQueue` wrapper FIRST when context is freshest, then layer RT-4 / RT-14 / RT-11 on top of its event surface.

---

## Solution Space

### Option A: Hand-rolled in-process stack (TWO_WAY)

Components: `setTimeout`-ladder queue + per-tenant concurrency cap, Zod schema extension, `queueMicrotask` delivery, `RingBuffer` for delivery journal, `setGauge` added to `Metrics`, drop-in `validateUpstreamUrl` for URL validation, hand-rolled HMAC signing, hand-rolled circuit breaker, Promise-registry event bus, CLI flag extension.

- **Satisfies:** all 16 RTs (with implementation work)
- **Reversibility:** TWO_WAY — every component is internal, no public API commitments
- **Cost:** ~1500–2000 LOC across 8–10 files; zero new dependencies
- **Pros:** matches Mockstar's hand-rolled-lean codebase pattern (RingBuffer/Snapshot/Metrics/scenarios are all in-house)
- **Cons:** more state-machine code to write and maintain

### Option B: BullMQ + Redis-optional (ONE_WAY ⚠ — REJECTED in m1)

- **Satisfies:** N/A — violates B1 (no external broker dep), T1 (in-process only), T2 (in-memory only)
- **Listed for traceability only.**

### Option C: External adapter pattern (REVERSIBLE_WITH_COST)

A + a public `WebhookQueue` interface and plugin-API documentation so users can swap in BullMQ, NATS, RabbitMQ, etc.

- **Satisfies:** 16/16 + extension hook
- **Reversibility:** REVERSIBLE_WITH_COST — once shipped, the interface is a public contract; future changes break plugins
- **Cost:** Option A + ~500 LOC + permanent surface area
- **Pros:** opens door to durability options pre-1.0
- **Cons:** premature for v0.x; locks contract before real plugin demand surfaces

### Option D: NPM `p-queue` + `p-retry` stack (TWO_WAY) — **SELECTED**

Components: `p-queue` for per-tenant concurrency cap (1 instance per tenant), `p-retry` for retry curve with custom backoff array + jitter, **a thin `BoundedRetryQueue` wrapper** (~50 LOC) enforcing O1's drop-oldest semantics on top of p-queue's unbounded backing array, hand-rolled HMAC signing, hand-rolled circuit breaker (wraps p-retry's `onFailedAttempt` hook), Promise-registry event bus, gauges added to `Metrics`, drop-in `validateUpstreamUrl`, Zod schema extension, CLI flag extension.

- **Satisfies:** all 16 RTs (with implementation work)
- **Reversibility:** TWO_WAY — npm deps swappable in a refactor; queue is wrapped behind `BoundedRetryQueue` so swap costs are bounded
- **Cost:** ~1100–1500 LOC across 8–10 files; **+2 runtime dependencies** (`p-queue`, `p-retry`); package.json runtime deps go from 4 to 6
- **Pros:** saves ~30% of queue/retry state-machine code; both libraries are battle-tested (Sindre Sorhus, ESM-native, Bun-compatible); p-retry's `randomize: 0.2` matches T3's ±20% jitter directly
- **Cons:** breaks Mockstar's hand-rolled-lean dependency posture (Hono + Zod + Faker + jsonpath-plus is the current baseline); takes on indirect dep tree from p-queue/p-retry; depth-cap wrapper compensates for p-queue's unbounded native queue

> **Selection rationale:** User-selected over the hand-rolled recommendation. The wrapper-on-p-queue approach is honest about what each piece does (p-queue handles concurrency, p-retry handles backoff curves, custom code handles depth cap + HMAC + circuit + event bus). The TWO_WAY tag holds because `BoundedRetryQueue` is the only module that talks to p-queue/p-retry — replacing them later means rewriting one module.

---

## Tension Validation under Selected Option D

| Tension | Recorded Resolution | Honoured by Option D? |
|---|---|---|
| TN1 (default vs canonical curve) | per-webhook `retry: {attempts, backoff}` override | CONFIRMED — `p-retry` accepts custom backoff arrays |
| TN2 (drop-oldest vs at-least-once) | refine B3 + observable drops | CONFIRMED — **with caveat**: p-queue's queue is unbounded; the `BoundedRetryQueue` wrapper enforces O1's drop-oldest and emits the journal+counter events |
| TN3 (sync await vs microtask) | lifecycle split | CONFIRMED — Promise registry layered on p-queue's `completed`/`error`/`idle` events |
| TN4 (HTTPS default vs SDET) | granular `allowHttp` + `allowPrivateNetworks` flags | CONFIRMED — independent of queue choice; `validateUpstreamUrl` already accepts both knobs |
| TN5 (header URL channel) | server CLI flag + per-route opt-out | CONFIRMED — extends `parseArgs` + adds `acceptHeaderOverride` to MockEntry |
| TN6 (process-lifetime preservation) | snapshot capture in closures, restart loses queue | CONFIRMED — p-queue tasks are JS closures, capture snapshot ref same way |
| TN7 (replay scope = ring-buffer) | 404 `delivery_not_in_journal` for evicted | CONFIRMED — replay path is independent of queue choice |

**All 7 tensions: CONFIRMED. None reopened.**
