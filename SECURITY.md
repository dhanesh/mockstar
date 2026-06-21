# Security Policy

mockstar is a mock + webhook server for **non-production** environments. This
file is the project's security policy: supported versions, how to report a
vulnerability, and the security posture you can rely on. For the detailed threat
model see [docs/SECURITY.md](./docs/SECURITY.md); for a research-grounded audit of
the security-, crypto-, and reliability-sensitive surfaces see
[docs/base-in-reality/2026-06-21-audit.md](./docs/base-in-reality/2026-06-21-audit.md).

## Supported versions

mockstar is pre-1.0. Security fixes land on the latest `0.x` minor only.

| Version | Supported |
|---|---|
| `0.1.x` (latest minor) | ✅ |
| Older `0.x` | ❌ — upgrade to the latest minor |

Pin `$schema` in every mock file (`https://schemas.mockstar.dev/v0.<N>/mock.json`)
so a minor bump never silently changes mock-file semantics.

## Reporting a vulnerability

Please report security issues **privately** via a
[GitHub security advisory](https://github.com/your-org/mockstar/security/advisories/new).
Do **not** open a public issue for an exploitable primitive.

Public issues are fine for:

- obvious bugs that do not involve an exploitable primitive, and
- documentation errors in the security docs.

We aim to acknowledge a report within a few business days and to ship a fix on
the latest supported minor.

## Security posture

### SSRF (pass-through + webhooks + OpenAPI import)

mockstar shares a hardened URL validator across pass-through routing, webhook
delivery, and OpenAPI `servers.url` import:

- **Scheme allowlist** (`https` only by default; `allowHttp: true` opts a single
  webhook into `http`; `file://` is always rejected).
- **Private-range rejection** of literal RFC-1918 / loopback / link-local IPs.
- **DNS-resolution guard.** After the synchronous string check, the validator
  resolves the hostname (A + AAAA) and rejects if **any** resolved address is
  private/loopback/link-local. It fails closed on resolution error or an empty
  result. This closes the classic "public hostname → `169.254.169.254` metadata
  IP" bypass. It runs at request time for pass-through and per-attempt for
  webhooks.
- **`allowPrivateUpstreams` opt-in** (default **off**). Egress to private targets
  is blocked unless you explicitly enable it — only do so when you trust every
  configured upstream.
- **External OpenAPI `$ref` disabled** — only in-document (`#/...`) refs are
  permitted (addresses CVE-2026-39885-class `$ref` SSRF).

**Residual (documented, accepted for a dev tool):** there is a narrow
DNS-rebinding / TOCTOU window between mockstar's resolution and `fetch()`'s own
resolution. Full closure would require socket-level IP pinning. In hostile-DNS
environments, enumerate upstreams by IP and use a trusted resolver. See audit
finding **F1** (fixed) for detail.

### Admin API authentication

- The admin API (`/__admin/tenants/...`) and `/metrics` are **disabled unless**
  `MOCKSTAR_ADMIN_TOKEN` is set; the default bind is `127.0.0.1`.
- Tokens are compared with `crypto.timingSafeEqual` on length-normalised buffers
  (constant-time).
- Two-tier scope: a **tenant**-scoped token sees only its own tenant's endpoints;
  the **root** token reaches `/metrics`. `/health` and `/ready` are always
  unauthenticated for orchestrator probes.
- In Kubernetes, inject the token from a Secret — never inline. See the
  [Helm deployment guide](./docs/deployment/helm.md#enabling-the-admin-api-with-a-token-secret).

### Webhook signing and secret handling

- Opt-in **HMAC-SHA256** over Stripe's signed-payload construction
  (`HMAC-SHA256(secret, "${timestamp}.${rawBody}")`, hex digest).
- Receivers verify with a constant-time compare and enforce a replay window
  (default 5 minutes). mockstar emits the timestamp header; the receiver enforces
  the window for its own threat model.
- **Secrets are never inline.** `signing.secretRef` must be either
  `{{ env.NAME }}` (read from the environment per delivery) or
  `file:/absolute/path` (read from the filesystem per delivery). Inline string
  secrets are **rejected at config-load** by a Zod refine. Admin responses redact
  signing config to `{ enabled, algorithm }` and never return the secret.
- `X-Mockstar-Webhook-Url` (per-request webhook redirection) is an SSRF amplifier
  and is **off by default**; enable only via `--allow-webhook-url-header` /
  `MOCKSTAR_ALLOW_WEBHOOK_URL_HEADER=1` when a test explicitly needs it.

See audit finding **S1** (verified sound) and **F2** (circuit-breaker half-open
single-probe, fixed).

### Container hardening (Helm / Docker)

The image and Helm chart are secure-by-default:

- runs as **non-root uid 10001**, `runAsNonRoot: true`;
- **read-only root filesystem** (writable paths backed by emptyDir: `/tmp`,
  `/var/run/mockstar`);
- `allowPrivilegeEscalation: false`, **all Linux capabilities dropped**,
  `seccompProfile: RuntimeDefault`;
- `automountServiceAccountToken: false` (the pod makes no Kubernetes API calls);
- admin token injected from a Secret; private upstreams and the webhook-URL
  header both off.

See the [Helm deployment guide](./docs/deployment/helm.md) for the full
deployment posture, NetworkPolicy egress notes, and image-by-digest pinning.

### The `mockstar proxy` / mkcert dev-CA is local-only and experimental

The TLS-intercepting transparent upstream proxy (`mockstar proxy`) installs a
local **mkcert dev-CA** to terminate HTTPS for local development on macOS/Linux.
It is an **experimental, local-only** tool and is **not** part of the Helm
deployment and **not** for clusters or shared/CI hosts where its trust store and
DNS overrides would be inappropriate. The Helm chart deploys the mock + webhook
server only — no MITM CA, no tier1-proxy.

## Known out-of-scope items

These are intentional non-goals (see [docs/SECURITY.md](./docs/SECURITY.md)):

- **Handler sandboxing** — handler code runs with full Bun runtime privileges by
  design. Do not load handlers from untrusted sources.
- **Secret scrubbing in handler-emitted logs** — users must keep secrets out of
  their own handler logs.
- **DNS rebinding** against pass-through targets beyond the resolution guard above
  (run in trusted-DNS environments; pin upstream IPs for hostile DNS).
