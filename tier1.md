# Tier 1 — HTTPS-transparent upstream for local development

## Problem

Mockstar currently serves HTTP on a configurable port (default `:3000`). Real-world
applications integrating with third-party APIs (Razorpay, Stripe, Twilio, etc.)
typically:

1. Pin to an **HTTPS** URL in their SDK or config (e.g. `https://api.razorpay.com`).
2. Rely on the **system trust store** for certificate validation — any non-trusted
   CA causes the request to fail before mockstar ever sees it.
3. Use the SDK's **hardcoded hostname** — there may be no way (or only a
   heavily-guarded code path) to override the base URL.

This means the current workflow ("swap the base URL in dev config") is a
per-application code change and is **impossible with SDKs that don't expose a
base-URL override**. Tier 1 closes that gap: the unmodified application talks
to `https://api.razorpay.com` (or any other real hostname) on the developer's
machine, and the request silently lands in mockstar.

## Outcome

A developer can run one command on their machine that:

- Makes the real hostname (`api.razorpay.com` by default; any list of hostnames
  by configuration) resolve to their local mockstar instance.
- Serves valid HTTPS on port 443 with a certificate the system trusts.
- Forwards the decrypted request to mockstar over plain HTTP.
- Is fully reversible — one command restores normal behavior.

The application code is unchanged. The SDK's hardcoded HTTPS URL works
unmodified. Tests run against realistic response shapes over realistic
transport.

## Scope

### In scope

- **Local development machines only.** macOS + Linux are must-haves. Windows is
  stretch (may or may not fit v1).
- **Any list of hostnames** the developer configures — not Razorpay-specific.
  The same tool mocks `api.razorpay.com`, `api.stripe.com`, `api.twilio.com` in
  parallel without conflicts.
- **TLS termination** with a locally-trusted CA. First run provisions a
  development root CA that the OS trusts; subsequent runs generate per-hostname
  leaf certificates signed by it.
- **Seamless reversal.** Turning the proxy off reverts DNS and restores normal
  outbound HTTPS to the real hosts.
- **Per-developer isolation.** Multiple devs on the same network each run their
  own proxy without interfering with each other.
- **Integration with mockstar's existing tenancy.** The proxy can either
  hard-route all traffic to a single tenant, or map one hostname per tenant.
- **Diagnostics when things go wrong.** Clear error output when a cert isn't
  trusted, hosts entry is missing, mockstar isn't running, etc. Developers
  should not have to read three `tcpdump` outputs to understand why `curl` is
  failing.

### Out of scope

- **Staging / production deployments.** This is a developer-laptop tool. Never
  install the dev CA into a production trust store; never run the proxy
  publicly bound.
- **Legitimate certificates.** No Let's Encrypt; no CA purchasing. The trust
  comes from the dev machine's own CA.
- **Mutual TLS (client cert authentication).** Rare in upstream APIs; defer if
  needed.
- **Protocol emulation beyond TLS.** If an API uses gRPC over HTTP/2 or
  WebSockets, they should work (mockstar supports HTTP/1.1 and Fetch API), but
  a dedicated gRPC framing test is out of scope for v1 of this tier.
- **Traffic recording / MITM debugging.** The proxy *could* log intercepted
  requests; for v1 it's a forwarding-only device. Recording is a future
  enhancement.
- **Anything that requires kernel-level network interception** (PF rules,
  iptables, Windows WFP drivers). `/etc/hosts` edits are the boundary.

## Success criteria

A developer can execute this workflow in under 5 minutes on a fresh machine:

1. Run `make proxy-install` (or equivalent) once.
2. Observe that a root CA has been added to the OS trust store; observe that
   `/etc/hosts` (or equivalent) now maps `api.razorpay.com` to `127.0.0.1`.
3. Start mockstar (e.g. `make dev MOCKS_DIR=/tmp/razorpay-mocks`).
4. In a new terminal, run `curl -v https://api.razorpay.com/v1/customers` and
   receive the mocked response body from the mockstar instance — with `curl`
   reporting a valid TLS handshake against a cert issued to
   `api.razorpay.com`.
5. Run the existing application (Python `razorpay` SDK, Node `razorpay` SDK,
   whatever) against its production configuration unchanged, and observe that
   it successfully parses mock responses.
6. Run `make proxy-off` (or equivalent) and verify that `curl
   https://api.razorpay.com/` now reaches the real Razorpay servers again.

Acceptance tests should cover at minimum:

- `curl --cacert <system>` succeeds against the intercepted hostname without
  `-k` / `--insecure`.
- Node.js with `NODE_TLS_REJECT_UNAUTHORIZED=1` (default) succeeds.
- Python `requests.get()` with default `verify=True` succeeds.
- Multiple hostnames intercepted simultaneously (Razorpay + Stripe) each return
  the correct mock.
- Turning the proxy off and then on again does not re-add duplicate hosts-file
  entries or duplicate CA certs.
- On the uninstall path, the hosts file and CA store return to their
  pre-install state (no residue).

## Known decision points

The implementer (or m1-constrain interview) will need to decide each of the
following. The document records them as open so the manifold phase can surface
tensions and make the choice explicit.

| Decision | Reasonable options | Trade-offs |
|---|---|---|
| **Proxy technology** | (a) Caddy with on-demand TLS + reverse_proxy; (b) `mkcert` + custom Bun HTTPS proxy; (c) `caddy-docker` wrapper; (d) `socat` + static certs | Caddy is fewer moving parts, handles cert generation, well-documented. Custom Bun keeps the stack homogeneous. |
| **Local CA management** | (a) `mkcert` (canonical); (b) Caddy's built-in local CA; (c) generate manually with `openssl`; (d) reuse an existing corporate dev CA | `mkcert` is the industry standard and has `mkcert -install` for trust-store integration. |
| **Hosts-file strategy** | (a) Edit `/etc/hosts` directly (sudo); (b) `dnsmasq` on a dev port; (c) local DNS resolver override (systemd-resolved / macOS `scutil`); (d) dev-only DNS container | `/etc/hosts` is zero-infra and reversible. DNS resolvers survive editor crashes. |
| **Port conflict** | (a) Bind 443 (requires sudo / setcap); (b) bind 4443 (forces URL change — defeats the point); (c) `pfctl` port redirect 443→4443 on macOS | Binding 443 is the only way SDKs with hardcoded URLs work. Sudo prompt is acceptable on install. |
| **Cross-platform coverage for v1** | (a) macOS + Linux only; (b) + Windows (via WSL); (c) + native Windows | Cross-platform requires testing infrastructure. macOS + Linux hits 90% of users. |
| **Per-host mock tenant mapping** | (a) All hosts route to the `default` tenant; (b) each host is its own tenant (`api.razorpay.com` → `razorpay` tenant, `api.stripe.com` → `stripe` tenant); (c) configurable per deployment | Per-host tenant makes the multi-API workflow trivial. Requires the proxy to know about tenancy. |
| **Auth-header preservation** | (a) Forward `Authorization` header untouched; (b) strip it (assumes mock doesn't validate); (c) rewrite it | Forward untouched is simplest; mockstar already ignores auth in matchers unless the user opts in. |
| **Hostnames config format** | (a) Command-line args (`--host api.razorpay.com`); (b) YAML/JSON config file; (c) env var with comma-separated list; (d) all three | Config file scales better past 2-3 hosts. Env var is CI-friendly. |
| **Install / uninstall UX** | (a) `make proxy-install` / `make proxy-off`; (b) `mockstar proxy install` subcommand; (c) standalone `mockstar-proxy` tool; (d) shell script in `scripts/` | Integrating into the mockstar binary is ergonomically cleanest. Standalone tool is simpler to iterate on. |
| **Keeping cert store clean on uninstall** | (a) Track every added cert in a state file and remove only those; (b) remove the whole local dev CA (nukes other tools that share it); (c) leave CA installed, only remove leafs | State file + selective removal preserves other tools' setup. |
| **Per-hostname mock health-check** | (a) Reject proxied requests if mockstar is not responding to `/health`; (b) forward blindly; (c) buffer until mockstar comes up | Reject gives clear error. Blind forwarding means devs see a confusing connection-reset. |
| **Request/response logging** | (a) Silent (rely on mockstar's logs); (b) access log by default; (c) verbose on demand | Mockstar already logs structured JSON; duplication is noise. Verbose-on-demand via `--log` flag is helpful for TLS handshake debugging. |

## Known tensions (for m2-tension)

### TN-A: Convenience vs. system-trust-store invasion

Installing a dev root CA is the single largest security concern in this
feature. It means any process on the machine can generate HTTPS certs that the
OS trusts. Mitigations:
- Scope the CA clearly (name it `mockstar-dev-ca` or similar).
- Document uninstall prominently.
- Refuse to install if the user appears to be on a managed/corporate machine
  (fleet-managed certs detected).
- Never install the CA as part of a CI run.

### TN-B: Hostname hijack vs. live-API fallback

While the proxy is installed, the developer cannot reach the real Razorpay
sandbox or production API at `api.razorpay.com` from this machine — the hosts
entry hijacks everything. Mitigations:
- Provide a bypass flag (`mockstar-proxy bypass` temporarily removes hosts
  entries).
- Support per-hostname pass-through: mock some endpoints, forward others to
  the real upstream (this overlaps with mockstar's T9 pass-through).
- Prominently document the risk in the install output.

### TN-C: v1 scope vs. "proxy is the new mockstar"

A general-purpose HTTPS-intercepting proxy is a significant product surface of
its own (could grow to be bigger than mockstar itself). Keep the v1 scope
narrow: intercept → forward → done. Resist feature creep:
- No traffic recording.
- No request transformation.
- No "mock some, pass-through others" in v1 (defer).
- No multi-dev sharing.

### TN-D: Fast-path latency vs. TLS termination overhead

TLS termination adds handshake latency on first connection and some per-request
overhead. Mockstar's RT-6 budget (p99 < 5 ms) is measured at the HTTP entry
point. The proxy-added latency should be bounded and measurable:
- Target: proxy adds ≤ 2 ms to p99 for a warm connection (handshake is
  amortized after the first request).
- Real connections from SDKs use keep-alive; cold handshakes are the exception.

## References

- [mkcert](https://github.com/FiloSottile/mkcert) — canonical local CA tool.
- [Caddy on-demand TLS](https://caddyserver.com/docs/automatic-https#on-demand-tls)
  — if using Caddy.
- [Razorpay API base URL](https://razorpay.com/docs/api/) — `https://api.razorpay.com`.
- Mockstar constraint `T9` (per-route pass-through) — overlaps with the
  live-API-fallback concern in TN-B.
- Mockstar constraint `S4` (localhost bind by default) — the proxy layer now
  owns the public surface; mockstar itself remains bound to 127.0.0.1.
- Mockstar constraint `S6` (SSRF guard) — re-evaluate: does the proxy change
  the threat model for SSRF-adjacent concerns?
