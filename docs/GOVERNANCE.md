# Governance & reversibility watch list

Mockstar's `.manifold/mockstar.json` tracks each architectural commitment with a reversibility tag. This document is the human-readable watch list for anything tagged `ONE_WAY` — decisions that close options permanently.

## Active ONE_WAY decisions

### MIT License (B1)

- **Committed:** 2026-04-13 — see `LICENSE` + `package.json` `"license": "MIT"`.
- **Why ONE_WAY:** Every copy distributed under MIT retains those rights in perpetuity. We cannot retroactively re-close the currently-released source; a future licence change would only apply to future versions.
- **What this closes:**
  - Cannot switch to a source-available or proprietary licence for released versions.
  - Cannot prohibit embedding in commercial products built against those versions.
- **Review trigger:** If a later business model requires source-available licensing (e.g., SaaS arm), the decision must be re-opened — but only for *future* major versions, with users clearly informed of the fork boundary.
- **Owner:** Project maintainers.

## Reversibility change log

| Date | Action | Reversibility | Watch owner |
|---|---|---|---|
| 2026-04-13 | MIT license applied at repo creation | `ONE_WAY` | maintainers |

## What *not* to put here

- `TWO_WAY` decisions (refactors, config edits) — refactor freely.
- `REVERSIBLE_WITH_COST` decisions (Hono adoption, crash-only design) — track in `docs/DECISIONS.md` and `.manifold/mockstar.json` `reversibility_log` only. They're expensive to reverse, not impossible.
- Individual commits or PR-level decisions — commits are always reversible at the history level.

## How this list gets updated

1. When a new `ONE_WAY` entry appears in `.manifold/mockstar.json` `reversibility_log`, add a matching section here with the fields above.
2. When a ONE_WAY decision is revisited (usually meaning a deliberate breaking change for a future major version), add a dated entry to the change log above.
3. `/manifold:m5-verify` reversibility check fails if a ONE_WAY entry exists in the manifold without a matching section here.
