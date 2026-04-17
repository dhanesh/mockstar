# Runbook: Tier 2 ID collision reported

**Trigger:** A test or production consumer reports duplicate rendered IDs within a single
mockstar process lifetime.
**Related constraint:** RT-3 (no ID collisions), T9, T10.
**Severity:** High — usually signals a broken seed or PRNG state leak.
**Reversibility of response:** TWO_WAY.

---

## What this means

`createIdHelpers` is built per-request (TN8): the seed combines tenant, endpoint, and a
per-request counter. Within a single `id(prefix, length)` call the PRNG advances deterministically.
A collision implies one of:

1. The per-request seed is constant (the counter didn't advance, or the hash collapsed).
2. Two requests got the same `(tenant, endpoint, requestId)` tuple.
3. The rejection-sampling loop returned early with a zero-length output.
4. Deterministic mode was enabled in production (the seed is then a function of a fixed input).

## First steps

1. Confirm the deployment is in **non-deterministic** mode:
   ```
   bun run src/cli.ts help | rg deterministic
   echo "MOCKSTAR_DETERMINISTIC=$MOCKSTAR_DETERMINISTIC"
   ```
   If `MOCKSTAR_DETERMINISTIC=1` in prod — that's the cause. Same seeds → same IDs.

2. Inspect the collided IDs — do the prefix/length/alphabet match the template exactly?
   If not, there's a compiler or walker bug, not an ID-generator bug.

3. Reproduce locally:
   ```
   bun test tests/tier2-id.test.ts
   ```
   The 1M-iteration collision test asserts zero collisions with the wall-clock PRNG.

## Common causes

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Collisions appear only under `--deterministic` | Seed tuple is identical across requests (e.g. requestId counter reset) | Include request counter in seed; do not reset |
| Collisions in prod, not in tests | `crypto.getRandomValues` polyfill broken on target runtime | Verify `globalThis.crypto` exists and is seeded by OS |
| Collisions for a specific alphabet | Rejection-sampling mask wrong for that alphabet length | Check `mask = (2 << (31 - Math.clz32((aLen - 1) \| 1))) - 1` derivation |
| Length-0 IDs returned | Caller passed `length: 0`; the loop exits immediately | Validate `length ≥ 1` at compile time |

## Verification after fix

```
bun test tests/tier2-id.test.ts   # 1M-iteration no-collision test
bun test tests/tier2-determinism.test.ts
```

## Escalation

- **Level 1**: Reporter (filer of the issue).
- **Level 2**: Tier 2 feature maintainer.
- **Level 3**: Security on-call — ONLY if the collision implies predictable IDs in a context where
  that creates a vulnerability (e.g. IDs used as capabilities). Normally this is a correctness bug, not a security one.
