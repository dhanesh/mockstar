# cli-migrate-schema: Bump the pinned `$schema` minor in mock files

- id: cli-migrate-schema
- proven: no
- anchors: src/cli/commands/migrate.ts:rewriteSchemaUrl, src/cli/args.ts

## What it is

`mockstar migrate --schema <dir> --from vX.Y --to vX.Z` rewrites the top-level `$schema`
URL in every `*.json` under `<dir>` from one minor to another. Only that string changes:
formatting and every other byte stay as they were (0.7.1+). Files pinned to another minor
are listed and left alone, with exit code 3.

## How to reach it

The CLI: `bun src/cli.ts migrate --schema …` from this checkout (`mockstar migrate …` when
installed). No server and no network port: it runs in this instance's `$RUN/cli/`.

## Drive it

```sh
eval "$("$SKILL/scripts/instance.sh" env "$INSTANCE")"; mkdir -p "$RUN/cli/m" "$RUN/out"
printf '{\n\t"$schema": "https://schemas.mockstar.dev/v0.7/mock.json",\n\t"mocks": [ { "id": "a", "match": { "method": "GET", "path": "/a" } } ]\n}' > "$RUN/cli/m/x.json"
printf '{ "$schema": "https://schemas.mockstar.dev/v0.5/mock.json", "mocks": [] }\n' > "$RUN/cli/m/other.json"
cp "$RUN/cli/m/x.json" "$RUN/out/migrate-before.json"
bun "$(git rev-parse --show-toplevel)/src/cli.ts" migrate --schema "$RUN/cli/m" --from v0.7 --to v0.8 > "$RUN/out/migrate-stdout.txt" 2> "$RUN/out/migrate-stderr.txt"; echo "exit=$?"
cp "$RUN/cli/m/x.json" "$RUN/out/migrate-after.json"
diff "$RUN/out/migrate-before.json" "$RUN/out/migrate-after.json" > "$RUN/out/migrate.diff"; cat "$RUN/out/migrate.diff"
```

Expected: `exit=3` (one file was on another minor). `migrate-stdout.txt` is
`migrate --schema: rewrote 1/2 files`; `migrate-stderr.txt` names `other.json` as an
unexpected `$schema`. `migrate.diff` shows exactly one changed line, `v0.7` → `v0.8`, with
the tab indentation and the inline `match` object unchanged.

## Proof

- Side effect: `x.json` on disk changed in exactly one line (the diff), and `other.json`
  is byte-identical to what was written.
- The exit code (3) and stderr report the file pinned to another minor.

## Gotchas

- `migrate` walks every `*.json` under the directory except `node_modules` and dot
  directories: point it at a scratch copy, never at the repo's `examples/`.
- A URL written with escaped slashes (`https:\/\/…`) migrates but the file is re-written
  with 2-space indentation.
