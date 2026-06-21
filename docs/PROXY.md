# Mockstar Proxy (Tier 1)

One command makes `https://api.razorpay.com` (or any real hostname) resolve to your local mockstar, with a cert the system trusts. Application code unchanged.

> **Scope in v1:** macOS + Linux. Windows deferred to v1.1 (see `CHANGELOG.md`).

## Quick start

```bash
# 1. Install mkcert if you don't have it
brew install mkcert            # macOS
# sudo apt install mkcert libnss3-tools   # Debian / Ubuntu

# 2. Install the proxy (one-time, prompts for sudo)
mockstar proxy install
# -> creates ~/.mockstar/proxy.json with example content
# Edit the config, then re-run install

# 3. Start mockstar on :3000 (separately)
bunx @dhanesh/mockstar ./mocks --port 3000

# 4. Start the proxy on :443
mockstar proxy start

# 5. Your app calls https://api.razorpay.com unchanged
curl https://api.razorpay.com/v1/orders
```

## ⚠️ Node.js gotcha (RT-12.2)

**Node.js does not use the system trust store.** Node-based SDKs (including Razorpay's Node SDK) will reject mockstar's dev CA with `CERT_UNKNOWN_AUTHORITY` unless `NODE_EXTRA_CA_CERTS` is set.

Install's output prints the exact command; for reference:

```bash
echo 'export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"' >> ~/.zshrc
# or ~/.bashrc / ~/.config/fish/config.fish
# then reload your shell
```

## Config (`~/.mockstar/proxy.json`)

```json
{
  "hosts": [
    { "host": "api.razorpay.com",   "tenant": "razorpay" },
    { "host": "api.stripe.com",     "tenant": "stripe"   }
  ],
  "mockstarUrl": "http://127.0.0.1:3000",
  "upstreamTimeoutMs": 5000,
  "leafTtlHours": 24,
  "dnsMode": "dnsmasq"
}
```

Changes are picked up automatically (file-watch). Adding a new hostname: edit → save → next request works.

## How it works

1. **DNS** — install writes either dnsmasq per-host resolver files (default) or a marked block in `/etc/hosts` (fallback, auto-selected on hostile envs).
2. **TLS** — proxy binds `127.0.0.1:443` (via OS capability grant, no sudo at start). On handshake, SNI-callback issues a mkcert-signed 24h leaf for the requested hostname, or rejects the connection.
3. **HTTP** — request decrypted, `X-Mockstar-Tenant` header injected, forwarded to `http://127.0.0.1:3000`.

## Commands

| Command | Purpose |
|---|---|
| `mockstar proxy install`    | Install CA + DNS + port-443 capability (atomic + journaled) |
| `mockstar proxy start`      | Run the HTTPS proxy |
| `mockstar proxy status`     | Show CA, config, journal, upstream, hosts |
| `mockstar proxy reload`     | No-op; proxy reloads automatically on config change |
| `mockstar proxy uninstall`  | Reverse every journaled mutation (LIFO) |

## Security

**Installing a local CA is a significant system-trust-store modification.** Read `docs/GOVERNANCE.md` + `docs/PROXY.md#threat-model`.

### Threat model (quick)

| Concern | Control |
|---|---|
| Private key exfiltration | `rootCA-key.pem` is chmod 0600; leaf TTL 24h; `mockstar proxy uninstall` → `mkcert -uninstall` = instant revocation |
| Cross-tenant leak | Tenant is injected by the proxy via `X-Mockstar-Tenant`; mockstar enforces S1 tenant isolation |
| MITM of real internet | Hard-coded allowlist of configured hosts only; unknown SNIs get TLS alerts |
| Compromised laptop | **Run `mockstar proxy uninstall` first, then escalate to your security team** |

### When NOT to install

- In CI/CD environments (refused by default — `CI=true` detection).
- On managed fleet laptops without IT approval (warns on MDM detection).
- In any environment where `rootCA-key.pem` might leave the machine.

## Troubleshooting

Run `mockstar proxy status` — reports every subsystem.

| Symptom | Likely cause |
|---|---|
| `CERT_UNKNOWN_AUTHORITY` from Node SDK | Missing `NODE_EXTRA_CA_CERTS`; see above |
| Connection reset / `ECONNREFUSED` | Mockstar itself is not running; `make dev` |
| `502 mockstar_unreachable` | Proxy is up, mockstar is down — check :3000 |
| `TLS alert: unrecognized_name` | Hostname not in config.json; add it and save |
| Install failed partway | Run `mockstar proxy uninstall`; see `docs/PROXY-RECOVERY.md` |
| Port 443 already bound | `sudo lsof -i :443`; stop conflicting process |

## v1 limits (documented)

- Windows not supported (use WSL2 or wait for v1.1).
- No traffic recording (v2 candidate).
- No mutual TLS.
- No wildcard hostnames (`*.api.example.com`) — configure subdomains explicitly.
- SDKs that certificate-pin (not just CA-trust) are unaffected by mockstar's dev CA. No known Razorpay/Stripe/Twilio SDK does this today, but it's worth checking.
