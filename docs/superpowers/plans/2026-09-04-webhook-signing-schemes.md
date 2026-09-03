# Webhook Signing Schemes (discriminated union) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the webhook signature wire-format configurable so a mockstar webhook can emit bytes a real GitHub / Slack / Stripe / Shopify / Razorpay receiver will actually verify, without breaking a single existing config.

**Architecture:** `WebhookSigning` becomes a Zod discriminated union on `mode`, with `"hmac"` as the only member today and injected as the default when absent (so existing configs parse unchanged). Within the HMAC member, two independent axes become templates — `signedPayload` (what bytes get HMAC'd) and `signatureTemplate` (what the header value looks like) — plus `digestEncoding` for hex-vs-base64 providers. A small pure module (`scheme.ts`) owns placeholder substitution and validation; the schema, the signer, and the dispatcher all consume it, so the config validator and the runtime can never disagree about what a placeholder means.

**Tech Stack:** TypeScript, Bun 1.3.0+, Zod ^3.23.0, `node:crypto`, Biome, `bun test`.

**Spec:** GitHub issue [#30](https://github.com/dhanesh/mockstar/issues/30) — "Webhook signature scheme is hardcoded — the emitted combination matches no provider". The design deviates from the issue's proposal in one way, recorded in Task 6: the issue proposed `signaturePrefix`, this plan uses a full `signatureTemplate` instead, because a prefix cannot express Stripe's `t=...,v1=...` header. Same field count, strictly larger reach.

## Global Constraints

- **Runtime:** Bun >= 1.3.0 (`package.json` `engines.bun`). Tests run under `bun test`, not node.
- **Zod:** ^3.23.0. `z.discriminatedUnion` members MUST be plain `ZodObject`s — attaching `.superRefine()` to a *member* produces a `ZodEffects` and throws at schema-construction time. All cross-field validation goes on the wrapper, never the member.
- **Back-compat is non-negotiable:** every mock config valid at `8863f0a` MUST still parse, and MUST still produce byte-identical webhook deliveries. Defaults are `signedPayload: "{timestamp}.{body}"`, `signatureTemplate: "{algorithm}={signature}"`, `digestEncoding: "hex"`.
- **Placeholder syntax is single-brace** (`{body}`), deliberately NOT the mockstar `{{ }}` template engine. Webhook headers/url/body are already rendered by `compileTemplate`; using `{{ }}` here would make the request-template engine try to resolve signing placeholders. The two namespaces must stay disjoint.
- **`schema/mock.json` is GENERATED**, never hand-edited — `bun run scripts/generate-schema.ts` emits it from the Zod `MocksFile` type.
- **Secrets:** `secretRef` keeps its existing `SECRET_REF_RE` guard (S3). No new field may accept inline secret material.
- **Constraint-comment convention:** source files carry `// Satisfies: <ID>` headers and tests carry `// @constraint <ID>`. New files follow it; this work is S1 (signing opt-in) and B3 (industry contract).
- **Pre-PR gate:** `bun run verify` (lint + typecheck + build + test) must pass before the branch is proposed.
- **Layering note:** `src/core/config/schema.ts` importing `src/features/webhooks/scheme.ts` is allowed — `src/core/config/loader.ts:7` already imports `compileWebhookSpecs` from that feature. `scheme.ts` imports nothing from `core/`, so no cycle is created.

---

### Task 1: Placeholder substitution engine

Pure, dependency-free module. Everything else in the plan builds on the names it exports.

**Files:**
- Create: `src/features/webhooks/scheme.ts`
- Test: `tests/webhooks/scheme.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type DigestEncoding = "hex" | "base64"`
  - `interface SigningScheme { signedPayload: string; signatureTemplate: string; digestEncoding: DigestEncoding; algorithm: "sha256" }`
  - `const DEFAULT_SIGNED_PAYLOAD = "{timestamp}.{body}"`
  - `const DEFAULT_SIGNATURE_TEMPLATE = "{algorithm}={signature}"`
  - `const SIGNED_PAYLOAD_PLACEHOLDERS: readonly string[]`
  - `const SIGNATURE_TEMPLATE_PLACEHOLDERS: readonly string[]`
  - `function unknownPlaceholders(template: string, allowed: readonly string[]): string[]`
  - `function renderSignedPayload(template: string, v: { body: string; timestampMs: number }): string`
  - `function renderSignatureHeader(template: string, v: { signature: string; algorithm: string; timestampMs: number }): string`
  - `function timestampUnitFor(scheme: Pick<SigningScheme, "signedPayload" | "signatureTemplate">): "ms" | "s" | null`

- [ ] **Step 1: Write the failing test**

Create `tests/webhooks/scheme.test.ts`:

```ts
// Validates: S1 (signing opt-in), B3 (industry contract — provider-shaped signatures)
// @constraint S1 - signature wire format is configuration, not code
// @constraint B3 - emitted bytes match a named provider's documented scheme

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SIGNATURE_TEMPLATE,
  DEFAULT_SIGNED_PAYLOAD,
  SIGNATURE_TEMPLATE_PLACEHOLDERS,
  SIGNED_PAYLOAD_PLACEHOLDERS,
  renderSignatureHeader,
  renderSignedPayload,
  timestampUnitFor,
  unknownPlaceholders,
} from "../../src/features/webhooks/scheme.ts";

const TS = 1_700_000_000_500; // ms; 1700000000 seconds

describe("renderSignedPayload", () => {
  test("default template reproduces the legacy Stripe-style string", () => {
    expect(renderSignedPayload(DEFAULT_SIGNED_PAYLOAD, { body: '{"x":1}', timestampMs: TS })).toBe(
      '1700000000500.{"x":1}',
    );
  });

  test("{body} alone signs the raw body (GitHub / Shopify / Razorpay shape)", () => {
    expect(renderSignedPayload("{body}", { body: '{"x":1}', timestampMs: TS })).toBe('{"x":1}');
  });

  test("{timestampSeconds} truncates milliseconds (Slack / Stripe shape)", () => {
    expect(renderSignedPayload("v0:{timestampSeconds}:{body}", { body: "b", timestampMs: TS })).toBe(
      "v0:1700000000:b",
    );
  });

  test("substitution is single-pass — a placeholder INSIDE the body is not re-substituted", () => {
    // Regression guard: a naive .replace() chain would rewrite the body's own text
    // and produce a signature the receiver can never reproduce.
    expect(renderSignedPayload("{timestamp}.{body}", { body: "{timestamp}", timestampMs: TS })).toBe(
      "1700000000500.{timestamp}",
    );
  });

  test("a body containing $& is inserted literally (no regex replacement-pattern expansion)", () => {
    expect(renderSignedPayload("{body}", { body: "a$&b$'c", timestampMs: TS })).toBe("a$&b$'c");
  });

  test("an unknown placeholder is left untouched rather than blanked", () => {
    expect(renderSignedPayload("{nope}-{body}", { body: "b", timestampMs: TS })).toBe("{nope}-b");
  });
});

describe("renderSignatureHeader", () => {
  test("default template reproduces the legacy prefixed value", () => {
    expect(
      renderSignatureHeader(DEFAULT_SIGNATURE_TEMPLATE, {
        signature: "abc",
        algorithm: "sha256",
        timestampMs: TS,
      }),
    ).toBe("sha256=abc");
  });

  test("bare {signature} emits an unprefixed digest (Razorpay / Shopify shape)", () => {
    expect(
      renderSignatureHeader("{signature}", { signature: "abc", algorithm: "sha256", timestampMs: TS }),
    ).toBe("abc");
  });

  test("Stripe's comma-separated header is expressible", () => {
    expect(
      renderSignatureHeader("t={timestampSeconds},v1={signature}", {
        signature: "abc",
        algorithm: "sha256",
        timestampMs: TS,
      }),
    ).toBe("t=1700000000,v1=abc");
  });
});

describe("unknownPlaceholders", () => {
  test("returns [] when every placeholder is allowed", () => {
    expect(unknownPlaceholders("{timestamp}.{body}", SIGNED_PAYLOAD_PLACEHOLDERS)).toEqual([]);
  });

  test("names each unknown placeholder once, in order", () => {
    expect(unknownPlaceholders("{nonce}-{body}-{nonce}-{secret}", SIGNED_PAYLOAD_PLACEHOLDERS)).toEqual([
      "nonce",
      "secret",
    ]);
  });

  test("{signature} is not valid in a signed payload (would be circular)", () => {
    expect(unknownPlaceholders("{signature}", SIGNED_PAYLOAD_PLACEHOLDERS)).toEqual(["signature"]);
  });

  test("{body} is not valid in a signature header template", () => {
    expect(unknownPlaceholders("{body}", SIGNATURE_TEMPLATE_PLACEHOLDERS)).toEqual(["body"]);
  });
});

describe("timestampUnitFor", () => {
  test("defaults imply a millisecond timestamp header", () => {
    expect(
      timestampUnitFor({
        signedPayload: DEFAULT_SIGNED_PAYLOAD,
        signatureTemplate: DEFAULT_SIGNATURE_TEMPLATE,
      }),
    ).toBe("ms");
  });

  test("a seconds-only scheme implies a seconds timestamp header", () => {
    expect(
      timestampUnitFor({ signedPayload: "v0:{timestampSeconds}:{body}", signatureTemplate: "v0={signature}" }),
    ).toBe("s");
  });

  test("a scheme that never references a timestamp implies no header at all", () => {
    expect(timestampUnitFor({ signedPayload: "{body}", signatureTemplate: "{algorithm}={signature}" })).toBe(
      null,
    );
  });

  test("milliseconds win when both units appear", () => {
    expect(
      timestampUnitFor({
        signedPayload: "{timestamp}.{body}",
        signatureTemplate: "t={timestampSeconds},v1={signature}",
      }),
    ).toBe("ms");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/webhooks/scheme.test.ts`
Expected: FAIL — `Cannot find module '../../src/features/webhooks/scheme.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/features/webhooks/scheme.ts`:

```ts
// Satisfies: S1 (HMAC signing, opt-in per webhook), B3 (industry contract — provider-shaped signatures)
//
// Pure placeholder engine for webhook signature schemes. Two independent axes:
//   - signedPayload     — the bytes fed to HMAC
//   - signatureTemplate — the header VALUE wrapped around the resulting digest
//
// Placeholders are SINGLE-brace (`{body}`) on purpose. Webhook url/body/headers are
// already rendered by the mockstar `{{ }}` template engine before signing; using the
// same delimiters here would make that engine try to resolve signing placeholders.

/** Digest encodings receivers actually use. Shopify signs base64; everyone else here is hex. */
export type DigestEncoding = "hex" | "base64";

/** The resolved, validated wire format for one webhook's signature. */
export interface SigningScheme {
  readonly signedPayload: string;
  readonly signatureTemplate: string;
  readonly digestEncoding: DigestEncoding;
  readonly algorithm: "sha256";
}

/** Legacy default — Stripe's signed-payload construction. Unchanged from v0.2.x. */
export const DEFAULT_SIGNED_PAYLOAD = "{timestamp}.{body}";
/** Legacy default — GitHub's prefixed header value. Unchanged from v0.2.x. */
export const DEFAULT_SIGNATURE_TEMPLATE = "{algorithm}={signature}";

export const SIGNED_PAYLOAD_PLACEHOLDERS = ["body", "timestamp", "timestampSeconds"] as const;
export const SIGNATURE_TEMPLATE_PLACEHOLDERS = [
  "signature",
  "algorithm",
  "timestamp",
  "timestampSeconds",
] as const;

const PLACEHOLDER_RE = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/** Names appearing in `template` that are not in `allowed`, de-duplicated, first-seen order. */
export function unknownPlaceholders(template: string, allowed: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const name = match[1];
    if (!name || allowed.includes(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Single-pass substitution. The callback form is load-bearing twice over:
 *   1. one pass means a placeholder occurring INSIDE a substituted value (e.g. a request
 *      body that literally contains `{timestamp}`) is never rewritten — otherwise the
 *      receiver could not reproduce our signature;
 *   2. a function replacement never interprets `$&`, `$'` etc. in the inserted value.
 * Unknown placeholders are passed through untouched; config-load validation is where
 * they are rejected, so runtime degrades visibly rather than silently blanking bytes.
 */
function substitute(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER_RE, (match, name: string) =>
    Object.hasOwn(values, name) ? (values[name] as string) : match,
  );
}

export function renderSignedPayload(
  template: string,
  v: { body: string; timestampMs: number },
): string {
  return substitute(template, {
    body: v.body,
    timestamp: String(v.timestampMs),
    timestampSeconds: String(Math.floor(v.timestampMs / 1000)),
  });
}

export function renderSignatureHeader(
  template: string,
  v: { signature: string; algorithm: string; timestampMs: number },
): string {
  return substitute(template, {
    signature: v.signature,
    algorithm: v.algorithm,
    timestamp: String(v.timestampMs),
    timestampSeconds: String(Math.floor(v.timestampMs / 1000)),
  });
}

/**
 * Which unit the standalone timestamp header should carry — or `null` when the scheme
 * never references a timestamp, in which case no timestamp header is emitted at all.
 * Emitting milliseconds beside a seconds-based signature is exactly the class of
 * mismatch this feature exists to eliminate, so the unit follows the scheme.
 */
export function timestampUnitFor(
  scheme: Pick<SigningScheme, "signedPayload" | "signatureTemplate">,
): "ms" | "s" | null {
  const combined = `${scheme.signedPayload} ${scheme.signatureTemplate}`;
  if (combined.includes("{timestamp}")) return "ms";
  if (combined.includes("{timestampSeconds}")) return "s";
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/webhooks/scheme.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Lint and commit**

```bash
bun run lint
git add src/features/webhooks/scheme.ts tests/webhooks/scheme.test.ts
git commit -m "feat(webhooks): add signature-scheme placeholder engine

Pure single-pass substitution for {body}/{timestamp}/{timestampSeconds} in
signed payloads and {signature}/{algorithm}/{timestamp}/{timestampSeconds} in
header values, plus unknown-placeholder detection and timestamp-unit derivation.
No behaviour wired up yet.

Refs #30"
```

---

### Task 2: Schema — discriminated union on `mode`, with placeholder validation

**Files:**
- Modify: `src/core/config/schema.ts:148-161` (replace the `WebhookSigning` const)
- Modify: `tests/webhooks/schema.test.ts` (append a new `describe` block)
- Regenerate: `schema/mock.json` (via `scripts/generate-schema.ts` — never hand-edit)

**Interfaces:**
- Consumes: `unknownPlaceholders`, `SIGNED_PAYLOAD_PLACEHOLDERS`, `SIGNATURE_TEMPLATE_PLACEHOLDERS`, `DEFAULT_SIGNED_PAYLOAD`, `DEFAULT_SIGNATURE_TEMPLATE` from Task 1.
- Produces: parsed `signing` objects now carry `mode: "hmac"`, `signedPayload`, `signatureTemplate`, `digestEncoding` in addition to the existing fields. Task 4 reads all of them off `WebhookSpecT`.

- [ ] **Step 1: Write the failing test**

Append to `tests/webhooks/schema.test.ts`. If `MockEntry` is not already imported there, add it to the existing import from `../../src/core/config/schema.ts`.

```ts
describe("signing schemes (#30) — discriminated union on mode", () => {
  test("a config with no `mode` still parses, and defaults reproduce v0.2.x behaviour", () => {
    const parsed = MockEntry.parse({
      id: "m",
      match: { method: "POST", path: "/x" },
      response: { kind: "static", status: 200, body: {} },
      webhooks: [
        {
          id: "w",
          url: "https://example.test/hook",
          signing: { enabled: true, secretRef: "{{ env.SECRET_X }}" },
        },
      ],
    });
    const signing = parsed.webhooks?.[0]?.signing;
    expect(signing?.mode).toBe("hmac");
    expect(signing?.signedPayload).toBe("{timestamp}.{body}");
    expect(signing?.signatureTemplate).toBe("{algorithm}={signature}");
    expect(signing?.digestEncoding).toBe("hex");
  });

  test("an explicit mode: 'hmac' parses identically", () => {
    const parsed = MockEntry.parse({
      id: "m",
      match: { method: "POST", path: "/x" },
      response: { kind: "static", status: 200, body: {} },
      webhooks: [
        {
          id: "w",
          url: "https://example.test/hook",
          signing: { mode: "hmac", enabled: true, secretRef: "{{ env.SECRET_X }}" },
        },
      ],
    });
    expect(parsed.webhooks?.[0]?.signing?.mode).toBe("hmac");
  });

  test("a GitHub-shaped scheme round-trips", () => {
    const parsed = MockEntry.parse({
      id: "m",
      match: { method: "POST", path: "/x" },
      response: { kind: "static", status: 200, body: {} },
      webhooks: [
        {
          id: "w",
          url: "https://example.test/hook",
          signing: {
            enabled: true,
            secretRef: "{{ env.SECRET_X }}",
            signedPayload: "{body}",
            signatureHeader: "x-hub-signature-256",
          },
        },
      ],
    });
    const signing = parsed.webhooks?.[0]?.signing;
    expect(signing?.signedPayload).toBe("{body}");
    expect(signing?.signatureHeader).toBe("x-hub-signature-256");
  });

  test("digestEncoding accepts base64 (Shopify)", () => {
    const parsed = MockEntry.parse({
      id: "m",
      match: { method: "POST", path: "/x" },
      response: { kind: "static", status: 200, body: {} },
      webhooks: [
        {
          id: "w",
          url: "https://example.test/hook",
          signing: { enabled: true, secretRef: "{{ env.SECRET_X }}", digestEncoding: "base64" },
        },
      ],
    });
    expect(parsed.webhooks?.[0]?.signing?.digestEncoding).toBe("base64");
  });

  test("an unknown placeholder in signedPayload is rejected, and the message names it", () => {
    const build = () =>
      MockEntry.parse({
        id: "m",
        match: { method: "POST", path: "/x" },
        response: { kind: "static", status: 200, body: {} },
        webhooks: [
          {
            id: "w",
            url: "https://example.test/hook",
            signing: { enabled: true, secretRef: "{{ env.SECRET_X }}", signedPayload: "{nonce}.{body}" },
          },
        ],
      });
    expect(build).toThrow(/\{nonce\}/);
  });

  test("a signatureTemplate that omits {signature} is rejected", () => {
    const build = () =>
      MockEntry.parse({
        id: "m",
        match: { method: "POST", path: "/x" },
        response: { kind: "static", status: 200, body: {} },
        webhooks: [
          {
            id: "w",
            url: "https://example.test/hook",
            signing: { enabled: true, secretRef: "{{ env.SECRET_X }}", signatureTemplate: "sha256=" },
          },
        ],
      });
    expect(build).toThrow(/\{signature\}/);
  });

  test("an unknown mode is rejected", () => {
    const build = () =>
      MockEntry.parse({
        id: "m",
        match: { method: "POST", path: "/x" },
        response: { kind: "static", status: 200, body: {} },
        webhooks: [
          {
            id: "w",
            url: "https://example.test/hook",
            signing: { mode: "ed25519", enabled: true, secretRef: "{{ env.SECRET_X }}" },
          },
        ],
      });
    expect(build).toThrow();
  });

  test("inline secrets are still rejected under the union (S3 unchanged)", () => {
    const build = () =>
      MockEntry.parse({
        id: "m",
        match: { method: "POST", path: "/x" },
        response: { kind: "static", status: 200, body: {} },
        webhooks: [
          { id: "w", url: "https://example.test/hook", signing: { enabled: true, secretRef: "plain" } },
        ],
      });
    expect(build).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/webhooks/schema.test.ts`
Expected: FAIL — the first test fails on `expect(signing?.mode).toBe("hmac")` receiving `undefined`.

- [ ] **Step 3: Replace `WebhookSigning` in `src/core/config/schema.ts`**

Add to the imports at the top of the file:

```ts
import {
  DEFAULT_SIGNATURE_TEMPLATE,
  DEFAULT_SIGNED_PAYLOAD,
  SIGNATURE_TEMPLATE_PLACEHOLDERS,
  SIGNED_PAYLOAD_PLACEHOLDERS,
  unknownPlaceholders,
} from "../../features/webhooks/scheme.ts";
```

Replace lines 148-161 entirely with:

```ts
// #30: the signature wire format is two independent axes — what gets signed, and what the
// header value looks like. Modelled as a discriminated union on `mode` so future mechanisms
// (ed25519, oidc) slot in as new members without another breaking change. `mode` is injected
// when absent, so every pre-existing config parses untouched.
const HmacSigning = z
  .object({
    mode: z.literal("hmac"),
    enabled: z.boolean().default(false),
    algorithm: z.literal("sha256").default("sha256"),
    // S3: secret-ref shape enforced here; inline strings produce a validation error at config-load.
    secretRef: z.string().regex(SECRET_REF_RE, {
      message:
        "webhook signing.secretRef must be `{{ env.NAME }}` or `file:/path`; inline secrets rejected (S3)",
    }),
    /** Bytes fed to HMAC. Default is Stripe's construction — v0.2.x behaviour. */
    signedPayload: z.string().min(1).default(DEFAULT_SIGNED_PAYLOAD),
    /** Header VALUE wrapped around the digest. Default is GitHub's prefix — v0.2.x behaviour. */
    signatureTemplate: z.string().min(1).default(DEFAULT_SIGNATURE_TEMPLATE),
    digestEncoding: z.enum(["hex", "base64"]).default("hex"),
    signatureHeader: z.string().min(1).default("x-mockstar-signature"),
    timestampHeader: z.string().min(1).default("x-mockstar-timestamp"),
    replayWindowMs: z.number().int().positive().default(300_000),
  })
  .strict();

const WebhookSigning = z
  .preprocess(
    (raw) =>
      raw !== null && typeof raw === "object" && !Array.isArray(raw) && !("mode" in raw)
        ? { ...(raw as Record<string, unknown>), mode: "hmac" }
        : raw,
    // Zod 3: discriminatedUnion members MUST be bare ZodObjects — a .superRefine() here
    // would yield a ZodEffects and throw at construction. Cross-field checks go on the wrapper.
    z.discriminatedUnion("mode", [HmacSigning]),
  )
  .superRefine((v, ctx) => {
    const fmt = (names: readonly string[]) => names.map((n) => `{${n}}`).join(", ");

    const badPayload = unknownPlaceholders(v.signedPayload, SIGNED_PAYLOAD_PLACEHOLDERS);
    if (badPayload.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signedPayload"],
        message: `unknown placeholder(s) ${fmt(badPayload)} — allowed: ${fmt(SIGNED_PAYLOAD_PLACEHOLDERS)}`,
      });
    }

    const badTemplate = unknownPlaceholders(v.signatureTemplate, SIGNATURE_TEMPLATE_PLACEHOLDERS);
    if (badTemplate.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signatureTemplate"],
        message: `unknown placeholder(s) ${fmt(badTemplate)} — allowed: ${fmt(SIGNATURE_TEMPLATE_PLACEHOLDERS)}`,
      });
    }

    if (!v.signatureTemplate.includes("{signature}")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signatureTemplate"],
        message:
          "signatureTemplate must contain {signature} — otherwise the signature header carries no digest",
      });
    }
  });
```

Leave line 203 (`signing: WebhookSigning.optional()`) as-is — `ZodEffects.optional()` is valid.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/webhooks/schema.test.ts tests/config-schema.test.ts`
Expected: PASS. The pre-existing S3 tests at `tests/webhooks/schema.test.ts:24-47` must still pass unchanged — they are the back-compat proof.

- [ ] **Step 5: Regenerate the JSON Schema and verify the new fields landed**

```bash
bun run scripts/generate-schema.ts
grep -c 'signedPayload\|signatureTemplate\|digestEncoding' schema/mock.json
```

Expected: the grep count is at least 3.

**If the count is 0**, `zod-to-json-schema` has collapsed the `ZodEffects` wrapper. Fix by unwrapping for generation only — in `scripts/generate-schema.ts` the `zodToJsonSchema` call already passes `$refStrategy: 'none'`; add `effectStrategy: 'input'` to the same options object and re-run. Do not work around it by hand-editing `schema/mock.json`.

- [ ] **Step 6: Run the full test suite and commit**

Run: `bun test`
Expected: PASS — in particular `tests/schema/generate-schema.test.ts` and `tests/webhooks/secret-redaction.test.ts` (the latter still passes here because the admin projection is untouched until Task 4).

```bash
git add src/core/config/schema.ts tests/webhooks/schema.test.ts schema/ scripts/generate-schema.ts
git commit -m "feat(webhooks): model signing as a discriminated union on mode

Adds signedPayload, signatureTemplate and digestEncoding to the hmac member,
with defaults that reproduce v0.2.x byte-for-byte. Unknown placeholders and a
signatureTemplate missing {signature} are rejected at config-load. Regenerates
schema/mock.json.

Refs #30"
```

---

### Task 3: Scheme-aware signing and verification

**Files:**
- Modify: `src/features/webhooks/signing.ts:7-44`
- Modify: `src/features/webhooks/index.ts` (final export line)
- Modify: `tests/webhooks/signing.test.ts` (append a `describe` block; leave existing tests untouched)

**Interfaces:**
- Consumes: `SigningScheme`, `renderSignedPayload`, `DEFAULT_SIGNED_PAYLOAD`, `DEFAULT_SIGNATURE_TEMPLATE` from Task 1.
- Produces:
  - `const LEGACY_SCHEME: SigningScheme`
  - `signPayload(rawBody: string, secret: string, timestampMs: number, scheme?: SigningScheme): string`
  - `verifySignature(rawBody: string, secret: string, timestampMs: number, signature: string, scheme?: SigningScheme): boolean`

  Both `scheme` parameters are optional and default to `LEGACY_SCHEME`, so every existing caller — including library embedders who import these from the package root — keeps compiling and keeps producing identical output.

- [ ] **Step 1: Write the failing test**

Extend the imports at the top of `tests/webhooks/signing.test.ts`:

```ts
import { createHmac } from "node:crypto";
import {
  DEFAULT_SIGNATURE_TEMPLATE,
  DEFAULT_SIGNED_PAYLOAD,
  type SigningScheme,
} from "../../src/features/webhooks/scheme.ts";
```

Append:

```ts
describe("scheme-aware signing (#30)", () => {
  const TS = 1_700_000_000_500;

  const scheme = (over: Partial<SigningScheme> = {}): SigningScheme => ({
    signedPayload: DEFAULT_SIGNED_PAYLOAD,
    signatureTemplate: DEFAULT_SIGNATURE_TEMPLATE,
    digestEncoding: "hex",
    algorithm: "sha256",
    ...over,
  });

  test("omitting the scheme reproduces the pre-#30 signature exactly", () => {
    const legacy = createHmac("sha256", "s").update(`${TS}.{"x":1}`, "utf8").digest("hex");
    expect(signPayload('{"x":1}', "s", TS)).toBe(legacy);
  });

  test("{body} signs the raw body — matches a GitHub-style verifier", () => {
    const expected = createHmac("sha256", "s").update('{"x":1}', "utf8").digest("hex");
    expect(signPayload('{"x":1}', "s", TS, scheme({ signedPayload: "{body}" }))).toBe(expected);
  });

  test("Slack's v0 construction is reproducible", () => {
    const expected = createHmac("sha256", "s").update('v0:1700000000:{"x":1}', "utf8").digest("hex");
    expect(
      signPayload('{"x":1}', "s", TS, scheme({ signedPayload: "v0:{timestampSeconds}:{body}" })),
    ).toBe(expected);
  });

  test("base64 encoding matches a Shopify-style verifier", () => {
    const expected = createHmac("sha256", "s").update('{"x":1}', "utf8").digest("base64");
    expect(
      signPayload('{"x":1}', "s", TS, scheme({ signedPayload: "{body}", digestEncoding: "base64" })),
    ).toBe(expected);
  });

  test("verifySignature round-trips under a non-default scheme", () => {
    const s = scheme({ signedPayload: "{body}", digestEncoding: "base64" });
    const sig = signPayload('{"x":1}', "s", TS, s);
    expect(verifySignature('{"x":1}', "s", TS, sig, s)).toBe(true);
    expect(verifySignature('{"x":2}', "s", TS, sig, s)).toBe(false);
  });

  test("verifySignature rejects a signature produced under a DIFFERENT scheme", () => {
    // This is bug #30 in miniature: right secret, right body, wrong construction.
    const sig = signPayload('{"x":1}', "s", TS, scheme({ signedPayload: "{body}" }));
    expect(verifySignature('{"x":1}', "s", TS, sig, scheme())).toBe(false);
  });

  test("verifySignature handles malformed base64 without throwing", () => {
    expect(verifySignature("{}", "s", TS, "!!!!", scheme({ digestEncoding: "base64" }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/webhooks/signing.test.ts`
Expected: FAIL — "{body} signs the raw body" gets the legacy timestamped digest instead.

- [ ] **Step 3: Rewrite the two functions in `src/features/webhooks/signing.ts`**

Add to the imports:

```ts
import {
  DEFAULT_SIGNATURE_TEMPLATE,
  DEFAULT_SIGNED_PAYLOAD,
  type SigningScheme,
  renderSignedPayload,
} from "./scheme.ts";
```

Replace lines 7-44 (the `signPayload` and `verifySignature` blocks, including their doc comments) with:

```ts
/**
 * The pre-#30 wire format: Stripe's signed payload, GitHub's header prefix, hex digest.
 * Used when a caller supplies no scheme, so library embedders calling signPayload/
 * verifySignature directly keep their v0.2.x behaviour.
 */
export const LEGACY_SCHEME: SigningScheme = Object.freeze({
  signedPayload: DEFAULT_SIGNED_PAYLOAD,
  signatureTemplate: DEFAULT_SIGNATURE_TEMPLATE,
  digestEncoding: "hex",
  algorithm: "sha256",
});

/**
 * Sign a webhook payload under `scheme`.
 *
 * The signed string is `scheme.signedPayload` with {body}/{timestamp}/{timestampSeconds}
 * substituted; the digest is encoded per `scheme.digestEncoding`. Receivers verify by
 * reconstructing the same string and comparing constant-time.
 *
 * Replay-window enforcement is the receiver's responsibility — but we emit the timestamp
 * (in the unit the scheme uses, see timestampUnitFor) so they CAN enforce it.
 */
export function signPayload(
  rawBody: string,
  secret: string,
  timestampMs: number,
  scheme: SigningScheme = LEGACY_SCHEME,
): string {
  const stringToSign = renderSignedPayload(scheme.signedPayload, { body: rawBody, timestampMs });
  return createHmac(scheme.algorithm, secret).update(stringToSign, "utf8").digest(scheme.digestEncoding);
}

/**
 * Verify a signature constant-time under the SAME scheme it was produced with. Used by
 * tests; receivers will implement equivalent logic in their own language. Exposed so tests
 * against this module can verify what we sent matches what we documented (S1 + RT-2 evidence).
 *
 * Returns false on length mismatch, encoding mismatch, or timing-safe-compare miss. Never throws.
 */
export function verifySignature(
  rawBody: string,
  secret: string,
  timestampMs: number,
  signature: string,
  scheme: SigningScheme = LEGACY_SCHEME,
): boolean {
  const expected = signPayload(rawBody, secret, timestampMs, scheme);
  // timingSafeEqual requires equal-length buffers — different lengths means immediate mismatch.
  if (expected.length !== signature.length) return false;
  try {
    const a = Buffer.from(expected, scheme.digestEncoding);
    const b = Buffer.from(signature, scheme.digestEncoding);
    // Buffer.from is lenient with malformed input and can shorten silently; re-check.
    if (a.length !== b.length || a.length === 0) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/webhooks/signing.test.ts`
Expected: PASS — including all seven pre-existing tests in the first two `describe` blocks, unchanged.

- [ ] **Step 5: Export the new surface, typecheck, commit**

In `src/features/webhooks/index.ts`, replace the final export line with:

```ts
export { signPayload, verifySignature, withinReplayWindow, resolveSecret, LEGACY_SCHEME } from "./signing.ts";
export {
  DEFAULT_SIGNATURE_TEMPLATE,
  DEFAULT_SIGNED_PAYLOAD,
  renderSignatureHeader,
  renderSignedPayload,
  timestampUnitFor,
} from "./scheme.ts";
export type { DigestEncoding, SigningScheme } from "./scheme.ts";
```

```bash
bun run lint && bun run typecheck
git add src/features/webhooks/signing.ts src/features/webhooks/index.ts tests/webhooks/signing.test.ts
git commit -m "feat(webhooks): make signPayload/verifySignature scheme-aware

Both take an optional SigningScheme defaulting to LEGACY_SCHEME, so existing
callers and library embedders are byte-identical. Adds base64 digest support
with a length re-check so malformed input cannot slip past timingSafeEqual.

Refs #30"
```

---

### Task 4: Wire the scheme through compile, dispatcher and admin

**Files:**
- Modify: `src/features/webhooks/types.ts:14-27` (`WebhookSigningSpec`)
- Modify: `src/features/webhooks/compile.ts:56-65` (the `signing` projection)
- Modify: `src/features/webhooks/dispatcher.ts:14` (import) and `:154-161` (the signing block)
- Modify: `src/features/admin/endpoints.ts:124-125` (add `mode` to the redacted projection)
- Modify: `tests/webhooks/secret-redaction.test.ts:10` (comment) and `:141-143` (exact-keys assertion)
- Modify: `tests/webhooks/signing.test.ts` (append a dispatcher-level `describe`)

**Interfaces:**
- Consumes: everything from Tasks 1-3, plus the parsed schema fields from Task 2.
- Produces: deliveries whose signature header and timestamp header follow the configured scheme. Task 5 asserts on the wire.

- [ ] **Step 1: Write the failing test**

Extend the imports of `tests/webhooks/signing.test.ts`:

```ts
import type { Entry } from "../../src/core/config/schema.ts";
import { makeTestServer, spawnReceiver, tick, webhookSpec } from "./_helpers.ts";
```

Append:

```ts
describe("timestamp header follows the scheme (#30)", () => {
  test("a body-only scheme emits NO timestamp header", async () => {
    const receiver = spawnReceiver(() => new Response("{}", { status: 200 }));
    process.env.MOCKSTAR_TEST_SIG_SECRET = "shhh";
    const entries: Entry[] = [
      {
        id: "mock1",
        match: { method: "POST", path: "/orders", priority: 0 },
        response: { kind: "static", status: 201, body: { ok: true } },
        webhooks: [
          webhookSpec({
            url: receiver.url,
            signing: {
              enabled: true,
              secretRef: "{{ env.MOCKSTAR_TEST_SIG_SECRET }}",
              signedPayload: "{body}",
              signatureHeader: "x-hub-signature-256",
            },
          }),
        ],
      },
    ];
    const { server } = makeTestServer({ entries });
    await server.hono.fetch(
      new Request("http://localhost/orders", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
    );
    await tick(200);
    receiver.close();

    expect(receiver.hits.length).toBe(1);
    const headers = receiver.hits[0]?.headers ?? {};
    expect(headers["x-hub-signature-256"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers["x-mockstar-timestamp"]).toBeUndefined();
  });

  test("a seconds-based scheme emits a SECONDS timestamp header", async () => {
    const receiver = spawnReceiver(() => new Response("{}", { status: 200 }));
    process.env.MOCKSTAR_TEST_SIG_SECRET = "shhh";
    const entries: Entry[] = [
      {
        id: "mock1",
        match: { method: "POST", path: "/orders", priority: 0 },
        response: { kind: "static", status: 201, body: { ok: true } },
        webhooks: [
          webhookSpec({
            url: receiver.url,
            signing: {
              enabled: true,
              secretRef: "{{ env.MOCKSTAR_TEST_SIG_SECRET }}",
              signedPayload: "v0:{timestampSeconds}:{body}",
              signatureTemplate: "v0={signature}",
              signatureHeader: "x-slack-signature",
              timestampHeader: "x-slack-request-timestamp",
            },
          }),
        ],
      },
    ];
    const { server } = makeTestServer({ entries });
    await server.hono.fetch(
      new Request("http://localhost/orders", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
    );
    await tick(200);
    receiver.close();

    const headers = receiver.hits[0]?.headers ?? {};
    expect(headers["x-slack-signature"]).toMatch(/^v0=[0-9a-f]{64}$/);
    // 10 digits, not 13 — seconds, matching what the signature actually covers.
    expect(headers["x-slack-request-timestamp"]).toMatch(/^\d{10}$/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/webhooks/signing.test.ts`
Expected: FAIL — `x-mockstar-timestamp` is defined (the dispatcher still emits it unconditionally), and the Slack signature header reads `sha256=...` rather than `v0=...`.

- [ ] **Step 3a: Extend `WebhookSigningSpec` in `src/features/webhooks/types.ts`**

Add to the file's imports:

```ts
import type { DigestEncoding } from "./scheme.ts";
```

Replace lines 14-27 with:

```ts
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
```

- [ ] **Step 3b: Carry the new fields in `src/features/webhooks/compile.ts`**

Replace the `signing:` projection at lines 56-65 with:

```ts
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
```

- [ ] **Step 3c: Use the scheme in `src/features/webhooks/dispatcher.ts`**

Change the import at line 14 to:

```ts
import { type SigningScheme, renderSignatureHeader, timestampUnitFor } from "./scheme.ts";
import { resolveSecret, signPayload } from "./signing.ts";
```

Replace the signing block (lines 154-161, the `if (spec.signing?.enabled) { ... }`) with:

```ts
  // Sign if enabled (S1 opt-in). Wire format comes from config, not code (#30).
  if (spec.signing?.enabled) {
    const secret = resolveSecret(spec.signing.secretRef);
    const timestampMs = Date.now();
    const scheme: SigningScheme = {
      signedPayload: spec.signing.signedPayload,
      signatureTemplate: spec.signing.signatureTemplate,
      digestEncoding: spec.signing.digestEncoding,
      algorithm: spec.signing.algorithm,
    };
    const signature = signPayload(rawBody, secret, timestampMs, scheme);
    renderedHeaders.set(
      spec.signing.signatureHeader,
      renderSignatureHeader(scheme.signatureTemplate, {
        signature,
        algorithm: scheme.algorithm,
        timestampMs,
      }),
    );
    // Emit the standalone timestamp header only when the scheme references one, and in the
    // unit it signs — a millisecond header beside a seconds-based signature is precisely the
    // mismatch #30 was about.
    const unit = timestampUnitFor(scheme);
    if (unit !== null) {
      const value = unit === "s" ? Math.floor(timestampMs / 1000) : timestampMs;
      renderedHeaders.set(spec.signing.timestampHeader, String(value));
    }
  }
```

- [ ] **Step 3d: Add `mode` to the admin projection in `src/features/admin/endpoints.ts`**

Replace lines 124-125 with:

```ts
            signing: spec.signing
              ? { mode: spec.signing.mode, enabled: spec.signing.enabled, algorithm: spec.signing.algorithm }
```

`mode` is format metadata, not secret material — the U3 invariant is about `secretRef` and the resolved secret, both of which stay out of this projection.

- [ ] **Step 3e: Update the U3 assertions in `tests/webhooks/secret-redaction.test.ts`**

Change the header comment at line 10 from `{ enabled: bool, algorithm: 'sha256' }` to `{ mode: 'hmac', enabled: bool, algorithm: 'sha256' }`.

Replace lines 141-143 with:

```ts
    // Shape-only: `mode`, `enabled` and `algorithm` keys — no secret material, no wire format.
    expect(Object.keys(wh?.signing!).sort()).toEqual(["algorithm", "enabled", "mode"]);
    expect(wh?.signing?.algorithm).toBe("sha256");
    expect(wh?.signing?.enabled).toBe(true);
    expect(wh?.signing?.mode).toBe("hmac");
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/webhooks`
Expected: PASS, all files. The U3 redaction test and every pre-existing webhook integration test must be green.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bun run typecheck && bun run lint
git add src/features/webhooks/types.ts src/features/webhooks/compile.ts src/features/webhooks/dispatcher.ts src/features/admin/endpoints.ts tests/webhooks/secret-redaction.test.ts tests/webhooks/signing.test.ts
git commit -m "feat(webhooks): emit the configured signature wire format

Dispatcher renders the signature header from signatureTemplate and emits the
timestamp header only when the scheme references one, in the unit it signs.
Admin projection reports mode alongside enabled/algorithm.

Refs #30"
```

---

### Task 5: Provider-fidelity integration tests

The proof that #30 is closed: for each provider, sign a delivery with mockstar and verify it with the receiver code that provider's own docs prescribe.

**Files:**
- Create: `tests/webhooks/provider-fidelity.test.ts`

**Interfaces:**
- Consumes: `makeTestServer`, `spawnReceiver`, `tick`, `webhookSpec` from `tests/webhooks/_helpers.ts`; the scheme fields from Task 2.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the test**

Create `tests/webhooks/provider-fidelity.test.ts`:

```ts
// Validates: B3 (industry contract), S1 (signing opt-in)
// @constraint B3 - a delivery signed for provider X verifies under X's documented algorithm
//
// Each case reimplements the receiver-side check from the named provider's docs and asserts
// mockstar's delivered header passes it. Closing evidence for #30.

import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { Entry } from "../../src/core/config/schema.ts";
import { makeTestServer, spawnReceiver, tick, webhookSpec } from "./_helpers.ts";

const SECRET = "provider-shared-secret";
process.env.MOCKSTAR_TEST_PROVIDER_SECRET = SECRET;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

/** Fire one request at a mock configured with `signing`, return the captured delivery. */
async function deliverWith(signing: Record<string, unknown>) {
  const receiver = spawnReceiver(() => new Response("{}", { status: 200 }));
  cleanups.push(receiver.close);

  const entries: Entry[] = [
    {
      id: "mock1",
      match: { method: "POST", path: "/orders", priority: 0 },
      response: { kind: "static", status: 201, body: { ok: true } },
      webhooks: [
        webhookSpec({
          url: receiver.url,
          body: { event: "order.created", id: "ord_1" },
          signing: { enabled: true, secretRef: "{{ env.MOCKSTAR_TEST_PROVIDER_SECRET }}", ...signing },
        }),
      ],
    },
  ];
  const { server } = makeTestServer({ entries });
  await server.hono.fetch(
    new Request("http://localhost/orders", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    }),
  );
  await tick(200);

  expect(receiver.hits.length).toBe(1);
  const hit = receiver.hits[0];
  if (!hit) throw new Error("no delivery captured");
  return hit;
}

describe("B3 — mockstar default (unchanged from v0.2.x)", () => {
  test("timestamped payload, sha256= prefix, hex", async () => {
    const hit = await deliverWith({});
    const ts = hit.headers["x-mockstar-timestamp"];
    expect(ts).toMatch(/^\d{13}$/);
    const expected = createHmac("sha256", SECRET).update(`${ts}.${hit.body}`, "utf8").digest("hex");
    expect(hit.headers["x-mockstar-signature"]).toBe(`sha256=${expected}`);
  });
});

describe("B3 — GitHub (x-hub-signature-256)", () => {
  test("HMAC over the raw body, sha256= prefix, hex", async () => {
    const hit = await deliverWith({
      signedPayload: "{body}",
      signatureHeader: "x-hub-signature-256",
    });
    // Receiver code from GitHub's "Validating webhook deliveries" docs.
    const expected = `sha256=${createHmac("sha256", SECRET).update(hit.body, "utf8").digest("hex")}`;
    expect(hit.headers["x-hub-signature-256"]).toBe(expected);
    // A body-only scheme carries no timestamp, so none is advertised.
    expect(hit.headers["x-mockstar-timestamp"]).toBeUndefined();
  });
});

describe("B3 — Slack (x-slack-signature)", () => {
  test("v0:{ts}:{body} basestring, v0= prefix, seconds timestamp", async () => {
    const hit = await deliverWith({
      signedPayload: "v0:{timestampSeconds}:{body}",
      signatureTemplate: "v0={signature}",
      signatureHeader: "x-slack-signature",
      timestampHeader: "x-slack-request-timestamp",
    });
    const ts = hit.headers["x-slack-request-timestamp"];
    expect(ts).toMatch(/^\d{10}$/);
    const basestring = `v0:${ts}:${hit.body}`;
    const expected = `v0=${createHmac("sha256", SECRET).update(basestring, "utf8").digest("hex")}`;
    expect(hit.headers["x-slack-signature"]).toBe(expected);
  });
});

describe("B3 — Stripe (stripe-signature)", () => {
  test("t=,v1= comma header with a seconds-based signed payload", async () => {
    const hit = await deliverWith({
      signedPayload: "{timestampSeconds}.{body}",
      signatureTemplate: "t={timestampSeconds},v1={signature}",
      signatureHeader: "stripe-signature",
    });
    // Receiver code from Stripe's signature-verification docs: split the header, rebuild
    // signed_payload as `${t}.${body}`, compare v1.
    const header = hit.headers["stripe-signature"] ?? "";
    const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
    expect(parts.t).toMatch(/^\d{10}$/);
    const expected = createHmac("sha256", SECRET).update(`${parts.t}.${hit.body}`, "utf8").digest("hex");
    expect(parts.v1).toBe(expected);
  });
});

describe("B3 — Shopify (x-shopify-hmac-sha256)", () => {
  test("HMAC over the raw body, bare base64 digest", async () => {
    const hit = await deliverWith({
      signedPayload: "{body}",
      signatureTemplate: "{signature}",
      digestEncoding: "base64",
      signatureHeader: "x-shopify-hmac-sha256",
    });
    const expected = createHmac("sha256", SECRET).update(hit.body, "utf8").digest("base64");
    expect(hit.headers["x-shopify-hmac-sha256"]).toBe(expected);
    expect(hit.headers["x-shopify-hmac-sha256"]).not.toContain("sha256=");
  });
});

describe("B3 — Razorpay (x-razorpay-signature)", () => {
  test("HMAC over the raw body, bare hex digest", async () => {
    const hit = await deliverWith({
      signedPayload: "{body}",
      signatureTemplate: "{signature}",
      signatureHeader: "x-razorpay-signature",
    });
    const expected = createHmac("sha256", SECRET).update(hit.body, "utf8").digest("hex");
    expect(hit.headers["x-razorpay-signature"]).toBe(expected);
    expect(hit.headers["x-razorpay-signature"]).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `bun test tests/webhooks/provider-fidelity.test.ts`
Expected: PASS, 6 tests. Tasks 1-4 already implement the behaviour, so this task's value is the executable proof and a green first run is the correct outcome. If any case fails, the defect is in Task 4's wiring — fix it there rather than loosening an assertion to match.

- [ ] **Step 3: Commit**

```bash
bun run lint
git add tests/webhooks/provider-fidelity.test.ts
git commit -m "test(webhooks): prove deliveries verify under each provider's own algorithm

GitHub, Slack, Stripe, Shopify, Razorpay and the mockstar default, each checked
with receiver code taken from that provider's documented verification steps.

Closes #30"
```

---

### Task 6: Documentation and decision record

**Files:**
- Modify: `docs/webhooks/README.md:41-70` (the "Signing (HMAC-SHA256)" section)
- Modify: `docs/webhooks/DECISIONS.md` (append a decision entry)
- Modify: `docs/base-in-reality/2026-06-21-audit.md:101-111` (footnote the S1 claim)

**Interfaces:**
- Consumes: the final field names from Task 2.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Replace the signing section in `docs/webhooks/README.md`**

Replace from the `## Signing (HMAC-SHA256)` heading through the line ending `Inline string secrets are **rejected at config-load**.` with:

````markdown
## Signing (HMAC-SHA256)

Opt-in per webhook. Two independent axes control the wire format: `signedPayload` (the bytes
that get HMAC'd) and `signatureTemplate` (the header value wrapped around the digest).

```json
"signing": {
  "enabled": true,
  "secretRef": "{{ env.PARTNER_HOOK_SECRET }}",
  "signedPayload": "{timestamp}.{body}",
  "signatureTemplate": "{algorithm}={signature}",
  "digestEncoding": "hex",
  "signatureHeader": "x-mockstar-signature",
  "timestampHeader": "x-mockstar-timestamp",
  "replayWindowMs": 300000
}
```

Every field above except `secretRef` is optional and shown at its default, so the block
reduces to `{ "enabled": true, "secretRef": "..." }` for mockstar's own format.

### Placeholders

Signing placeholders are **single-brace** — they are not the `{{ }}` request-template engine,
which has already run over the url, body and headers by the time signing happens.

| Placeholder | Valid in | Value |
|---|---|---|
| `{body}` | `signedPayload` | the rendered request body, exactly as sent |
| `{timestamp}` | both | signing time in unix **milliseconds** |
| `{timestampSeconds}` | both | signing time in unix **seconds** |
| `{signature}` | `signatureTemplate` | the digest, encoded per `digestEncoding` |
| `{algorithm}` | `signatureTemplate` | literal `sha256` |

`signatureTemplate` must contain `{signature}`; anything else is rejected at config-load,
as is any placeholder not in this table.

`timestampHeader` is emitted **only** when the scheme references a timestamp, and carries the
unit the signature actually covers — seconds if the scheme uses only `{timestampSeconds}`,
milliseconds otherwise.

### Provider cookbook

| Provider | `signedPayload` | `signatureTemplate` | `digestEncoding` | `signatureHeader` |
|---|---|---|---|---|
| mockstar (default) | `{timestamp}.{body}` | `{algorithm}={signature}` | `hex` | `x-mockstar-signature` |
| GitHub | `{body}` | `{algorithm}={signature}` | `hex` | `x-hub-signature-256` |
| Slack | `v0:{timestampSeconds}:{body}` | `v0={signature}` | `hex` | `x-slack-signature` |
| Stripe | `{timestampSeconds}.{body}` | `t={timestampSeconds},v1={signature}` | `hex` | `stripe-signature` |
| Shopify | `{body}` | `{signature}` | `base64` | `x-shopify-hmac-sha256` |
| Razorpay | `{body}` | `{signature}` | `hex` | `x-razorpay-signature` |

Each row is covered by an executable test in `tests/webhooks/provider-fidelity.test.ts`,
which verifies the delivered header with receiver code taken from that provider's own docs.
For Slack, also set `"timestampHeader": "x-slack-request-timestamp"`.

### Receiver verification (mockstar default format)

```js
const stringToSign = `${req.headers['x-mockstar-timestamp']}.${rawBody}`;
const expected = crypto.createHmac('sha256', SECRET).update(stringToSign).digest('hex');
const provided = req.headers['x-mockstar-signature'].replace(/^sha256=/, '');
if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'))) reject();
if (Date.now() - Number(req.headers['x-mockstar-timestamp']) > 300_000) reject();
```

### Modes

`signing.mode` selects the mechanism and defaults to `"hmac"` — the only one implemented in
v0.x. It exists so asymmetric (ed25519) and OIDC-bearer modes can be added as new union
members without another breaking change. Omit it unless a future release documents otherwise.

`secretRef` MUST be one of:
- `{{ env.NAME }}` — env var, read per delivery
- `file:/path` — file content (trimmed), read per delivery

Inline string secrets are **rejected at config-load**.
````

- [ ] **Step 2: Append the decision record to `docs/webhooks/DECISIONS.md`**

```markdown

## Signature wire format is configuration, not code (#30)

v0.2.x hardcoded `HMAC(timestamp.body)` delivered as `sha256=<hex>` — Stripe's signed-payload
construction paired with GitHub's header value. That combination matches **no** provider, and
because `signatureHeader` was already configurable, a mock could wear `x-hub-signature-256`
while carrying a digest no GitHub-shaped verifier would accept. Failure surfaced only when a
team wired up real verification, with nothing in the payload explaining why.

Three shapes were considered:

1. **A `scheme` enum** (`stripe | github | slack | raw`) — smallest config surface and hardest
   to misconfigure, but every new provider needs an enum value and a release.
2. **`signedPayload` + `signaturePrefix`** — the shape proposed in the issue. Reaches GitHub,
   Slack, bare-digest providers and the existing default, but a *prefix* cannot express
   Stripe's `t=...,v1=...`, so Stripe would have needed a third field later.
3. **`signedPayload` + `signatureTemplate`** — chosen. Same field count as (2), but templating
   the whole header value subsumes the prefix case and reaches Stripe. `digestEncoding` was
   added alongside because Shopify signs base64, and it is a one-line change that is otherwise
   unreachable at any amount of template cleverness.

The container is a Zod **discriminated union on `mode`**, with `"hmac"` as the only member and
injected when absent. Adding `ed25519` or `oidc` later is a new union member reusing
`signedPayload`/`signatureTemplate` verbatim — no second breaking change, and no repeat of the
"one provider's convention baked into the core" mistake in a second mechanism. This also
follows the precedent set in `TIER2.md`, which chose generic `{{ id("order") }}` over
`{{ razorpay.id("order") }}` for the same provider-neutrality reason.

Single-brace placeholders (`{body}`) rather than `{{ body }}` keep the signing namespace
disjoint from the request-template engine, which has already rendered url/body/headers by the
time signing runs.

Defaults reproduce v0.2.x byte-for-byte, so no existing mock config or delivery changes.
```

- [ ] **Step 3: Footnote the S1 claim in `docs/base-in-reality/2026-06-21-audit.md`**

Immediately after the `**Note (non-defect):**` paragraph at line 111, insert:

```markdown

**Superseded 2026-09-04 (see #30):** this claim verified the *signed-payload construction*
against Stripe and found it sound. It did not examine the emitted **header value**, which was
fixed at `{algorithm}={signature}` — GitHub's format, not Stripe's `t=...,v1=...`. The crypto
was correct; the delivered combination matched no single provider. Both axes are configuration
as of the signing-scheme change, and the millisecond-vs-seconds gap noted above is now covered
by `{timestampSeconds}`. Verified by `tests/webhooks/provider-fidelity.test.ts`.
```

- [ ] **Step 4: Verify the docs match the implementation**

Run: `bun test tests/docs`
Expected: PASS. Then read the provider cookbook table beside `tests/webhooks/provider-fidelity.test.ts` and confirm every row's four values appear verbatim in the corresponding test case. A drifted doc table here is the same failure mode as the original bug.

- [ ] **Step 5: Full gate and commit**

```bash
bun run verify
git add docs/
git commit -m "docs(webhooks): document configurable signing schemes

Provider cookbook for GitHub, Slack, Stripe, Shopify and Razorpay, the
placeholder reference, a DECISIONS entry weighing enum vs prefix vs template,
and a footnote correcting the base-in-reality S1 claim, which checked the
signed payload but not the header value.

Refs #30"
```

---

## Verification checklist

Before opening the PR:

- [ ] `bun run verify` passes (lint + typecheck + build + test).
- [ ] `git stash` the branch, run `bun test tests/webhooks` on `main`, unstash — the pre-existing webhook tests pass identically on both.
- [ ] `schema/mock.json` was regenerated by the script, not hand-edited: `git diff --stat schema/mock.json` shows only additive `signing` properties.
- [ ] A mock config written against v0.2.2 (no `mode`, no `signedPayload`) still loads and delivers a `sha256=<hex>` header with a 13-digit `x-mockstar-timestamp`.
- [ ] No new field accepts inline secret material; `tests/webhooks/secret-redaction.test.ts` is green.
