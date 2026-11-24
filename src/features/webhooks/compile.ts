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
 *   - object/array body: every string leaf (and object key) is compiled on its own and
 *     the result is serialised with JSON.stringify at render time (#56). Compiling the
 *     stringified body as one template escaped the quotes inside tokens such as
 *     `{{id("evt_", 14)}}` and broke them. Leaves render in key order, so faker/id draws
 *     happen in the same order as before. Rendered values are still strings (numbers in
 *     templates render as "3"), and are now JSON-escaped. Type-preserving JSON bodies
 *     (renderCompiledJson) remain a possible future change.
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
    body = typeof spec.body === "string" ? compileTemplate(spec.body) : compileJsonBody(spec.body);
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

type BodyNode =
  | { kind: "string"; template: CompiledTemplate }
  | { kind: "literal"; value: unknown }
  | { kind: "array"; items: BodyNode[] }
  | { kind: "object"; entries: Array<[CompiledTemplate, BodyNode]> };

function compileNode(value: unknown): BodyNode {
  if (typeof value === "string") return { kind: "string", template: compileTemplate(value) };
  if (Array.isArray(value)) return { kind: "array", items: value.map(compileNode) };
  if (value !== null && typeof value === "object") {
    return {
      kind: "object",
      entries: Object.entries(value).map(([k, v]) => [compileTemplate(k), compileNode(v)]),
    };
  }
  return { kind: "literal", value };
}

/** Same traversal order as JSON.stringify, so token draws keep their pre-#56 order. */
function renderNode(node: BodyNode, ctx: Parameters<CompiledTemplate["render"]>[0]): unknown {
  switch (node.kind) {
    case "string":
      return node.template.render(ctx);
    case "literal":
      return node.value;
    case "array":
      return node.items.map((n) => renderNode(n, ctx));
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, child] of node.entries) out[key.render(ctx)] = renderNode(child, ctx);
      return out;
    }
  }
}

function compileJsonBody(value: unknown): CompiledTemplate {
  const root = compileNode(value);
  return { render: (ctx) => JSON.stringify(renderNode(root, ctx)) };
}
