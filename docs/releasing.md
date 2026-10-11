# Releasing mockstar

Releases are **versioned automatically from conventional commits** and published
through a signed, multi-arch supply chain.

## How it works

```
push to main (feat:/fix:/…)
        │
        ▼
semantic-release.yml           # decides next SemVer from commit history,
  ├─ updates CHANGELOG.md       # writes "## [x.y.z]" / "# [x.y.z]"
  ├─ bumps package.json         # (npmPublish:false — no publish here)
  ├─ commits "chore(release): vX.Y.Z [skip ci]"
  └─ pushes tag  vX.Y.Z  ◀── via RELEASE_PAT (so the next workflow fires)
        │
        ▼
release.yml  (on: push tags v*.*.*)
  ├─ preflight        # release-type + CHANGELOG gate
  ├─ publish-npm      # npm publish --provenance (OIDC Trusted Publishing)
  ├─ build-binaries   # darwin/linux × arm64/x64
  ├─ publish-container# linux/amd64 + linux/arm64 → ghcr.io/dhanesh/mockstar
  │                   #   push-by-digest · cosign sign · CycloneDX SBOM · Trivy
  ├─ publish-helm     # chart → oci://ghcr.io/dhanesh/charts/mockstar (cosign)
  ├─ slsa-provenance  # stable tags only
  └─ release-notes    # GitHub Release + binaries + SBOM
```

Conventional-commit → version bump: `fix:` → patch, `feat:` → minor,
`feat!:`/`BREAKING CHANGE:` → major. `chore:`/`docs:`/`ci:`/`refactor:` alone → no release.

## One-time setup (required)

1. **`RELEASE_PAT` secret** — semantic-release must push the tag with a token that
   can re-trigger workflows. The Actions `GITHUB_TOKEN` cannot (GitHub blocks
   workflow chaining via it). Create a **fine-grained PAT** scoped to this repo with
   **Contents: read & write**, and add it as the `RELEASE_PAT` repository secret.
   Until it's set, `semantic-release.yml` no-ops (stays green) with a warning.

2. **npm Trusted Publishing** — `publish-npm` uses OIDC (no `NPM_TOKEN`), which sidesteps
   the account's 2FA entirely (passkey/OTP never enters CI). Set it up in this order — the
   order matters, because `PUBLISH_NPM=true` with no trusted publisher registered fails the
   whole release (halt-clean then deletes the pushed container tag):

   1. **Register the (pending) trusted publisher** on npmjs.com. Because the package may not
      exist yet, use a *pending* publisher: npmjs.com → **Account → Trusted Publishers → Add**
      (or the package's *Settings → Trusted Publisher* once it exists). Fields:
      | Field | Value |
      |---|---|
      | Publisher | GitHub Actions |
      | Organization or user | `dhanesh` |
      | Repository | `mockstar` |
      | Workflow filename | **`semantic-release.yml`** |
      | Environment | *(leave blank — `publish-npm` pins no environment)* |

      > **Use `semantic-release.yml`, NOT `release.yml`.** `publish-npm` lives in `release.yml`,
      > but that runs via `workflow_call` from `semantic-release.yml`. GitHub's OIDC token reports
      > the **entry** workflow (`GITHUB_WORKFLOW_REF` → `semantic-release.yml`), and npm matches the
      > trusted publisher against that. Registering `release.yml` makes `npm publish` fail with
      > `ENEEDAUTH` (npm finds no matching publisher). If you later trigger `release.yml` directly
      > by pushing a tag, register `release.yml` as an additional publisher too.
   2. **Set the repo variable** `PUBLISH_NPM=true` (`gh variable set PUBLISH_NPM --body true`).
      Until then, `publish-npm` skips (container/helm/binaries still publish).
   3. The workflow bumps npm to `@latest` (via `sudo`) before publishing — OIDC trusted publishing
      needs **npm ≥ 11.5.1**, newer than the ubuntu-24.04 runner's default.

   If npm isn't a target yet, see "Container-only releases" below.

3. **GHCR** — no setup needed; `release.yml` logs in with `GITHUB_TOKEN`
   (`packages: write`) and pushes to `ghcr.io/dhanesh/...`.

4. **Homebrew tap (optional)** — `update-homebrew-tap` rewrites `Formula/mockstar.rb` in
   [`dhanesh/homebrew-tap`](https://github.com/dhanesh/homebrew-tap) after each stable
   release, so `brew install dhanesh/tap/mockstar` tracks the latest version. It needs the
   `HOMEBREW_TAP_TOKEN` secret: a fine-grained PAT scoped to `dhanesh/homebrew-tap` with
   **Contents: read & write**. Without it the job no-ops with a notice. A tap failure never
   fails or unpublishes the release. To bump the tap by hand instead:

   ```bash
   V=0.4.0; mkdir -p /tmp/sha && for t in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
     curl -fsSLo /tmp/sha/mockstar-bun-$t.sha256 \
       https://github.com/dhanesh/mockstar/releases/download/v$V/mockstar-bun-$t.sha256
   done
   bun run scripts/brew-formula.ts $V /tmp/sha > ../homebrew-tap/Formula/mockstar.rb
   ```

5. **GitHub Pages** — `pages.yml` deploys <https://dhanesh.github.io/mockstar/> (landing page
   from `site/` + the JSON Schema). Pages must be set to **Source: GitHub Actions**
   (Settings → Pages). It redeploys after every release and on `site/` changes to `main`.

## First release (seeds the version baseline)

semantic-release with **no prior tag defaults the first release to `1.0.0`**. To keep
the project pre-1.0, cut the first tag manually so subsequent automated releases count
up from it:

```bash
# 1. set the version + changelog to match the tag you're cutting
#    package.json -> "version": "0.1.0"
#    CHANGELOG.md -> add "## [0.1.0] — <date>" with notes
# 2. commit, then tag + push (a manually-pushed tag DOES trigger release.yml):
git tag v0.1.0
git push origin v0.1.0
```

After that baseline exists, set `RELEASE_PAT` and let semantic-release take over:
the next `feat:`/`fix:` merged to main becomes `0.2.0`/`0.1.1`, etc.

## Validating without publishing

Run the full pipeline (incl. the multi-arch container **build**) with **no push**:

```
Actions → release → Run workflow → dry_run: true
```

Every publish step is gated on `dry_run != 'true'`, so this builds both arches,
runs Trivy/SBOM, packages the chart — and pushes nothing.

## Container-only releases

If you don't publish to npm, the simplest options are: register npm Trusted
Publishing (recommended), or remove/relax the `publish-npm` job in `release.yml`
(and drop it from `halt-clean`'s `needs`) so a missing npm target can't fail the
container/helm publish.
