// Satisfies: T5 (per-route trigger surface), T7 (templating reuse), B3 (industry contract)
// Satisfies: U2 (response-body assertion), U4 (delivery journal entry shape)
// Satisfies: S1 (signing opt-in), B5 (header channel opt-out per-route), B2 (URL channels)

import type { CompiledTemplate } from "../../core/templating/index.ts";
import type { DigestEncoding } from "./scheme.ts";

/** Terminal outcome of a delivery — every delivery resolves to exactly one of these. */
export type DeliveryOutcome =
  | "success" // attempt returned matching status (and matching body if expectResponse set)
  | "failed" // retry budget exhausted, last attempt non-2xx or threw
  | "dropped" // queue cap overflow evicted before delivery (TN2)
  | "circuit-open"; // breaker open at attempt time, no HTTP call made (O3)

/** Signing config for a single webhook. Off unless explicitly enabled (S1). */
export interface WebhookSigningSpec {
  /** Signature mechanism. Only `hmac` in v0.x; the union exists so ed25519/oidc can follow (#30). */
  mode: "hmac";
  enabled: boolean;
  /** Algorithm — only sha256 supported in v0.x. */
  algorithm: "sha256";
  /** Secret reference: must be `{{ env.NAME }}` form OR a file:// path. Inline strings rejected at config load (S3). */
  secretRef: string;
  /** Template for the bytes fed to HMAC. Default `{timestamp}.{body}`. */
  signedPayload: string;
  /** Template for the signature header VALUE. Default `{algorithm}={signature}`. */
  signatureTemplate: string;
  /** Digest encoding. Default `hex`; `base64` for Shopify-style receivers. */
  digestEncoding: DigestEncoding;
  /** Header carrying the rendered signature. Default: x-mockstar-signature. */
  signatureHeader: string;
  /** Header carrying the timestamp, in the unit the scheme signs. Omitted when the scheme has no timestamp. */
  timestampHeader: string;
  /** Replay window in ms. Default: 300_000 (5 minutes). Receiver should check timestamp delta. */
  replayWindowMs: number;
}

/** Retry config — explicit backoff array preferred (T3 default: [1000,2000,4000,8000,16000,32000]). */
export interface WebhookRetrySpec {
  attempts: number; // total attempts including the first try (T3 default: 6)
  backoff: readonly number[]; // length must equal (attempts - 1)
  jitterRatio: number; // ±ratio (T3 default: 0.20)
}

/** Circuit-breaker tunables per webhook (O3). */
export interface WebhookCircuitSpec {
  failureThreshold: number; // consecutive failures before opening; default 5
  cooldownMs: number; // duration in OPEN state; default 30_000
}

/** Optional response assertion — only matching responses count as success (U2). */
export interface WebhookExpectSpec {
  status?: number | readonly number[];
  body?: unknown; // exact-match or partial object
}

/**
 * Compiled webhook spec — all template strings pre-compiled at config-load time
 * (mirroring the response compilation pattern; on the hot path we only render).
 *
 * Satisfies: T5 (per-route shape), T7 (template reuse via CompiledTemplate), S3 (secret-ref is a template),
 *            U2 (expectResponse), B5 (acceptHeaderOverride flag landed here)
 */
export interface CompiledWebhookSpec {
  id: string;
  /** Compiled URL template — re-rendered each attempt (per-attempt URL re-validation, S2). */
  urlTemplate: CompiledTemplate;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Compiled body template OR a JSON tree with leaf templates (T7). null = no body (GET/HEAD). */
  body: CompiledTemplate | null;
  /** Compiled header values; keys are lowercased. */
  headers: ReadonlyMap<string, CompiledTemplate>;
  retry: WebhookRetrySpec;
  signing: WebhookSigningSpec | null; // null = no signing (S1 opt-in)
  circuit: WebhookCircuitSpec;
  expectResponse: WebhookExpectSpec | null;
  timeoutMs: number; // T8 per-attempt timeout
  allowHttp: boolean; // TN4 — relaxes HTTPS-only
  allowPrivateNetworks: boolean; // TN4 — relaxes private/loopback block
  acceptHeaderOverride: boolean; // TN5 — per-route opt-out for header URL channel
}

/**
 * Single attempt record stored in the per-tenant webhook journal (RT-11).
 * Mirrors the request-journal shape but discriminated as kind: 'webhook'.
 */
export interface WebhookJournalEntry {
  kind: "webhook";
  timestamp: number;
  tenant: string;
  /** Stable per-delivery id; same value across all retry attempts of one delivery (B3 idempotency). */
  deliveryId: string;
  /** Mock-entry id (NOT the WebhookSpec.id) — used by replay to relocate the spec in the current snapshot. */
  entryId: string;
  /** WebhookSpec.id within the mock entry's webhooks[] array. */
  webhookId: string;
  /** Inbound request id that triggered the delivery (U4 linkage; RT-15). */
  triggerRequestId: string;
  /** 1-indexed attempt counter; final entry has attempt === total. */
  attempt: number;
  outcome: DeliveryOutcome;
  /** HTTP status from the receiver — undefined for outcomes 'dropped' / 'circuit-open' / network errors. */
  httpStatus?: number;
  durationUs: number;
  /** Resolved URL for this attempt (templates rendered). Surface for debug/replay. */
  resolvedUrl?: string;
  /** Short error description for failed attempts; never includes secret material. */
  error?: string;
  /** True when this entry was emitted by an admin /replay trigger rather than an inbound match. */
  replay?: boolean;
}

/** Summary delivered to the await endpoint and event-registry subscribers (U1). */
export interface DeliverySummary {
  deliveryId: string;
  outcome: DeliveryOutcome;
  totalAttempts: number;
  lastHttpStatus?: number;
  totalDurationUs: number;
}
