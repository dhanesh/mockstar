# Schema hosting

> **Satisfies:** RT-2 (dual-URL JSON Schema hosting with MAJOR.MINOR pin contract)

Mockstar publishes its mocks-file JSON Schema at two URLs. Authors choose which
one to reference from `$schema` based on their tolerance for drift.

| URL | Stability | Use when |
|-----|-----------|----------|
| `https://schemas.mockstar.dev/v0/mock.json` | Rolling — tracks the latest `0.x` minor | You want the newest fields and will accept breakages at minor bumps |
| `https://schemas.mockstar.dev/v0.N/mock.json` | **Immutable** once published | You want deterministic validation across a team or CI |

The rolling `/v0/mock.json` redirects (HTTP 302) to the latest minor. The minor
URL never moves once a release ships.

## Contract

1. **Pin on MAJOR.MINOR, not patch.** `v0.1/mock.json` serves all of `0.1.0`,
   `0.1.1`, `0.1.0-rc.3`, etc. Patch releases MUST be schema-compatible with the
   enclosing minor. If a change is not backwards-compatible, ship a minor bump.
2. **Minor URLs are immutable after first publish.** Once
   `schemas.mockstar.dev/v0.1/mock.json` is live, the file at that path is
   frozen. A bugfix to the schema that corrects a validation error ships as
   `v0.2/mock.json`, never as a retroactive edit to `v0.1`.
3. **The rolling URL may break without notice.** If you author long-lived mock
   fixtures, prefer the minor URL.
4. **`$id` matches the minor URL.** Every published schema's `$id` field is the
   minor URL it lives at — tools can detect drift by comparing the `$id` in a
   downloaded schema with the `$schema` in a user's mock file.

## Migration

When a minor bump breaks your mocks files, bring them current with:

```bash
mockstar migrate --schema --from v0.1 --to v0.2 ./mocks
```

The subcommand rewrites the `$schema` field in every `*.json` under the given
directory, optionally running a migration transformer if one ships with the new
minor. It NEVER touches response bodies or predicates. Run with `--dry-run`
first to preview the affected files.

## Publishing flow

1. On each release, semantic-release runs `bun run scripts/generate-schema.ts`,
   which writes `schema/mock.json` (with the current `$id`) and
   `schema/VERSION`, and commits both to `main`.
2. `.github/workflows/pages.yml` then deploys the GitHub Pages site
   (<https://dhanesh.github.io/mockstar/>): the landing page from `site/` plus
   the schema under both `/v0.<N>/mock.json` and `/v0/mock.json`. Previously
   published minors are carried forward from the live site (listed in
   `/schemas.json`), because each Pages deploy replaces the whole site.
3. The schema shares the Pages site with the landing page, so it is served at
   `https://dhanesh.github.io/mockstar/v0.<N>/mock.json` today. The
   `schemas.mockstar.dev` hostname in `$id` / `$schema` does not resolve yet;
   a repo has one Pages domain, so pointing that hostname here would move the
   landing page with it — host the schemas from a separate repo instead.

If the workflow detects that a previously published `v0.<N>/mock.json` differs
from the one it is about to upload, it fails the deploy — this catches
accidental reuse of a minor for a breaking change.

## Verification

```bash
# Fetch the current rolling schema
curl -sSL https://schemas.mockstar.dev/v0/mock.json | jq '.$id, .title'

# Verify a file pins to a live minor
jq -r '."$schema"' ./mocks/my-mocks.json
```

## When to revisit

- The moment we ship `1.0.0`, a `v1/` tree starts alongside the `v0/` tree. The
  `v0` tree continues to serve its minors for existing users — we do not
  retroactively collapse the two.
- If the schema ever needs a property deprecation (a field that is still valid
  but discouraged), we use JSON Schema's `deprecated: true` flag on the
  property within the *current* minor — we do not cut a new minor just to mark
  a field deprecated.
