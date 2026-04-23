# Team workflow

> **Satisfies:** RT-16 (multi-maintainer workflow is written down so newcomers can reason about the release cycle without Slack-archaeology)

This document is for people with maintainer access. See
[CONTRIBUTING.md](../CONTRIBUTING.md) for the external-contributor path.

## Weekly cadence

| Day | Rhythm |
|-----|--------|
| Monday | Triage — review new issues/PRs, assign owners, decide what goes into this week's batch |
| Tuesday–Thursday | Review + merge cycle; no tagged releases during this window by default |
| Friday | Release window (if needed) — cut tag, watch the release workflow, post release notes |

## Branch policy

- `main` is protected. All changes land via PR with ≥1 reviewer.
- Feature branches named `<owner>/<short-slug>` (e.g. `dhanesh/helm-probes`).
- Long-lived feature lines use a track branch (`track/v0.2-cutover`) that
  merges to `main` at the end of its lifecycle — NOT rebased into `main`.
- **Never force-push to `main`.** This is non-negotiable; it poisons
  `gh-pages` schema provenance (RT-2).

## Release flow (internal)

1. Open a "release preparation" PR that:
   - Moves `## [Unreleased]` entries under a new `## [<version>] — YYYY-MM-DD`
     heading in `CHANGELOG.md`.
   - Bumps `version` in `package.json`.
   - If the minor is changing, updates the `$schema` pinned URL in any
     shipped example fixture.
2. Merge the prep PR.
3. Tag + push: `git tag v<version> && git push origin v<version>`.
4. Watch `.github/workflows/release.yml`:
   - **Pre-release tags** (`-alpha`, `-beta`, `-rc`) skip SLSA provenance
     (TN1 resolution) but still get cosign + SBOM + npm provenance.
   - **Stable tags** get the full supply-chain surface.
5. Verify:
   ```bash
   cosign verify \
     --certificate-identity-regexp "^https://github.com/your-org/mockstar/" \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com \
     ghcr.io/your-org/mockstar@<digest>
   ```
6. Post release notes to the `#releases` channel.

If the release workflow fails partway through, the `halt-clean` job will
delete the pushed-but-unsigned container tag (RT-6). You DO NOT need to
clean anything up manually unless `halt-clean` itself fails — in which
case, use `gh api --method DELETE /user/packages/container/mockstar/versions/<id>`
and document the incident.

## Emergency fixes

- **Active CVE in a dependency.** Cut a patch release from `main`. If
  `main` has unreleased breaking changes, cut from the last release tag +
  the CVE fix.
- **Broken release on npm/GHCR.** `npm deprecate mockstar@<version>` and
  tag a replacement. DO NOT unpublish — too many consumers rely on
  the hash of the tarball.
- **Compromised signing identity.** Rotate via Sigstore; see
  `docs/OIDC-SETUP.md` for the recovery checklist.

## Maintainer-only conventions

- Issue labels drive release scope: `priority:urgent`, `priority:next`,
  `priority:later`. The triage meeting reviews the `priority:urgent`
  and `priority:next` queues.
- "Blocked on" dependencies go in a checklist in the issue body, not
  tags — tags decay, bodies don't.
- If you can't reach consensus in PR review within two rounds, escalate
  to a short (≤15 min) call; record the decision in a comment.

## When to revisit

- When adding a second supported release channel (e.g. LTS).
- When onboarding ≥3 new maintainers at once (workflow assumptions tuned
  for a ~3-maintainer team).
- When the weekly cadence consistently misses its triage target.
