# Runbook — Suspected dev-CA compromise

> Trigger: You suspect `rootCA-key.pem` has been exfiltrated from a laptop, or mkcert-signed
> certs are appearing in unexpected places.
> Severity: P1 — compromised CA = arbitrary MITM on that machine.
> Constraints: TN4 (scoped CA + 24h TTL + clean uninstall), S1, S5, RT-12.3.

## 1. Revoke trust IMMEDIATELY (1 minute)

Before investigation, before escalation, run:

```bash
mockstar proxy uninstall
# OR, if the proxy CLI is broken:
mkcert -uninstall
```

This removes the CA from the system trust store. Every cert signed by it becomes untrusted
**system-wide**, immediately. Anyone with the exfiltrated CA key now has an expired capability.

## 2. Rotate quickly (5 minutes)

```bash
rm -rf "$(mkcert -CAROOT)"
# Installing mkcert fresh generates a new CA with new keys
mkcert -install
mockstar proxy install
```

The old CA key is now irrelevant — it signs certs that the OS no longer trusts.

## 3. Escalate (immediately after steps 1 + 2)

Notify your security team with:

- Timestamp when `uninstall` + rotation ran (from `~/.mockstar/install.log`).
- Your best guess at when the compromise occurred.
- What other sensitive material might have been exfiltrated (SSH keys, AWS credentials,
  browser cookies — a compromised laptop is not only a TLS-CA compromise).

Do NOT spend time investigating yourself before notifying security. They have tooling to
check whether the key was used for anything external.

## 4. What the dev CA could have been used for

- MITM'ing any HTTPS connection from this laptop (banking, cloud metadata,
  internal services) while malware had network access.
- Impersonating any hostname (including hosts NOT in `mockstar proxy` config — the mkcert
  CA can sign anything).
- Signing code that the laptop's trust store might accept for code-signing
  (much rarer, but possible on some configurations).

The 24h leaf TTL limits exposure ONLY for leaves already generated when the compromise
happened. A CA-key holder can mint new leaves with any TTL they want; that's why step 1
is the critical action.

## 5. Post-incident review

Once the incident is contained:

- Was this compromise reportable under your org's incident policy? (Probably yes.)
- What detection could have surfaced this faster? (Unusual certs appearing in
  `mkcert -CAROOT` directory modification times?)
- Was the dev CA necessary, or can the proxied tests move to a different approach
  (e.g., library-embed API without TLS)?

## 6. Preventive measures

- **Never commit `rootCA-key.pem`**. `.gitignore` covers it by default because
  `mkcert -CAROOT` points outside the repo, but be defensive.
- **Don't share `rootCA-key.pem` with teammates.** The `rootCA.pem` (without `-key`)
  is safe to share. Each teammate runs `mkcert -install` themselves to generate
  their own CA.
- **Uninstall when not in use.** `mockstar proxy uninstall` when switching away from
  HTTPS-proxy workflows; re-install when needed. The CA is only in the trust store
  while it's actually helping you.
