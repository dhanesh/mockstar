# Webhook security model

Maps to constraints S1–S4, B5, TN5.

## Threat model

Mockstar runs in dev/CI/test fixtures and (occasionally) shared infra (Helm charts, multi-tenant Docker). The webhook feature introduces three external attack surfaces:

| Surface | Risk | Guard |
|---|---|---|
| Outbound HTTP delivery | SSRF (loopback, RFC1918, link-local, cloud metadata) | `validateUpstreamUrl` per attempt (S2) |
| Inbound `X-Mockstar-Webhook-Url` header | Per-request SSRF redirection | Tiered opt-in: server flag + per-route flag (B5, TN5) |
| Signing secret material | Leak via logs, journal, admin response | env/file refs only; rendered before logging (S3, U3) |

## SSRF posture (S2, T6)

Every webhook delivery attempt re-runs URL validation — *every attempt*, not just at config-load. URLs may template per-request, so a one-shot validation at config load doesn't cover header-supplied or template-resolved URLs.

Default rules:

- Schemes: `https` only. `allowHttp: true` per webhook permits `http`. `file://` always rejected, regardless of allowlist.
- Hosts: RFC1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`), CGNAT (`100.64.0.0/10`), and `0.0.0.0/8` all rejected. `allowPrivateNetworks: true` per webhook permits them — the only legitimate use case is SDET fixtures targeting `localhost`.
- IPv4-mapped IPv6 (`::ffff:127.0.0.1` and the WHATWG-normalised `::ffff:7f00:1` form) treated as their IPv4 equivalent for the private-range check. (See `src/features/url-validator.ts:78-90`.)

DNS rebinding is **out of scope** for this version. We resolve once via the platform's DNS at delivery time; if the receiver's DNS swaps to a private IP between resolution and the TLS connection, we don't catch it. Document and accept.

## Header URL channel (B5, TN5)

The `X-Mockstar-Webhook-Url` request header lets tests parameterise the receiver URL per request. Without gating, any inbound request could redirect a webhook to anywhere — textbook SSRF.

Two-tier opt-in:

```bash
mockstar ./mocks --allow-webhook-url-header   # tier 1: server flag, default off
```

```json
{ "id": "wh1", "url": "...", "acceptHeaderOverride": true }   // tier 2: per-route, default true (gated by tier 1)
```

When tier-1 is off, the header is silently ignored even when set on the request. When tier-1 is on, individual routes can opt out via `acceptHeaderOverride: false`. The header value still passes:

1. `validateUpstreamUrl` per webhook's `allowHttp` / `allowPrivateNetworks` flags.
2. The S4 admin-path skip-list (you cannot redirect a webhook to `/_mockstar/*`).

## Admin path skip-list (S4)

Webhooks NEVER fire when the **inbound** request path matches:

- `/_mockstar` and `/_mockstar/*`
- `/__admin` and `/__admin/*`
- `/health`, `/ready`, `/metrics`

Hard-coded in `src/features/webhooks/dispatcher.ts:ADMIN_PATH_PREFIXES`. NOT user-configurable. A too-broad `match.path` (e.g., `/`) would otherwise hook the mock server's own metrics endpoint and explode delivery volume — possibly DoSing the configured receiver via the operator's own monitoring traffic.

## Secret handling (S1, S3, U3, RT-2)

### Source of truth

`signing.secretRef` MUST be one of:

- `{{ env.NAME }}` — read from `process.env[NAME]` per delivery
- `file:/absolute/path` — read from filesystem per delivery (synchronous, trimmed)

**Inline string secrets are rejected at config-load** by Zod refine (S3). The error message names the offending path so misconfigurations fail loud.

### Resolution timing

Secrets are resolved **per delivery attempt**, not at config-load. This means:

- Env-var rotation between deliveries IS picked up (set new value, next delivery uses it).
- File-secret rotation IS picked up (write new file content, next delivery reads it).
- Secrets never exist as long-lived strings in memory (each attempt creates and discards them).

### Redaction

Admin endpoints listing webhook config return `signing: { mode: 'hmac', enabled: bool, algorithm: 'sha256' }` only — never the secretRef value, never the resolved secret. Structured logs render templated URLs and bodies AFTER the rendered value would be sensitive (env-supplied secrets in URLs would appear as raw `{{ env.X }}` in log fields, not as the resolved value).

### HMAC-SHA256 (RT-2)

We use `node:crypto.createHmac('sha256', secret).update(signedPayload).digest(digestEncoding)`. The **default** scheme reproduces Stripe's signed-payload construction (`signedPayload: "{timestamp}.{body}"`, i.e. `${ts}.${body}`) paired with GitHub's prefixed header value (`signatureTemplate: "{algorithm}={signature}"`) — but both axes are configurable per webhook via `signing.signedPayload` and `signing.signatureTemplate`, so the actual bytes signed and the actual header shape depend on the receiver being targeted. See the provider cookbook in `docs/webhooks/README.md` for GitHub, Slack, Stripe, Shopify, and Razorpay's real wire formats. Receivers verify by:

1. Reconstructing the string configured in `signing.signedPayload` (default: `${header.x-mockstar-timestamp}.${rawBody}`).
2. Computing HMAC-SHA256 with the shared secret, encoded per `signing.digestEncoding` (default hex).
3. Comparing against the header named by `signing.signatureHeader` (default `x-mockstar-signature`), whose value shape is `signing.signatureTemplate` (default: strip the `sha256=` prefix), using **constant-time** comparison.
4. Checking `Date.now() - timestamp <= replayWindowMs` (default 5 minutes).

`verifySignature` and `withinReplayWindow` are exported from `src/features/webhooks/signing.ts` for receiver-side test reuse and for our own assertion tests.

## Replay-window enforcement

Mockstar emits the timestamp header; receivers enforce the window. This is correct: only the receiver knows what window is acceptable for its threat model. Default `replayWindowMs: 300_000` (5 min) is documented in the receiver-side example for parity.

## Out of scope

- Mutual TLS to receivers. (Use a sidecar / reverse proxy for that.)
- Automatic secret rotation alarms. (Standard secret-store practices apply.)
- DNS rebinding mitigation. (Resolved at delivery; not re-checked during TLS.)
- IP allowlists per receiver. (Use the receiver's WAF.)
