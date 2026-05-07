# Webhook design decisions

Companion to `.manifold/webhooks.json`. Each section names the constraint(s) it traces to.

## Architecture: in-process queue, no Redis (B1, T1, T2)

Mockstar ships as a single binary, an ESM library for SDET embed, and a Helm/Docker image. None of those distribution channels can take a hard Redis dependency without breaking the contract. Per-route webhook delivery therefore lives entirely in-process, in a per-tenant `BoundedRetryQueue` with `setTimeout`-driven backoff and `crypto.subtle`-backed signing.

This makes Mockstar's webhook delivery contract **bounded at-least-once**: at-least-once *within queue capacity (O1) and circuit state (O3) bounds*. The queue cap defaults to 1024 entries per tenant; overflow drops the oldest waiting entry with `outcome: "dropped"`. See TN2 below.

## Option D: p-queue + (no) p-retry (RT-1, user choice)

m3-anchor recommended Option A (fully hand-rolled). The user selected Option D — p-queue + p-retry — to lean on battle-tested concurrency primitives.

During implementation we **dropped p-retry**. p-retry's API only supports exponential backoff via `factor`, `minTimeout`, `maxTimeout`, `randomize` — it does not accept an explicit backoff array. T3's contract specifies `[1s, 2s, 4s, 8s, 16s]` per webhook. Wrapping p-retry's `onFailedAttempt` hook to inject custom delays produced more code than a 25-LOC retry loop in `BoundedRetryQueue.#runWithRetry`. We kept p-queue (real value: concurrency cap + backpressure) and hand-rolled the retry loop. Net: **package.json runtime deps go from 4 to 5, not 6**.

## TN2: at-least-once vs drop-oldest queue cap

A naive read of B3 ("at-least-once delivery") contradicts O1 ("drop-oldest under cap"). We refined B3's scope: at-least-once **bounded by queue capacity and circuit state**. Drops are first-class observable signals — counter `mockstar_webhook_queue_dropped_total{tenant}`, journal row `outcome: "dropped"`, admin journal endpoint surfaces them. Honest contract beats silent loss.

A mock server cannot make a true production-broker durability promise without external state. Pretending it can is the worse failure mode (silent drops); pretending it can't is just accurate.

## TN3: sync await on a separate request lifecycle

The await endpoint (`GET /__admin/tenants/:tenant/webhooks/await?id=...`) appears to contradict T4 (post-response microtask deferral) — surely "wait synchronously" blocks something? It blocks the *await endpoint's own request lifecycle*, not the trigger request. The trigger request flushes its response, schedules the webhook in a microtask, and ends — exactly per T4. The await endpoint is a separate HTTP request that subscribes to the in-process `DeliveryEventRegistry` and resolves when the named delivery reaches a terminal state. The two lifecycles never share a response object.

This is also what makes test ergonomics good: the SDET pattern is `trigger; const summary = await fetch('/await?id=X')`, not "poll the journal in a loop."

## TN4: granular HTTPS / private-network flags

`allowHttp` and `allowPrivateNetworks` are independent per-webhook fields, not a single `developmentMode` umbrella. They guard distinct threats (cleartext exposure vs SSRF target) and forcing two explicit opt-ins in shared mock files reduces the "just turn dev mode on" creep into production-like configs.

The existing `validateUpstreamUrl` (used by the proxy upstream guard) already accepts `allowedSchemes` and `allowPrivateUpstreams` — drop-in reuse, no refactor.

## TN5: server CLI flag for the header URL channel

The `X-Mockstar-Webhook-Url` request header is a real test affordance (parameterised SDET runs) but a textbook SSRF vector. We tier-gate it:

1. Server-level CLI flag `--allow-webhook-url-header` defaults **off**. Without it, the header is silently ignored.
2. Per-route `acceptHeaderOverride: false` lets shared mock files protect specific routes.
3. The header value still passes `validateUpstreamUrl` (with the per-webhook `allowHttp` / `allowPrivateNetworks` flags) and the S4 admin-path skip-list.
4. Structured logs show the raw template token (when applicable), not the resolved URL — to keep request-supplied target URLs out of logs even after delivery succeeds.

This added one new constraint, **B5** (the server flag itself), in m2.

## TN6: process-lifetime preservation

T9 says "snapshot swap mid-curve preserves in-flight retry curves." T2 says "in-memory only." Together: *in-flight retries continue against scheduling snapshot **for the lifetime of the process**.* Process restart loses pending retries. This is the explicit restart contract; documented in the README's "Limits and caveats" section.

`SnapshotHolder.get()` returns a stable reference (verified by `src/core/config/snapshot.ts:32-49`). Closures capturing it survive subsequent swaps. The optional `--webhook-journal-file` flag adds post-restart replay via O4's admin endpoint, **not** automatic resume.

## TN7: replay scope = ring-buffer-resident

The replay endpoint reads from the per-tenant webhook journal (a `RingBuffer<WebhookJournalEntry>`). Once an entry is evicted by ring rollover, replay returns 404 with code `delivery_not_in_journal`. Cross-link: enable `--webhook-journal-file` to extend replay scope across restarts.

## T3 default backoff: 5 intervals, not 6

m1's T3 wrote `[1s, 2s, 4s, 8s, 16s, 32s]` (6 intervals) for "6 attempts / ~63s window." Six attempts have **five** retry intervals between them, not six — the manifold's interval count was off-by-one. We corrected the schema default to `[1s, 2s, 4s, 8s, 16s]` (5 intervals, ~31s window). The corresponding manifold update lives in iteration 4's notes.

## What this decision closes

- Pre-1.0 we are NOT shipping a `WebhookQueue` plugin interface (Option C). Anyone who needs durable queuing will have to fork or wait for a v0.2 RFC.
- Pre-1.0 we are NOT supporting type-preserving JSON-body templating for webhook payloads (whole-string templates only — bodies are rendered as strings). `{{ request.body.amount }}` in a webhook body becomes `"42"`, not `42`. Listed for v0.2.
- Auto-resume of in-flight retries across process restart is **closed for v0.x**. `--webhook-journal-file` + admin replay is the supported pattern.

## Reversibility log

| Action | Reversibility | Cost |
|---|---|---|
| Add `p-queue` to runtime deps | REVERSIBLE_WITH_COST | Rewriting BoundedRetryQueue against a different primitive (~150 LOC) |
| Introduce `DeliveryEventRegistry` (first event-bus primitive) | REVERSIBLE_WITH_COST | Rewriting the await endpoint against polling (~60 LOC + perf cost) |
| Schema additive `webhooks?: WebhookSpec[]` | TWO_WAY | Field is optional; removing it is a backward-compatible delete |
| New CLI flags | TWO_WAY | Removable when feature is gated off |
| Server post-response microtask hook | TWO_WAY | Single conditional; remove the `if (webhookTrigger)` block |
