# Contributing to Mockstar

> **Satisfies:** RT-16 (contributor workflow is discoverable from repo root, ≤ 1 hour from clone to green PR)

## The short version

1. **Fork + clone.** Node is NOT required — Mockstar builds on Bun.
2. **Install toolchain.** `curl -fsSL https://bun.sh/install | bash` (≥ the version in `.bun-version`).
3. **Install deps.** `bun install --frozen-lockfile`
4. **Make your change + a test.** Tests live in `tests/` mirroring `src/`.
5. **Run the full gate.** `bun run verify` (or `make verify`) — runs lint +
   typecheck + build + test in one shot and stops on the first failure. This is
   the single command CI enforces; if it's green locally, the PR checks pass.
6. **Open a PR.** Use a conventional-commit style title (`fix(proxy): ...`).

PRs must be green on `bun run verify` before merge, which is exactly:

- `bun run lint` clean (Biome — lint + format)
- `bun run typecheck` clean
- `bun run build` succeeds
- All `bun test` suites green (full suite completes in under a minute)

The CI workflow `.github/workflows/quickstart-smoke.yml` also runs — it enforces
the 5-minute persona quickstart SLOs and will catch drift that unit tests miss.

## How the project is designed

Mockstar is built **constraint-first**. Each feature has a manifold under
`.manifold/<feature>.json`+`.md` that records:

- business / technical / UX / security / operational constraints
- tensions and their resolutions
- required truths and the solution option chosen

When you're considering a non-trivial change, start at the manifold, not the
code. If your change would alter a tension resolution or add a new required
truth, say so in the PR body — reviewers will ask either way.

For the repo's broader design record, read
[`docs/DECISIONS.md`](docs/DECISIONS.md).

## Where code lives

| Directory | What it contains |
|-----------|------------------|
| `src/` | Library source. `src/cli.ts` is the entry for `bunx mockstar`. `src/index.ts` is the library embed API. |
| `src/features/` | Top-level features (proxy, openapi import, enhance). |
| `src/core/` | Shared plumbing (config, handlers, journal, observability, templating). |
| `tests/` | Mirrors `src/`; integration tests under `tests/helm`, `tests/docker`, `tests/ci`. |
| `charts/mockstar/` | Helm chart (see `charts/mockstar/README.md` for the TN5 tenant-content contract). |
| `examples/sdet-*` | Per-framework SDET examples. Double as smoke targets in CI. |
| `scripts/` | Build / release helpers. `scripts/build-binaries.ts` covers the 4-target binary matrix. |
| `docs/` | User-facing docs. |

## Commit + PR conventions

- **Conventional commits.** `feat(scope): ...`, `fix(scope): ...`, `docs: ...`,
  `chore(deps): ...`. The `scope` usually matches a directory under `src/`.
- **One logical change per PR.** If a PR edits code + unrelated test cleanup,
  split it.
- **CHANGELOG entry.** Every user-visible change adds a line to
  `CHANGELOG.md` under the `## [Unreleased]` section. The release workflow
  refuses to ship a tag that has no matching entry (RT-18).
- **Tests first.** For bug fixes, add a failing test in the same PR.

## Reviews

- Maintainers aim for a first response within 3 working days.
- Reviews focus on: constraint fit (manifold), blast radius of the change,
  and whether it closes a known gap or opens a new one.
- Security-relevant changes (anything touching auth, S-prefix constraints,
  or `pass-through`) get a second reviewer.

## Reporting security issues

Do NOT open a public GitHub issue for a security finding. Instead, email
`security@mockstar.dev` (or the equivalent private channel listed in
`SECURITY.md` once we publish one). Disclosure follows standard 90-day
coordinated disclosure.

## When to revisit this document

Rewrite this when:

- We move off Bun or add a second supported runtime.
- The CI gate set changes (e.g. add fuzzing, property tests).
- Persona quickstart paths change (RT-13).
