# Runbook: `mockstar enhance` failure or unexpected rewrites

**Trigger:** `mockstar enhance` fails, hangs, or rewrites fields the user didn't want rewritten.
**Related constraint:** RT-6 (enhance is safe), O3 (idempotent), TN7 (`_mockstarGenerated` boundary).
**Severity:** Medium — user can always revert from git.
**Reversibility of response:** TWO_WAY (the enhancer preserves originals inside the manifest).

---

## What this means

`mockstar enhance` walks every `mocks[].response.body` (static kind only), applies conservative
name/value heuristics, and records each rewrite in a top-level `_mockstarGenerated` sibling key.
On a second run, it:

1. Reads the prior manifest
2. Restores each original value at its recorded path
3. Re-applies the heuristics from a clean base
4. Writes a fresh manifest

So re-running is always safe — the manifest is the ground truth for what was touched.

## First steps

1. **Always commit first**. The enhancer writes in place.
2. Check `_mockstarGenerated.entries[]` — each entry has `{entry, path, token, original}`. The `original`
   field is the literal value that was replaced.
3. Dry-run to see what *would* change:
   ```
   bun run src/cli.ts enhance path/to/mocks --dry-run
   ```

## Common causes

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| "spec at X could not be parsed" warning | YAML spec — parser only accepts JSON | Convert spec to JSON first |
| A field was rewritten that shouldn't have been | Field name matched an ID-or-timestamp heuristic (ends in `_id`, `_at`) but value was semantically different | Move the spec under `--spec` so the field's *actual* type narrows the heuristic, OR hand-edit after |
| Re-run produced different bytes | User edited the mock file between runs | Expected — enhancer picks up new literals |
| `_mockstarGenerated` missing after run | No field matched any heuristic — enhancer only writes the manifest when rewrites occurred or a prior manifest existed | Not a bug |
| Hangs on a large directory | Non-recursive walk of JSON files — check if a fixture is pathologically large | Split the fixture |

## Rolling back an unwanted enhancement

```
git checkout -- path/to/mocks
```

Or restore from the manifest programmatically (the `original` values are preserved):
```
bun run src/cli.ts enhance path/to/mocks  # re-run restores originals BEFORE re-applying heuristics
# Then hand-edit the file to remove the _mockstarGenerated block if you want to lock the literals.
```

## Verification after fix

```
bun test tests/tier2-enhance.test.ts
```

Key invariant: two consecutive `enhance` runs on unchanged input produce byte-identical files.

## Escalation

- **Level 1**: User's own edit history + `git checkout`.
- **Level 2**: Enhance-feature maintainer (check `src/features/enhance/`).
- **Level 3**: Escalation to the Tier 2 design owner only if the heuristic is wrong in general
  (e.g. needs a new boundary case).

## Related docs

- `docs/ENHANCE.md` — user-facing overview
- `src/features/enhance/field-mapping.ts` — heuristic rules
- `src/features/enhance/boundary.ts` — manifest schema
