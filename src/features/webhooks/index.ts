// Public surface of the webhooks feature module.
// Exports the types library embedders need to construct webhook specs and
// hook into the await/journal endpoints; queue/dispatcher internals stay private.

export type {
  CompiledWebhookSpec,
  WebhookSigningSpec,
  WebhookRetrySpec,
  WebhookCircuitSpec,
  WebhookExpectSpec,
  WebhookJournalEntry,
  DeliveryOutcome,
  DeliverySummary,
} from "./types.ts";

export { BoundedRetryQueue } from "./queue.ts";
export type { QueuedDelivery, BoundedRetryQueueOptions, AttemptRecord } from "./queue.ts";

export { CircuitBreaker } from "./circuit-breaker.ts";
export type { CircuitBreakerOptions, CircuitState } from "./circuit-breaker.ts";

export { DeliveryEventRegistry } from "./event-registry.ts";
export type { DeliveryEventRegistryOptions } from "./event-registry.ts";

export { WebhookJournalRegistry } from "./journal.ts";
export type { WebhookJournalOptions } from "./journal.ts";

export { dispatchWebhooks } from "./dispatcher.ts";
export type { DispatcherDeps, DispatcherTriggerInput } from "./dispatcher.ts";

export { signPayload, verifySignature, withinReplayWindow, resolveSecret } from "./signing.ts";
