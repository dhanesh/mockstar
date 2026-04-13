# Security model

> Every claim in this document is backed by a constraint or required-truth in `.manifold/mockstar.md`.

## Threat model

| Asset | Threat | Control |
|---|---|---|
| Tenant mock data | Cross-tenant read via admin token | Two-tier auth: per-tenant token only sees its own tenant (RT-7.1). Root token gets aggregate metrics, not per-request data (RT-7.2). |
| Upstream services reachable from Mockstar | SSRF via crafted pass-through config | Scheme allowlist + private-range rejection (RT-8.1). Applied at config parse and re-applied at request time if templating can alter the URL (RT-8.2). |
| Local cloud metadata / internal services | SSRF via OpenAPI `$ref` | External `$ref` disabled; only in-document (`#/...`) refs permitted (RT-8.3). Addresses [CVE-2026-39885](https://advisories.gitlab.com/pkg/npm/mcp-from-openapi/CVE-2026-39885/). |
| Local filesystem | Path traversal via crafted config | Handlers directory is a hard boundary (T5). OpenAPI path-parameter substitution is URL-encoded (RT-8.4). Addresses [CVE-2026-32871](https://advisories.gitlab.com/pkg/pypi/fastmcp/CVE-2026-32871/). |
| Admin endpoints | Network exposure | Disabled unless `MOCKSTAR_ADMIN_TOKEN` set (S3). Default bind is `127.0.0.1` (S4) — public binding requires explicit config. |
| Admin tokens | Timing side-channel | `crypto.timingSafeEqual` on length-normalised buffers (RT-7.3). |
| Server availability | Handler crash | Three-tier isolation: per-request try/catch + process-level hooks + orchestrator restart (TN2, RT-2, RT-3). |
| Tenant resource exhaustion | Oversized bodies / floods | Per-tenant body-size cap (S5), per-tenant journal bounded at configured size (O3). Per-tenant rate limiting is scoped for v1.1. |

## Out of scope

- **DNS rebinding** against pass-through targets. Mitigation: run Mockstar in environments where DNS is trusted (internal CoreDNS, CI sandboxes); for hostile DNS environments, always enumerate allowed upstreams by IP in tenant config with `allowPrivateUpstreams: true` and a trusted resolver.
- **Handler sandboxing.** Handler code runs with full Bun runtime privileges by design (TN2). Do not load handlers from untrusted sources.
- **Secrets in logs.** Users must ensure handler-emitted logs do not contain secrets; Mockstar does not scrub them.

## Reporting

Security issues: open a private GitHub advisory. Public issues are acceptable for:

- Obvious bugs that do not involve an exploitable primitive
- Documentation errors in this file
