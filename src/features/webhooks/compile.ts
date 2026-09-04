// Satisfies: T7 (templating reuse), RT-8 (Zod -> compiled-spec transform)
// Pre-compiles every templated string in a webhook spec at config-load so the
// hot path only renders ops, never parses tokens.

import type { Entry, WebhookSpecT } from "../../core/config/schema.ts";
import { type CompiledTemplate, compileTemplate } from "../../core/templating/compiler.ts";
import type { CompiledWebhookSpec } from "./types.ts";

/**
 * Compile webhook specs for every entry that declares them. Returns a map keyed
 * by entry id so the dispatcher can look up the matched mock's webhooks in O(1).
 *
 * Body templating handles two shapes:
 *   - string body: compiled directly (whole-string rendering)
 *   - object/array body: serialised once at compile time with placeholder tokens
 *     intact, then compileTemplate'd as a string. This is sufficient for v0.x;
 *     it loses type-preservation for JSON bodies (numbers in templates render
 *     as strings) but matches T7's stated reuse of the existing engine.
 *     Type-preserving JSON bodies (renderCompiledJson) can be added later.
 */
export function compileWebhookSpecs(entries: readonly Entry[]): Map<string, readonly CompiledWebhookSpec[]> {
  const map = new Map<string, readonly CompiledWebhookSpec[]>();
  for (const entry of entries) {
    if (!entry.webhooks || entry.webhooks.length === 0) continue;
    const compiled = entry.webhooks.map(compileOne);
    map.set(entry.id, compiled);
  }
  return map;
}

function compileOne(spec: WebhookSpecT): CompiledWebhookSpec {
  const urlTemplate = compileTemplate(spec.url);

  let body: CompiledTemplate | null = null;
  if (spec.body !== undefined && spec.body !== null) {
    const bodyString = typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
    body = compileTemplate(bodyString);
  }

  const headers = new Map<string, CompiledTemplate>();
  for (const [key, value] of Object.entries(spec.headers ?? {})) {
    headers.set(key.toLowerCase(), compileTemplate(value));
  }

  return {
    id: spec.id,
    urlTemplate,
    method: spec.method,
    body,
    headers,
    retry: {
      attempts: spec.retry.attempts,
      backoff: spec.retry.backoff,
      jitterRatio: spec.retry.jitterRatio,
    },
    signing: spec.signing
      ? {
          mode: spec.signing.mode,
          enabled: spec.signing.enabled,
          algorithm: spec.signing.algorithm,
          secretRef: spec.signing.secretRef,
          signedPayload: spec.signing.signedPayload,
          signatureTemplate: spec.signing.signatureTemplate,
          digestEncoding: spec.signing.digestEncoding,
          signatureHeader: spec.signing.signatureHeader,
          timestampHeader: spec.signing.timestampHeader,
          replayWindowMs: spec.signing.replayWindowMs,
        }
      : null,
    circuit: {
      failureThreshold: spec.circuit.failureThreshold,
      cooldownMs: spec.circuit.cooldownMs,
    },
    expectResponse: spec.expectResponse ?? null,
    timeoutMs: spec.timeoutMs,
    allowHttp: spec.allowHttp,
    allowPrivateNetworks: spec.allowPrivateNetworks,
    acceptHeaderOverride: spec.acceptHeaderOverride,
  };
}
