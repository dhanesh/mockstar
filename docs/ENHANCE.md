# `mockstar enhance` — Migrate literal fixtures to Tier 2

`mockstar enhance` rewrites imported mock files so that common literal values — opaque IDs,
timestamps — become Tier 2 placeholders. It's idempotent: re-running produces byte-identical
output on unchanged input, and always preserves hand edits.

## What it rewrites

| Heuristic | Matches | Rewrites to |
|-----------|---------|-------------|
| ID-like name + opaque value | Field name like `id`, `*_id`, `*id`, `sid`, etc. with a value that looks like `prefix_ABC123` or 14-char base62 | `{{id("prefix_", <len>[, <alphabet>])}}` |
| Timestamp-like name + ISO value | Field name like `created_at`, `*_at`, `timestamp`, `*at` with a value matching `^YYYY-MM-DDTHH:MM:SS...$` | `{{now.iso}}` |
| Timestamp-like name + unix seconds | Same name, value is a number > 1000000000 | `{{now.unix}}` |

Everything else is left alone. The rule: *when in doubt, leave it as a literal* — a false negative
just misses an opportunity for dynamism; a false positive breaks SDK validation.

## Usage

```
mockstar enhance <mocks-dir>              # walk <mocks-dir>/*.json (non-recursive) and rewrite in place
mockstar enhance <mocks-dir> --dry-run    # report what would change, no writes
mockstar enhance <mocks-dir> --spec=api.json   # use a spec's field names as extra hints
```

## The `_mockstarGenerated` boundary

Every enhanced file gets a top-level sibling key `_mockstarGenerated` that records exactly what
was rewritten:

```jsonc
{
  "mocks": [ /* ... your mocks, with placeholders ... */ ],
  "_mockstarGenerated": {
    "version": 1,
    "enhancedAt": "2026-04-14T00:00:00.000Z",
    "providerTag": null,
    "entries": [
      {
        "entry": "create-order",
        "path": "body.id",
        "token": "{{id(\"order_\", 14)}}",
        "original": "order_abc123XYZ456"
      }
    ]
  }
}
```

This manifest is the ground truth for re-enhance: on a second run, the enhancer restores every
recorded `original` at its `path`, then re-applies the heuristics from a clean base, then writes
a fresh manifest. That's how idempotency works.

**Anything outside `_mockstarGenerated` is user-owned and never touched.** You can hand-edit any
mock (or add new ones) between runs — those edits survive.

## Worked example

Starting file (e.g. imported from OpenAPI):

```jsonc
{
  "mocks": [{
    "id": "create-order",
    "match": { "method": "POST", "path": "/orders" },
    "response": {
      "kind": "static",
      "status": 200,
      "body": {
        "id":           "order_abc123XYZ456",
        "customer_id":  "cust_DEF789GHI012",
        "created_at":   "2024-01-15T10:30:00Z",
        "amount":       4200,
        "description":  "literal kept as-is"
      }
    }
  }]
}
```

After `mockstar enhance ./mocks/razorpay`:

```jsonc
{
  "mocks": [{
    "id": "create-order",
    "match": { "method": "POST", "path": "/orders" },
    "response": {
      "kind": "static",
      "status": 200,
      "body": {
        "id":           "{{id(\"order_\", 12)}}",
        "customer_id":  "{{id(\"cust_\", 12)}}",
        "created_at":   "{{now.iso}}",
        "amount":       4200,
        "description":  "literal kept as-is"
      }
    }
  }],
  "_mockstarGenerated": { /* manifest as shown above */ }
}
```

`amount` and `description` are literals with no ID/timestamp heuristic match — left alone.

## Rolling back

Two options:

1. `git checkout -- path/to/file.json` — if you haven't committed yet.
2. Hand-remove the `_mockstarGenerated` block AND restore each `original` value at its `path`. Or
   delete the manifest and re-author from scratch.

## FAQ

**Q: Why does the token sometimes say `length: 12` and sometimes `length: 14`?**
A: The enhancer extracts the length of the remainder *after* the prefix in the original value.
A value like `order_abc123XYZ456` has a prefix `order_` and a 12-char remainder, so the token
records `length: 12` to preserve the exact shape. A 14-char remainder would record 14.

**Q: The enhancer rewrote a field I didn't want rewritten. What now?**
A: Hand-edit after the run. The enhancer's conservative bias means this should be rare; if you
can tell us the field name and shape, a more-specific rule can be added to
`src/features/enhance/field-mapping.ts`.

**Q: Does the enhancer support YAML specs?**
A: Not yet. Convert with `yq -o=json spec.yaml > spec.json` first.

**Q: Is the enhancer required to use Tier 2?**
A: No. You can hand-author Tier 2 placeholders in any mock file. The enhancer is purely a
migration convenience — turning an imported OpenAPI dump into something that's dynamic by default.

## Related

- `docs/TIER2.md` — the template tokens the enhancer emits
- `src/features/enhance/field-mapping.ts` — the heuristic rules (authoritative reference)
- `ops/runbooks/tier2-enhance-failure.md` — recovery procedures
