# tier1-https-proxy

## Outcome

A developer can run one command on their machine that:

- Makes a configurable list of real hostnames (default `api.razorpay.com`) resolve to their local mockstar instance.
- Serves valid HTTPS on port 443 with a certificate the system trusts.
- Forwards the decrypted request to mockstar over plain HTTP.
- Is fully reversible — one command restores normal behavior, with no residual CA or hosts-file entries.

The application code is unchanged. The SDK's hardcoded HTTPS URL works unmodified. Tests run against realistic response shapes over realistic transport.

**Source spec:** [`tier1.md`](../tier1.md) — contains full scope, success criteria, 12 known decision points, and 4 pre-identified tensions. `/manifold:m1-constrain` should treat that document as input to the constraint interview.

---

## Constraints

### Business

#### B1: Ships as part of mockstar

Distributed in the same MIT-licensed repository, versioned together, released together. Not a separate package.

> **Rationale:** The proxy consumes mockstar's config (tenant mapping), shares its observability format, and is only useful in combination. Separating would duplicate maintenance cost without gaining anything.

#### B2: v1 platform scope — macOS + Linux only

Windows deferred to v1.1. mkcert and Bun's TLS module are first-class on macOS / Linux; Windows CertUtil + LocalMachine/Root trust semantics + UAC integration is a separate effort.

> **Rationale:** Covers ~90% of developer laptops. Cross-platform trust-store automation is a minefield; shipping poorly on Windows damages credibility for the feature across all platforms.

#### B3: v1 scope explicitly excludes

Traffic recording (could be a v2 feature), mutual TLS (rare in upstream APIs), request transformation (different product altogether), and production deployment (this is a dev-laptop tool, never for prod).

> **Rationale:** Pre-mortem lesson from mockstar core's v1 scope discipline — narrow v1 ships; wide v1 doesn't.

---

### Technical

#### T1: Custom Bun HTTPS proxy (not Caddy / nginx)

Implemented in `src/features/proxy/` using `Bun.serve({ tls: ... })` primitives. Composes with mockstar's existing HTTP path.

> **Rationale:** Keeps the stack homogeneous — one binary, one runtime, one observability story. Cost is ~200 LOC of TLS/SNI/cert-on-demand + dnsmasq integration. Pre-mortem PM1-A acknowledges this is the largest scope risk; mitigated by strict test coverage (see O3/O4) and Bun version pinning (T12).

#### T2: Local CA managed by mkcert

`mockstar proxy install` invokes `mkcert -install` to create and trust a per-developer CA. `rootCA-key.pem` is read by the proxy at start to sign leaf certs; never logged, never exposed over any network interface, file permissions enforced at 0600.

> **Rationale:** mkcert is the industry-standard local-CA tool with well-tested macOS Keychain + Linux NSS + Firefox + Java integration. Reinventing this is a multi-month project; wrapping mkcert is an afternoon.

#### T3: Leaf certificates issued on-demand per hostname

When a TLS handshake arrives with SNI = configured hostname, the proxy generates a leaf cert signed by the mkcert CA (in-memory, via Bun's crypto primitives or a shelled-out `mkcert <host>` call), caches it, and proceeds with the handshake.

> **Rationale:** No upfront list of every possible hostname. Add a new mock target → just edit config → next request works. Mirrors Caddy's on-demand TLS pattern.

#### T4: SNI-gated cert issuance

Incoming handshakes whose SNI is not in the current config's `hosts` list receive a TLS `unrecognized_name` alert and connection close. No cert is ever generated for an unknown hostname.

> **Rationale:** Prevents SNI-flood resource exhaustion (addressed in S3) and prevents accidental MITM of non-mocked services. The config is the explicit, bounded allowlist.

#### T5: Atomic cert-cache invalidation on config reload

When the config file changes, the proxy builds a new hostname→cert map in memory, atomically swaps the active map, and closes any TLS sessions associated with evicted hostnames (preventing stale-resumption — see O5).

> **Rationale:** Pre-mortem PM2-D: hot-reload + stale cert cache → intermittent test failures. Atomic swap + session invalidation is the only way to keep consistency guarantees with a dynamic hostname list.

#### T6: DNS resolution via dnsmasq

On install, the proxy installs dnsmasq (Homebrew on macOS; native package on Linux) listening on `127.0.0.1:53`, with all `hosts` entries configured as static responses and all other queries forwarded to the system's real resolvers. macOS uses `/etc/resolver/<host>.conf` files to scope dnsmasq to specific hostnames; Linux uses systemd-resolved's per-link DNS configuration.

> **Rationale:** `/etc/hosts` edits work but don't survive wildcard or subdomain cases cleanly. dnsmasq is the canonical dev DNS tool. Pre-mortem PM1-B acknowledges this is a fragility source; mitigated by U5 (install-time environment detection) and U1 (atomic install / rollback).

#### T7: Port 443 binding via OS capability grants

On install: Linux uses `setcap cap_net_bind_service=+ep` on the mockstar binary; macOS uses `launchd` with `Sockets` entry so the service inherits port 443 from launchd. No sudo required at `mockstar proxy start` time — only at install.

> **Rationale:** Running the proxy as root is a security regression. Install-time capability grant preserves least-privilege at runtime.

#### T8: Config reload watches config file + invalidates caches

Config path (`~/.mockstar/proxy.json` or similar) is watched via `fs.watch` or Bun's equivalent. Changes trigger atomic reload of hostname list + cert cache (T5) + dnsmasq rewrite + HUP signal to dnsmasq.

> **Rationale:** Dev loop: edit config → add new hostname → next request routes correctly. No restart needed for everyday work.

#### T9: Header passthrough (including Authorization)

All request headers except hop-by-hop (`Host`, `Connection`, `Proxy-*`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`) are forwarded verbatim to mockstar. Authorization headers reach the mock unchanged so mocks that opt into auth-matching can discriminate.

> **Rationale:** Zero-config for the 99% case. Mockstar matchers ignore Authorization by default; explicit opt-in when testing auth failure paths.

#### T10: 502 with diagnostic body when mockstar unreachable

If the upstream connection fails (`ECONNREFUSED`, `ETIMEDOUT` after configurable timeout), the proxy responds with HTTP 502 and a JSON body: `{error: "mockstar_unreachable", upstream, cause, hint: "run 'make dev' or check mockstar logs"}`.

> **Rationale:** Debugging a raw connection reset from inside an SDK is the exact pain this tier is supposed to eliminate.

#### T11: Integrated as `mockstar proxy` CLI subcommand

`mockstar proxy install | start | uninstall | status | reload`. Lives alongside `mockstar serve` and `mockstar import` in the existing CLI. Source in `src/features/proxy/cli.ts`.

> **Rationale:** One binary, one mental model. Users who already run `bunx mockstar` learn two new subcommands; that's it.

#### T12: Minimum Bun version pinned; TLS API dependencies documented

`package.json` `engines.bun` declares a minimum (e.g. `>=1.3.11`). CHANGELOG documents which Bun TLS APIs are in use (`Bun.serve` with tls, `Bun.file` for cert loading, native `tls.createSecureContext` if used). CI matrix tests min + latest Bun to catch breakage early.

> **Rationale:** Pre-mortem PM3-A: Bun TLS module upgrades break custom proxies. Explicit contract + CI matrix catches this one release ahead of users.

---

### User Experience

#### U1: Install is atomic — all-or-nothing

`mockstar proxy install` records each mutation (hosts entries, resolver files, launchd/systemd units, CA trust entries) to `~/.mockstar/install-state.json`. On any step failure, previously-successful steps are reverted.

> **Rationale:** Partial installs are the worst state — some DNS working, some not, users don't know what's installed. Atomic rollback is how disk partitioning tools work; should be how this works.

#### U2: Uninstall leaves zero residue

`mockstar proxy uninstall` reads `install-state.json` and reverses every recorded mutation: `mkcert -uninstall`, remove `/etc/resolver/<host>.conf`, stop + remove launchd plist, revert dnsmasq config. After uninstall, `sudo grep mockstar /etc/hosts /etc/resolver/` returns empty.

> **Rationale:** Developers try mockstar, evaluate, remove. Clean uninstall is the minimum contract. Without it, word-of-mouth kills the product.

#### U3: Status command reports subsystem health

`mockstar proxy status` lists: CA installed (y/n); dnsmasq running (y/n); resolver entries present (list); mockstar reachable at :3000 (y/n); cert cache utilisation (current / max); last 10 proxied requests summary.

> **Rationale:** Single pane of glass when things go wrong. No `ps`, `dig`, `curl`, `ls /etc/resolver` ritual.

#### U4: Node.js gotcha prominently surfaced at install

Install output includes a highlighted block: `Node.js applications require NODE_EXTRA_CA_CERTS=<path> in their environment. Run: echo 'export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"' >> ~/.zshrc (or your shell rc)`.

> **Rationale:** Node.js ignores the system trust store. This is the single most-documented gotcha from the domain context lookup ([mkcert README](https://github.com/FiloSottile/mkcert)). Any Razorpay-Node-SDK user would silently hit this. Treating it as a default install step turns a future support ticket into a one-line copy-paste.

#### U5: Install aborts with remediation on environment hostility

Before any mutation, install checks for: managed MDM profile detected, active VPN rewriting `/etc/resolver`, port 443 already bound by another process, running inside CI (`CI=true`, container-ish env vars). Any hit aborts with a specific message: *"Managed MDM detected (source: profiles.plist). Installing a local CA may conflict with corporate policy. To proceed anyway: --force. To diagnose: mockstar proxy status --preinstall."*

> **Rationale:** Pre-mortem PM1-B: dnsmasq is environment-specific; every dev's laptop breaks differently. Detect, don't silently fail.

#### U6: `mockstar proxy start` boot time ≤ 200 ms

From `start` invocation to "ready to accept TLS connections" must be under 200 ms on any supported platform. Measured by install-time benchmark.

> **Rationale:** Mockstar proper has a 200 ms boot SLO (T4 in the mockstar manifold). The proxy front-end should not meaningfully regress that — otherwise the ergonomic promise of mockstar (fast CI boot) is compromised.

**Threshold:** `kind: deterministic, ceiling: 200ms`

---

### Security

#### S1: rootCA-key.pem is privileged — never logged, never networked, 0600

The private key loaded by the proxy to sign leaf certs is opened with `O_RDONLY`; its contents never written to log streams, never echoed to stderr, never sent over any socket. File permissions are enforced at load time (refuse to start if readable by others).

> **Rationale:** Compromise of this key = arbitrary MITM on the dev's machine. It's the single most sensitive artifact. Treat like a TLS private key in production — because that's what it is.

#### S2: 127.0.0.1 bind only; 0.0.0.0 refused

The proxy refuses a `--host 0.0.0.0` flag or any external-interface binding. The dev CA trust is scoped to the dev machine — a publicly-reachable instance of this proxy is a remote MITM vector.

> **Rationale:** A misconfigured proxy serving the same dev CA certs to remote clients would allow arbitrary HTTPS interception of traffic routed through it. Hard refusal is safer than documentation.

#### S3: Cert cache bounded; SNI exhaustion impossible

Cache capacity = `len(config.hosts)`. SNIs outside that list are rejected at handshake (T4) — no cert generation happens. Cache key is the hostname string; eviction is on config-reload drop, not LRU on a size-bounded queue.

> **Rationale:** Without this, a client opening connections with random SNIs could drive unbounded cert generation, consuming CPU (crypto) and memory. Bound the cache at the config level and the attack surface is closed.

#### S4: Install refuses in CI/CD environments

If `CI=true`, `GITHUB_ACTIONS=true`, `CIRCLECI=true`, or container-like indicators are present, install aborts. The dev CA is never installed into a managed fleet trust store.

> **Rationale:** The proxy is a laptop tool. Pushing a dev CA into a CI runner's trust store creates supply-chain vectors: any test could issue certs that CI-hosted tools would trust. Refuse at install time.

#### S5: CA name identifies owner + machine

mkcert CA's Common Name: `mockstar-dev-ca-<user>@<hostname>`. Uninstallation guidance in `status` output tells the user exactly which CA to remove if they've lost state.

> **Rationale:** If the state file is lost or corrupted, the user still needs a way to identify + remove the dev CA. Self-identifying CA is the minimum recovery contract.

---

### Operational

#### O1: Structured JSON logs per request (mockstar format)

One JSON line per request on stdout: `{ts, level, event: "proxy_request", host, method, path, status, duration_us, tenant, requestId, upstreamDurationUs}`. Uses mockstar's existing `StructuredLogger` class.

> **Rationale:** The developer sees proxy + mockstar events in a single stream. Correlate handshake, proxy routing, and mock match via `requestId`.

#### O2: Prometheus metrics at `/proxy/metrics`

Metrics exposed (under admin auth if mockstar admin is enabled — reuses S3 mechanism from the mockstar manifold): `mockstar_proxy_requests_total{host,tenant,status}`, TLS handshake duration histogram, `mockstar_proxy_cert_cache_size{state="issued|evicted"}`, upstream error count, upstream-unreachable count.

> **Rationale:** Observability parity with mockstar's O2. Same Prometheus, same dashboard.

#### O3: Warm-path overhead ≤ 2 ms above mockstar native p99

For a warm TLS connection (keep-alive, cert cached), the proxy's added latency at p99 must not exceed 2 ms compared to hitting mockstar's HTTP interface directly. Measured in bench.

> **Rationale:** RT-6 in mockstar sets p99 < 5 ms. The proxy must not eat that budget. 2 ms headroom gives us TLS decrypt + header rewrite + upstream round-trip — tight but achievable for a custom Bun proxy.

**Threshold:** `kind: statistical, p99: 2ms overhead vs mockstar native`

#### O4: First handshake per hostname ≤ 100 ms

Leaf cert generation + TLS negotiation for the first request against a newly-configured hostname completes within 100 ms at p99. Cached handshakes (subsequent requests) should be sub-ms.

> **Rationale:** Caddy's on-demand TLS takes 5–30 s because it does ACME challenges. We don't — we just sign a leaf with a local CA. 100 ms is generous for an RSA-or-EC sign operation; catches regressions early.

**Threshold:** `kind: statistical, p99: 100ms first-handshake-per-hostname`

#### O5: TLS session invalidation on cert-cache eviction

When a hostname's cert is evicted (either via config reload dropping the hostname or manual cache clear), all TLS sessions associated with that cert have their keep-alive connections closed and `session_ticket` entries invalidated so no resumption can use a stale cert.

> **Rationale:** Pre-mortem PM2-D: session resumption with a now-evicted cert produces mysterious TLS errors that devs can't diagnose. Active invalidation closes the window.

#### O6: Install actions audit log at `~/.mockstar/install.log`

Every mutation in install / uninstall flows appends to a human-readable audit log with timestamp + action + status + reverse-command. Survives reboots; useful for post-hoc forensics when install broke something.

> **Rationale:** Pre-mortem PM1-B: MDM silently reverts edits; users can't explain what happened. Audit log is the forensic trail.

---

## Tensions

### TN1: Custom Bun proxy vs Bun TLS ecosystem churn

**Between:** T1 (custom Bun HTTPS proxy) ↔ T12 (Bun version pinning for TLS API stability)

Bun's TLS module is the highest-velocity part of Bun. New runtime versions ship breaking changes quarterly in 2026 (session tickets, ALPN handling, cert loading APIs). Writing a custom proxy against these APIs carries real upgrade burden. Pre-mortem PM3-A pinpointed this as a real failure mode.

**TRIZ classification:** Technical contradiction — Simplicity vs. Capability. Principles P1 (Segmentation) + P15 (Dynamization).

> **Resolution:** (A) Thin TLS-adapter layer + pinned Bun version + CI matrix.
>
> Every Bun-TLS-specific call lives in `src/features/proxy/tls-adapter.ts` — a small module (≤150 LOC) that exposes a stable internal interface. The rest of the proxy depends on the adapter, not on Bun's TLS API directly. `package.json` declares `engines.bun >= X.Y.Z`. CI matrix tests minimum + latest Bun on every commit. If Bun breaks us, the blast radius is the adapter file.
>
> **Propagation:** T1 LOOSENED (narrower scope), T12 LOOSENED (three defense layers). SAFE.

---

### TN2: dnsmasq DNS strategy vs environment hostility

**Between:** T6 (dnsmasq-based DNS resolution) ↔ U5 (env-hostility detection aborts install)

Pre-mortem PM1-B called this out: corporate MDM, VPN-installed DNS overrides, and resolver-rewriting privacy tools all fight dnsmasq setup in different ways. A strict dnsmasq-only install refuses too many users; a fully permissive install breaks silently.

**TRIZ classification:** Technical contradiction — Standardisation vs. Flexibility. Principle P3 (Local quality — different strategy per context).

> **Resolution:** (A) dnsmasq primary; `/etc/hosts` automatic fallback when environment hostility detected.
>
> Install-time detection picks the strategy. Clean environments → dnsmasq (reboot-persistent, per-hostname scoping). Hostile environments → `/etc/hosts` (fewer moving parts, lower blast radius if MDM re-asserts). `mockstar proxy status` reports which DNS mode is active so users can diagnose quickly.
>
> **Propagation:** T6 LOOSENED (fallback path exists); U5 TIGHTENED (detection logic is now decision-tree, not binary abort); U1 TIGHTENED (rollback handles two DNS strategies). PROCEED WITH AWARENESS — install code path roughly doubles for DNS.

---

### TN3: Atomic install vs platform-specific install-step count

**Between:** U1 (atomic install — all-or-nothing rollback) ↔ T6, T7 (5+ platform-specific mutations per install)

The install flow touches: system trust store (mkcert), dnsmasq config, `/etc/resolver/*.conf` or systemd-resolved, port-443 capability grant, state file creation. Each is platform-specific. Atomic rollback across all of them — when step 4 of 5 fails — is non-trivial.

**TRIZ classification:** Approximate (nearest: Simplicity vs Capability applied to install complexity). Principle P11 (Beforehand cushioning — journal every mutation before making it).

> **Resolution:** (A) Step-journaled install + idempotent reverse functions.
>
> `~/.mockstar/install-state.json` is an append-only journal. Before every mutation, append `{step, action, reverse_command, timestamp}`. Execute the mutation. On any failure → read the journal LIFO, execute `reverse_command` for each completed step. All reverse functions are idempotent (safe to re-run, no-op if already reversed). Corruption of `install-state.json` is an explicit error with a manual-recovery doc link.
>
> **Propagation:** U1 TIGHTENED (journal integrity is now critical — corruption breaks rollback; must be checksummed + append-only-verified); O6 LOOSENED (audit log falls out of the journal naturally). SAFE.

---

### TN4: Dev-CA convenience vs security blast radius

**Between:** T2 (mkcert-managed local CA installed in system trust store) ↔ S1 (rootCA-key.pem is privileged)

Installing any CA in the system trust store is a significant security surface. Pre-mortem PM2-A: if a laptop is compromised and our CA is exfiltrated, the attacker gains full-trust MITM capability for every HTTPS connection from that machine.

**TRIZ classification:** **Physical contradiction** — the CA must be trusted (to fulfil the feature) AND not-trusted (to limit damage on compromise). Principles P1 (Segmentation via scoped naming + scope), P10 (Prior action via short-lived leaves), P24 (Intermediary — OS trust store is an intermediary we can revoke through).

> **Resolution:** (A) Scoped CA + short-lived leaves + clean uninstall.
>
> CA Common Name = `mockstar-dev-ca-<user>@<hostname>` — self-identifying so users can spot it in Keychain/NSS. Leaf certificates have 24-hour `NotAfter` — even a leaked leaf expires within a day. `install-state.json` tracks exactly what was added so `mockstar proxy uninstall` is surgical. Documentation prominently states: *"if you suspect your laptop is compromised, run `mockstar proxy uninstall` FIRST, then escalate to your security team."*
>
> **Propagation:** T3 TIGHTENED (leaf issuance must stamp 24h TTL); O4 TIGHTENED (cert generation adds TTL calculation); S1 LOOSENED (shorter window for leaked leaves); S5 LOOSENED (self-ID + short TTL combine). SAFE.
>
> **Failure cascade** (GAP-06):
> - **Tier 1** — leaf cert leaks (cached in memory, disk swap): 24h TTL invalidates it automatically. ✓
> - **Tier 2** — rootCA-key.pem exfiltrated (attacker can sign new leaves): `mockstar proxy uninstall` → `mkcert -uninstall` → all signed certs become untrusted system-wide. ✓
> - **Tier 3** — undetected compromise (user unaware for days/weeks): **ACCEPT-LOSS with human intervention**. A compromised laptop has many other MITM vectors; adding one local CA does not meaningfully change the threat model. Documentation + runbook instruct: uninstall first, escalate to security team.

---

### TN5: Config hot-reload vs in-flight TLS sessions

**Between:** T8 (file-watch config reload) ↔ T5 (atomic cert cache swap) + O5 (session invalidation on eviction)

When the config removes a hostname, there may be active TLS keep-alive connections that negotiated against the old cert. Session resumption against a now-evicted cert produces opaque TLS errors (pre-mortem PM2-D). Invalidation sequencing must be provably correct.

**TRIZ classification:** Technical contradiction — Speed vs. Correctness. Principles P10 (Prior action — precompute new snapshot), P11 (Beforehand cushioning — force-close before reload completes), P25 (Self-service — sessions self-invalidate via version mismatch).

> **Resolution:** (A) Versioned snapshot + forced close on evicted hostnames, keep-alive on unchanged.
>
> Each config snapshot carries a monotonic `version`. Every active TLS session is tagged with its originating snapshot version. On reload: build new snapshot (including new cert map) in memory, pointer-swap atomically, then walk active sessions — force-close any whose hostname was removed or whose cert changed; keep-alive continues on unchanged hostnames. No blocking wait; no ambiguous resumption.
>
> **Propagation:** T5 TIGHTENED (version tagging required on both cache entries and session records); O5 LOOSENED (active invalidation replaces passive); T8 LOOSENED (reload algorithm fully specified). SAFE.

---

### TN6: Leaf-cert issuance requires CA (structural)

**Between:** T2 (mkcert CA setup) ← T3 (leaf cert on-demand issuance)

T3 cannot sign leaves without T2's `rootCA.pem` / `rootCA-key.pem` being present and readable. This is a hard sequencing dependency, not a trade-off. Recorded in `blocking_dependencies` so m3-anchor prioritises T2-derived Required Truths.

> **Resolution:** (sequencing) T2 is a blocking prerequisite for T3. Proxy startup must fail-fast with a clear error if the CA files are absent/unreadable.
>
> **Propagation:** T3 TIGHTENED (formal prerequisite recorded). SAFE.

---

### TN7: Config hot-reload requires atomic cache-swap primitive (structural)

**Between:** T5 (atomic cert-cache swap) ← T8 (file-watch config reload)

T8's reload flow composes on top of T5's atomic swap primitive. Implementing T8 before T5 is in place produces a half-finished reload mechanism. Recorded in `blocking_dependencies`.

> **Resolution:** (sequencing) T5 is a blocking prerequisite for T8. Build order matters: the atomic snapshot + swap primitive first, the file-watcher on top.
>
> **Propagation:** T8 TIGHTENED (formal prerequisite recorded). SAFE.

---

## Required Truths

For the outcome — *"one command makes HTTPS traffic to real hostnames transparently reach local mockstar with valid TLS, fully reversibly"* — the following must be true. Backward-derived from 32 constraints + 7 resolved tensions + 2 blocking_dependencies. Depth-2 decomposition.

### RT-1: Local CA is installed in the OS trust store and accessible to the proxy *(BINDING CONSTRAINT)*

The foundation of the entire feature. Every TLS handshake, every leaf cert, every SDK-level cert verification depends on this being in place.

**Maps to:** T2, U4, S1, TN6

- **RT-1.1** — `mkcert` is installable via a one-line command on macOS (`brew install mkcert`) and on Debian/RHEL/Arch Linux (`apt/dnf/pacman` + `libnss3-tools` equivalent).
- **RT-1.2** — `mkcert -install` modifies the OS trust store (macOS Keychain, Linux NSS, Firefox, Java) and is reversible via `mkcert -uninstall`. mkcert handles this; we wrap.
- **RT-1.3** — `$(mkcert -CAROOT)/rootCA-key.pem` exists with 0600 permissions. Load-time check: refuse to start if readable by others.
- **RT-1.4** — Proxy reads `rootCA-key.pem` at start; if absent or non-0600, fail-fast with a clear error pointing at `mockstar proxy install`.
- **RT-1.5** — Node.js `NODE_EXTRA_CA_CERTS` requirement is surfaced prominently in install output (not a footnote). Any Razorpay-on-Node user hits this immediately without it.

---

### RT-2: TLS adapter layer isolates Bun TLS API surface

Every Bun-TLS-specific call (handshake init, cert loading, SNI callback, session tickets) lives in one module. The rest of the proxy depends on a stable internal interface.

**Maps to:** T1, T12, TN1

- **RT-2.1** — `src/features/proxy/tls-adapter.ts` exists and is the only file importing Bun-TLS APIs (grep-enforceable).
- **RT-2.2** — Adapter exposes a stable internal interface (connection acceptor, cert-callback signature, session-record type). Consumers depend on these types, not Bun's.
- **RT-2.3** — `package.json` declares `engines.bun >= X.Y.Z` (minimum known-good version). CHANGELOG documents which Bun APIs are in use.
- **RT-2.4** — CI matrix tests minimum + latest Bun on every commit. Failures on minimum = release-blocking; failures on latest = tracking ticket.

---

### RT-3: SNI-to-hostname allowlist is the exclusive cert-issuance gate

No cert is ever generated for a hostname not in `config.hosts`. This is the architectural property that closes the SNI-exhaustion DoS.

**Maps to:** T3, T4, S3

- **RT-3.1** — Config file declares `hosts: [...]` as the exhaustive allowed set. No wildcards in v1.
- **RT-3.2** — TLS handshake's SNI callback checks the incoming hostname against the active snapshot's allowlist. Unknown SNI → `unrecognized_name` TLS alert + connection close. No cert generation, no CPU work, no memory allocation.
- **RT-3.3** — Leaf cert cache capacity = `len(config.hosts)`. Cannot grow beyond config. Constant memory footprint.

---

### RT-4: Leaf certs have 24h TTL; cache uses versioned snapshots with atomic swap and forced-close eviction *(structural prerequisite — per TN7)*

Heart of the runtime correctness guarantees. Addresses both TN4 (security: short-lived leaves) and TN5 (correctness: atomic reload without stale-session bugs).

**Maps to:** T3, T5, T8, O5, TN4, TN5, TN7

- **RT-4.1** — Leaf cert `NotAfter` is 24h after `NotBefore`. Verified by parsing the cert in a test.
- **RT-4.2** — Cert cache uses a monotonic snapshot version. Pointer-swap on config reload is atomic from the TLS handshake's perspective (captured once per connection, retained for the connection's lifetime).
- **RT-4.3** — On reload: after atomic swap, walk active sessions and force-close any whose hostname was removed from `hosts` or whose cert fingerprint changed. Prevents stale-resumption (PM2-D).
- **RT-4.4** — Sessions on unchanged hostnames survive the reload uninterrupted. Keep-alive connections aren't needlessly torn down.

---

### RT-5: DNS strategy detects environment hostility and picks dnsmasq or /etc/hosts

Clean envs get full-feature dnsmasq; hostile envs get lower-blast-radius hosts-file mode. Either way, one command installs and reverses.

**Maps to:** T6, U5, TN2

- **RT-5.1** — Environment detection returns one of: `clean`, `mdm-managed`, `vpn-resolver-override`, `containerized-or-ci`, `port-443-bound`.
- **RT-5.2** — `clean` → install dnsmasq on 127.0.0.1:53; write `/etc/resolver/<host>.conf` per hostname (macOS) or configure systemd-resolved per-link DNS (Linux).
- **RT-5.3** — Hostile but installable → fall back to `/etc/hosts` with degraded feature set (no wildcards, per-hostname only). Install output clearly states: "Using fallback mode due to: <reason>. Some features limited."
- **RT-5.4** — `containerized-or-ci` → abort install with specific message. S4 refusal.
- **RT-5.5** — `mockstar proxy status` reports active DNS mode and cited reason.

---

### RT-6: Port 443 binding uses OS-level capability grants at install time

No sudo during daily `mockstar proxy start`. Privilege is confined to the one-time install.

**Maps to:** T7

- **RT-6.1** — Linux: `sudo setcap cap_net_bind_service=+ep /path/to/mockstar-binary` executed by install, recorded in `install-state.json`.
- **RT-6.2** — macOS: `launchd` plist with `Sockets` entry + `UserName`/`GroupName` keys. The launch daemon inherits the privileged fd and passes it to mockstar. Plist is installed by `mockstar proxy install`.
- **RT-6.3** — `mockstar proxy start` runs unprivileged in steady state. Only `install` and `uninstall` trigger sudo prompts.

---

### RT-7: Install is append-only-journaled and LIFO-reversible

The "clean uninstall" promise rests on this. Install-state.json is the forensic + rollback source of truth.

**Maps to:** U1, U2, O6, TN3

- **RT-7.1** — Before every mutation, append `{step, action, reverse_command, timestamp, checksum}` to `~/.mockstar/install-state.json`. Mutation only proceeds after the journal is fsynced.
- **RT-7.2** — Journal is append-only + per-line-checksummed. Corruption detectable via checksum mismatch on read.
- **RT-7.3** — `mockstar proxy uninstall` reads journal LIFO, executes each `reverse_command`, and marks the step as reversed. Final step removes the journal file.
- **RT-7.4** — Reverse functions are idempotent (safe to re-run). Unit test: run uninstall twice; second is a no-op.
- **RT-7.5** — Corrupt journal → explicit error with manual-recovery doc link (`docs/PROXY-RECOVERY.md`). Never silently delete mutations the journal describes.

---

### RT-8: Mockstar upstream health is checked; upstream-unreachable produces diagnostic 502

Dev ergonomics — turn "connection reset by peer" into "run `make dev` to start mockstar".

**Maps to:** T10

- **RT-8.1** — On proxy start, a one-shot TCP probe against `127.0.0.1:3000/health` runs; failure emits a warning but doesn't block start (mockstar may come up after the proxy).
- **RT-8.2** — Per-request upstream errors (`ECONNREFUSED`, `ETIMEDOUT`) produce HTTP 502 with JSON body: `{error: "mockstar_unreachable", upstream, cause, hint}`. No stack trace leaked to client.
- **RT-8.3** — Upstream connection timeout is configurable (default 5 s); separate from keep-alive timeout.

---

### RT-9: Observability reuses mockstar's StructuredLogger and Metrics classes

Unified observability. Developers see proxy + mock events in one stdout stream, correlated by `requestId`.

**Maps to:** O1, O2

- **RT-9.1** — Proxy imports mockstar's `StructuredLogger` (same module path). Log line JSON shape byte-identical to mockstar's.
- **RT-9.2** — Proxy Prometheus metrics use the same label conventions (tenant, status, method). Named `mockstar_proxy_*_*` to distinguish from `mockstar_*_*`.
- **RT-9.3** — Single stdout stream. `requestId` flows from proxy → mockstar for cross-component tracing.
- **RT-9.4** — `/proxy/metrics` endpoint uses mockstar's admin auth middleware (two-tier token scheme from the mockstar manifold, S3).

---

### RT-10: Install detects environment hostility with remediation-specific errors

Every detected failure mode has a distinct, actionable error message. No "install failed — unknown reason".

**Maps to:** U5, S4, O6

- **RT-10.1** — Detectors for: MDM profile (macOS `profiles` CLI), VPN resolver override (inspect current `/etc/resolv.conf` + `scutil --dns`), port 443 already bound (`lsof -i :443`), CI=true / container env vars.
- **RT-10.2** — Each detection hit maps to a specific remediation message (e.g., "Managed MDM detected — installing a dev CA may conflict with corporate policy. Workarounds: (a) use /etc/hosts fallback mode, (b) coordinate with IT to whitelist mockstar-dev-ca").
- **RT-10.3** — `--force` flag overrides all detectors with an explicit loud warning block. Default is refuse-on-hostility.

---

### RT-11: Benchmark harness validates startup, first-handshake, and warm-request budgets *(NOT_SATISFIED until built)*

RT-11 is the enforcement mechanism for U6, O3, O4. Without it, those constraints are aspirational.

**Maps to:** U6, O3, O4

- **RT-11.1** — Harness measures `mockstar proxy start` → ready time (≤ 200 ms target). **NOT_SATISFIED** — needs to be built.
- **RT-11.2** — Harness measures first-handshake-per-hostname latency (≤ 100 ms p99 target). **NOT_SATISFIED.**
- **RT-11.3** — Harness measures warm-request overhead vs direct HTTP (≤ 2 ms p99 delta vs mockstar native). **NOT_SATISFIED.**
- **RT-11.4** — CI gate fails build on regression beyond thresholds. Adapt existing mockstar `bench/harness.ts` patterns.

---

### RT-12: v1 scope + Node.js gotcha + uninstall-first protocol are documented and discoverable

Documentation is load-bearing: the feature has two big gotchas (Node TLS behavior, compromised-laptop protocol) that need to be impossible to miss.

**Maps to:** B2, B3, U4

- **RT-12.1** — CHANGELOG lists v1 features and explicitly-deferred v1.1 items (Windows native, traffic recording, mTLS, request transformation, production use).
- **RT-12.2** — `docs/PROXY.md` covers: install flow, Node.js `NODE_EXTRA_CA_CERTS` requirement (with copy-paste snippet), DNS mode selection, status command reference.
- **RT-12.3** — Security note documents the dev-CA blast-radius + uninstall-first protocol per TN4 cascade tier 3: *"If laptop is suspected compromised, run `mockstar proxy uninstall` FIRST, then escalate to your security team."*

---

## Binding Constraint

**RT-1 — Local CA is installed in the OS trust store and accessible to the proxy.**

This is the foundation of the entire feature. Every TLS handshake assumes the CA is trusted; every cert-signing operation assumes `rootCA-key.pem` is readable; every SDK-level cert verification assumes the dev CA chain is in the OS trust store. If RT-1 fails, nothing about this feature works — the proxy starts but can't produce any valid response to an HTTPS client.

**Dependency chain:**
- RT-2 (TLS adapter) loads `rootCA-key.pem` from RT-1's filesystem artifacts.
- RT-3 (SNI gate) issues leaves signed by RT-1's CA.
- RT-4 (cert cache) caches RT-1-signed leaves.
- RT-5, RT-6, RT-7 are install-phase siblings but none produce a working proxy without RT-1.

**m4 handoff:** RT-1 artifacts must be generated first in phase 1. Every RT that depends on RT-1 must include a pre-flight check that RT-1's artifacts are present.

**Structural prerequisite (secondary):** RT-4 per TN7. Within phase 2, the atomic cert-cache swap (T5 in the constraint set) must land before the config file-watcher (T8) is armed. Otherwise reloads have no safe substrate.

---

## Solution Space

### Option A: Infrastructure-first, three-phase build ← **Recommended**

- **Reversibility:** TWO_WAY
- **Satisfies:** All 12 RTs through sequenced implementation. Addresses RT-1 (binding) first. Respects both blocking_dependencies (T2→T3 across phases 1-2; T5→T8 within phase 2).
- **Complexity:** Medium. Concrete phase boundaries prevent scope creep.

**Phase 1 (install-path foundation, ~3-4 days):**
- RT-1 mkcert wrapper + CA install + rootCA-key.pem load path
- RT-2 TLS adapter layer (Bun.serve tls facade)
- RT-6 Port 443 capability grant (setcap / launchd plist)
- RT-7 Install journal (append-only state file + idempotent reverse functions)

**Phase 2 (request-path runtime, ~4-5 days):**
- RT-3 SNI allowlist gate
- RT-4 Cert cache with versioned snapshots + atomic swap + forced-close eviction
- RT-5 DNS strategy (dnsmasq primary + /etc/hosts fallback + env detection)
- RT-8 Mockstar upstream health + diagnostic 502

**Phase 3 (polish + validation, ~2 days):**
- RT-9 Observability wiring (reuse mockstar logger + metrics)
- RT-10 Detailed env-hostility remediation messages
- RT-11 Bench harness with CI regression gate
- RT-12 CHANGELOG + PROXY.md + security note

### Option B: Thin-slice: single-hostname HTTPS end-to-end, then expand

- **Reversibility:** TWO_WAY
- **Risk:** RT-4's atomic invalidation doesn't exist until slice 3 — stale-session bugs (PM2-D) live in slices 1-2. Users hit them; trust erodes.
- **Complexity:** Low per slice; high coordination across slices.

Slice 1: one hardcoded hostname via `/etc/hosts`, basic cert cache, no env detection. Slice 2: multi-hostname + config file. Slice 3: dnsmasq + env detection + atomic install.

### Option C: Parallelized tracks with frozen interfaces

- **Reversibility:** REVERSIBLE_WITH_COST ⚠️
- **What this closes:** Interface shapes (handshake callback, cert-cache API, install-journal format) once frozen become expensive to change.
- **Satisfies:** All RTs if design is correct; no continuous validation during track execution.
- **Complexity:** High upfront; requires ~1 day of architecture design before any track starts.

Track A: TLS + cert lifecycle (RT-1, 2, 3, 4). Track B: install + platform (RT-5, 6, 7, 10). Track C: observability + bench (RT-9, 11).

---

## Tension Validation

All 7 m2 tensions **CONFIRMED** by Option A (see JSON `anchors.tension_validation`). No tensions reopened; no resolution invalidated by the chosen option.

| Tension | Status | Carrier phase |
|---|---|---|
| TN1 (TLS adapter) | CONFIRMED | Phase 1 (RT-2) |
| TN2 (dnsmasq + hosts fallback) | CONFIRMED | Phase 2 (RT-5) |
| TN3 (journaled install) | CONFIRMED | Phase 1 (RT-7) |
| TN4 (scoped CA + 24h TTL) | CONFIRMED | Phase 1 CA (RT-1) + Phase 2 TTL (RT-4) |
| TN5 (versioned snapshots) | CONFIRMED | Phase 2 (RT-4) |
| TN6 (T2→T3 sequencing) | CONFIRMED | Phase 1 → Phase 2 ordering |
| TN7 (T5→T8 sequencing) | CONFIRMED | Within Phase 2 (RT-4 before hot-reload) |
