# OIDC Setup — one-time console steps

> **Satisfies:** RT-3 (OIDC wiring — the binding constraint for the entire signing surface).
> **Why this doc exists:** the release workflow carries `permissions: id-token: write`, but
> OIDC is a handshake — the trust relationship has to be registered on the npm, GHCR, and
> Sigstore sides too. This document is the checklist for those one-time registrations.

Audience: one-time performed by a repo admin, before the first `v0.1.0` tag push.
Expected time: ~15 minutes.

## What OIDC buys us

| Without OIDC | With OIDC |
|---|---|
| Long-lived `NPM_TOKEN` in repo secrets | Short-lived OIDC assertion per job |
| GHCR PAT with `write:packages` | `GITHUB_TOKEN` scoped by workflow |
| Cosign keypair stored encrypted in secrets | Keyless signing — Fulcio mints a short-lived cert |
| Rotating credentials is a tracked chore | Nothing to rotate |

Token-free publishing is mandated by **B1** (constraint) and realised by **RT-3**.

---

## Step 1 — npm Trusted Publishing registration

**What:** register this repo + workflow as a Trusted Publisher on `npmjs.com`.

1. Sign in to <https://www.npmjs.com/> as a user who is a maintainer of the `mockstar` package.
2. Visit the package settings: <https://www.npmjs.com/package/mockstar/access>.
3. Under **Trusted Publishers**, click *Add*.
4. Fill in:
   - **Publisher:** GitHub Actions
   - **Organization/user:** `<github-org>` (e.g. `your-org`)
   - **Repository:** `mockstar`
   - **Workflow filename:** `release.yml`
   - **Environment name:** (leave blank unless you add a GitHub environment later)
5. Save.

**Verification:** the Trusted Publishers list now shows a row pointing at
`<github-org>/mockstar/.github/workflows/release.yml`. No tokens generated, nothing to copy.

**Load-bearing detail:** `npm publish --provenance` (in `release.yml`) only works once
this registration exists. Before registration, the publish step fails with
`E-OTP required` — **this is not a bug**, it's the gate doing its job.

---

## Step 2 — Sigstore Fulcio trust (for cosign keyless)

**What:** nothing. The default Sigstore public-good Fulcio instance already trusts
GitHub OIDC tokens issued by `https://token.actions.githubusercontent.com`.

If you operate a private Fulcio instance, you'll need to add the repo's OIDC issuer
and configure the subject claim pattern: `repo:<github-org>/mockstar:ref:refs/tags/v*`.

**Verification:** check <https://search.sigstore.dev/> after the first release —
signatures should appear indexed under the repo identity.

---

## Step 3 — SLSA generator (GHCR permissions)

**What:** confirm the repo can push to GHCR via `GITHUB_TOKEN`.

1. Repo Settings → Actions → General → **Workflow permissions** → ensure
   **Read and write permissions** is selected (or explicitly listed in the
   workflow `permissions:` block — we do both).
2. First tag push will create the GHCR package `ghcr.io/<org>/mockstar`.
3. After first push: Settings → Packages → mockstar → Package settings →
   **Manage Actions access** → add this repo with **Write** role. (Required
   for subsequent releases after the initial implicit grant.)

---

## Step 4 — smoke-test the wiring

Before cutting `v0.1.0`, cut `v0.1.0-rc.1`:

```bash
git tag v0.1.0-rc.1
git push origin v0.1.0-rc.1
```

Then verify, once the workflow finishes:

```bash
# npm provenance (RT-3, S5)
npm view mockstar@0.1.0-rc.1 --json | jq '.dist.attestations'

# cosign verify by digest (RT-4, S1)
DIGEST=$(gh api /orgs/<org>/packages/container/mockstar/versions \
  --jq '.[] | select(.metadata.container.tags[0] == "v0.1.0-rc.1") | .name')
cosign verify \
  --certificate-identity-regexp "^https://github.com/<org>/mockstar/" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  "ghcr.io/<org>/mockstar@${DIGEST}"

# SBOM attestation (RT-4, S2)
cosign verify-attestation \
  --certificate-identity-regexp "^https://github.com/<org>/mockstar/" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  --type cyclonedx \
  "ghcr.io/<org>/mockstar@${DIGEST}"
```

All three commands must succeed before promoting the RC to a stable release.
If any fails: **do not bless the RC; fix the wiring first.** The OIDC audience/subject
mismatch failure mode is silent — `cosign` will return "no matching signatures" with
no hint that the upstream identity is off.

---

## Common failure modes

| Symptom | Root cause | Fix |
|---|---|---|
| `npm publish` errors `forbidden — You do not have permission to publish` | Trusted Publishing not registered | Step 1 |
| `cosign sign` hangs then fails `fulcio.sigstore.dev: no matching signatures` | Subject claim mismatch | Re-check workflow filename + branch/tag reference in Fulcio policy |
| `docker push` 403 | Package-level access missing | Step 3 (second bullet) |
| SLSA workflow runs on pre-release | TN1 gate not honoured | Verify `preflight` job's `is_stable` output; only `stable` triggers SLSA |

---

## When to revisit

- Switching npm organisations: redo Step 1 under the new org.
- Repo rename or transfer: Step 1 *and* Step 3 both have to be redone — GitHub OIDC
  subject claims encode the full `org/repo` string, so the trust relationship is tied
  to the old name and silently breaks on rename.
- Private Sigstore Fulcio: add explicit issuer + subject-claim regex.
