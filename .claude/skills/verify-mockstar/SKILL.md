---
name: verify-mockstar
description: >-
  Prove a change to mockstar (the Bun mock HTTP server and its CLI) works by running it the
  way a user does: start isolated server instances, send HTTP requests to the mocks, the
  tenant selectors, the scenarios and the admin API, receive the webhooks it fires, run the
  CLI (migrate, init, help), and record pinned evidence per feature and commit. Use this
  before claiming a mockstar change is done, when asked to verify, smoke-test or demo
  mockstar behaviour, or to add a feature to the verification map.
---

# verify-mockstar

mockstar serves mock HTTP APIs from JSON mock files (`mocks/<tenant>/*.json`), picks a
tenant per request, can answer with a scenario, fires webhooks after a response, and has a
CLI (`serve`, `init`, `import`, `enhance`, `migrate`, `proxy`). This skill drives the real
thing from this checkout: `bun src/cli.ts serve` on a per-instance port, `curl` for the
HTTP surface, a small per-instance webhook receiver, and the CLI in a per-instance temp
directory. `scripts/instance.sh` is the harness; it prints JSON.

Session variables (set these first, in every shell you drive from):

```sh
SKILL="$(git rev-parse --show-toplevel)/.claude/skills/verify-mockstar"
INSTANCE=a          # lowercase name; use a second name (b, c, ...) for each parallel owner
VERIFIER=verifier-1 # under factory-conductor: the id from your verifier brief. Working alone:
                    # a stable name for this session, never the author of the change.
export PYTHON="${PYTHON:-python3}"   # a Python 3.10+ interpreter (the recorder needs it)
```

Prerequisites: `bun` (1.3+), `curl`, `lsof`, Python 3.10+. Run `bun install` once in the
repo. The server runs from `src/`, so no build step is needed.

## Launch

One command starts an instance. It claims this instance's port with
`scripts/verify_evidence.py port --instance "$INSTANCE"` (and a second one for the webhook
receiver, `$INSTANCE-rx`), copies `fixtures/mocks` into `.verify-run/$INSTANCE/mocks` (the
per-instance data store), generates a fake per-instance admin token (the per-instance auth
session; never committed), and starts `bun src/cli.ts serve` with `--deterministic
--no-watch` plus the receiver.

```sh
"$SKILL/scripts/instance.sh" launch "$INSTANCE"
```

Ready means all three: the server's own log line
`mockstar listening on http://127.0.0.1:<port> (config: <this instance's .verify-run dir>/mocks`
(which proves the answer comes from the process this launch started, not another
checkout's server on the same port), `GET /health` answering on that port, and the
receiver's `GET /__rx/health` returning the pid this launch started. The timeout is 30 s
(`READY_TIMEOUT=60` to raise it). On success it prints
`{"instance":"a","ready":true,"port":…,"rx_port":…,"pid":…}` and exits 0. If the server
exits before it is ready, launch prints its log, releases both port claims and exits 1:
run the same command again and it picks fresh ports. Exit 3 means this instance is already
running.

Load the instance's values into the shell before driving:

```sh
eval "$("$SKILL/scripts/instance.sh" env "$INSTANCE")"   # sets BASE, PORT, RX_PORT, TOKEN, RUN
```

Fixture tenants: `default` (`GET /hello`) and `acme` (`GET /orders/:id` with a
`missing-order` scenario for id `o-404`, and `POST /orders` firing two webhooks to the
receiver). The CLI-only features need no port: they run in `$RUN/cli/`.

## Doctor

One read-only check before the first drive and after any failure: process alive, the
listening port owned by this instance's pid, the server log naming this instance's config
dir (right build and data store), `/health`, an admin API read with this instance's token
(auth valid) and the receiver's pid.

```sh
"$SKILL/scripts/instance.sh" status "$INSTANCE"
```

It prints `{"instance":"a","ok":true,"checks":{"process":"pass","port_owner":"pass",…}}` and
exits 0 only when every check passes. Record the result with `scripts/verify_evidence.py doctor`,
passing the same checks it printed:

```sh
"$PYTHON" "$SKILL/scripts/verify_evidence.py" doctor --instance "$INSTANCE" --verifier "$VERIFIER" \
  --ok --check process=pass --check port_owner=pass --check build=pass \
  --check health=pass --check admin_auth=pass --check receiver=pass
```

Use `--fail` and the failing check names when status exits 1, then fix or relaunch.

## Drive

Drive through public routes only: mock routes (`/orders/:id`, `/hello`), the tenant
selectors (`/t/<tenant>/…` path prefix, `x-mockstar-tenant` header), the admin API
(`/__admin/tenants/<tenant>/…` with `authorization: Bearer $TOKEN`) and the CLI
(`bun src/cli.ts …`). Save every response you will cite to a file under `$RUN/out/`:

```sh
mkdir -p "$RUN/out"
curl -sS -D "$RUN/out/get-order.headers" -o "$RUN/out/get-order.json" -w '%{http_code}\n' "$BASE/t/acme/orders/o-1"
```

Expected: `200` and `{"id":"o-1","tenant":"acme","customer":"…","status":"paid"}`. Each
feature in `features/` has its full recipe, expected output and proof. Read
`features/README.md` first and pick the features your change touches.

## Evidence

- Exercise the real user path. Never internal setters, never test-only endpoints.
- Capture the action *and* the resulting state, not just a final screenshot.
- Verify side effects (rows inserted, files written, messages sent, webhooks fired) alongside what is visible.
- Mocks only where a production boundary already isolates the external system.
- Where the safe path is a dry-run or test mode, verify what it *actually* skips by observing files, network and git refs, not by trusting its name. Some dry-runs still touch the network or open a browser.
- Evidence goes to `.verify/<instance>/<feature-id>/<sha>/`, one directory per feature per head, recorded with `scripts/verify_evidence.py record`.
- Harness output is JSON wherever the harness can emit it, so a verifier can read it without a human.
- Cleanup removes instances, never evidence.

Record one feature (the recorder reads the commit from git and pins each artifact by
sha256; `--side-effect` and at least one `--artifact` are required):

```sh
"$PYTHON" "$SKILL/scripts/verify_evidence.py" record --instance "$INSTANCE" --feature static-mocks \
  --verifier "$VERIFIER" --result pass \
  --action "GET /t/acme/orders/o-1" \
  --observed "200 with id o-1, tenant acme, templated customer" \
  --side-effect "none: a GET to a static mock writes nothing" \
  --artifact "$RUN/out/get-order.json" --artifact "$RUN/out/get-order.headers"
```

It prints the record path, `.verify/<instance>/<feature>/<sha>/evidence.json`. Commit your
change first: the record names HEAD, so evidence for uncommitted code names the wrong head.
Artifact file names must be unique per record and must not be `evidence.json`,
`doctor.json` or start with `proof-`.

## Cleanup

Stop this instance's server and receiver by their pids, release both port claims and
delete `.verify-run/$INSTANCE/` (logs, mocks copy, token). `.verify/` is left alone.

```sh
"$SKILL/scripts/instance.sh" stop "$INSTANCE"
```

It prints `{"instance":"a","stopped":true}`. Never stop mockstar by process name: another
owner's instance is a `bun` process too.

## Adding a feature to the map

Copy the shape of an existing `features/<id>.md`, give it a lowercase kebab-case id equal
to its file name, list it in `features/README.md`, and keep `- proven: no` until you have
driven it live; then set the commit in a follow-up commit that touches only `features/`.
