#!/usr/bin/env bash
# Per-instance harness for verify-mockstar. Every command takes the instance name.
#
#   instance.sh launch <instance>   start mockstar + a webhook receiver; prints JSON
#   instance.sh status <instance>   read-only health checks; prints JSON; exit 0 only if all pass
#   instance.sh env    <instance>   prints shell exports (PORT, RX_PORT, TOKEN, RUN, BASE, PYTHON)
#   instance.sh stop   <instance>   stop this instance's processes by pid, release its ports
#
# Per-instance state lives in .verify-run/<instance>/ at the repo root: its own mocks copy
# (data store), its own admin token (auth session), logs, pid files, and the receiver's
# webhooks.jsonl. Evidence lives in .verify/ and is never touched here.
#
# Python: set PYTHON to a 3.10+ interpreter if `python3` is not one (macOS stub, old version).
set -euo pipefail

cmd="${1:-}"
inst="${2:-}"
if [[ -z "$cmd" || -z "$inst" ]]; then
  echo "usage: instance.sh launch|status|env|stop <instance>" >&2
  exit 2
fi
if [[ ! "$inst" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]]; then
  echo "instance name must be lowercase letters, digits and '-'" >&2
  exit 2
fi

SKILL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(git -C "$SKILL" rev-parse --show-toplevel)"
PY="${PYTHON:-python3}"
EV="$SKILL/scripts/verify_evidence.py"
RUN="$REPO/.verify-run/$inst"
READY_TIMEOUT="${READY_TIMEOUT:-30}"

claim() { "$PY" "$EV" port --worktree "$REPO" --instance "$1" | sed -n 's/^PORT: //p'; }

read_state() {
  PORT="$(cat "$RUN/port" 2>/dev/null || true)"
  RX_PORT="$(cat "$RUN/rx_port" 2>/dev/null || true)"
  PID="$(cat "$RUN/server.pid" 2>/dev/null || true)"
  RX_PID="$(cat "$RUN/receiver.pid" 2>/dev/null || true)"
  TOKEN="$(cat "$RUN/admin-token" 2>/dev/null || true)"
}

case "$cmd" in
launch)
  if [[ -f "$RUN/server.pid" ]] && kill -0 "$(cat "$RUN/server.pid")" 2>/dev/null; then
    echo "instance $inst is already running; run: instance.sh stop $inst" >&2
    exit 3
  fi
  mkdir -p "$RUN"
  PORT="$(claim "$inst")"
  RX_PORT="$(claim "$inst-rx")"
  # Per-instance data store: a fresh copy of the fixture, wired to this instance's receiver.
  rm -rf "$RUN/mocks"
  cp -R "$SKILL/fixtures/mocks" "$RUN/mocks"
  sed -i.bak "s/__RX_PORT__/$RX_PORT/g" "$RUN/mocks/acme/orders.json" && rm -f "$RUN/mocks/acme/orders.json.bak"
  # Per-instance auth session: a fresh FAKE admin token, written only under .verify-run/.
  TOKEN="verify-fake-$("$PY" -c 'import secrets; print(secrets.token_hex(12))')"
  printf '%s' "$TOKEN" >"$RUN/admin-token"
  printf '{ "adminToken": "%s" }\n' "$TOKEN" >"$RUN/mocks/acme/tenant.json"
  printf '%s' "$PORT" >"$RUN/port"
  printf '%s' "$RX_PORT" >"$RUN/rx_port"
  : >"$RUN/webhooks.jsonl"

  nohup bun "$SKILL/scripts/receiver.ts" "$RX_PORT" "$RUN/webhooks.jsonl" >"$RUN/receiver.log" 2>&1 &
  echo $! >"$RUN/receiver.pid"
  MOCKSTAR_ADMIN_TOKEN="root-$TOKEN" nohup bun "$REPO/src/cli.ts" serve "$RUN/mocks" \
    --port "$PORT" --no-watch --deterministic >"$RUN/server.log" 2>&1 &
  echo $! >"$RUN/server.pid"
  read_state

  # Readiness: the server's own log line naming THIS instance's config dir and port, plus
  # /health answering; the receiver's health route returning the pid we started.
  want="mockstar listening on http://127.0.0.1:$PORT (config: $RUN/mocks"
  deadline=$((SECONDS + READY_TIMEOUT))
  ready=no
  while ((SECONDS < deadline)); do
    if ! kill -0 "$PID" 2>/dev/null; then
      echo "server exited before ready; log follows. Ports released: relaunch picks new ones." >&2
      cat "$RUN/server.log" >&2
      kill "$RX_PID" 2>/dev/null || true
      "$PY" "$EV" release --worktree "$REPO" --instance "$inst" >/dev/null
      "$PY" "$EV" release --worktree "$REPO" --instance "$inst-rx" >/dev/null
      exit 1
    fi
    rx_pid_seen="$({ curl -sf "http://127.0.0.1:$RX_PORT/__rx/health" 2>/dev/null || true; } | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')"
    if grep -qF "$want" "$RUN/server.log" && curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 &&
      [[ "$rx_pid_seen" == "$RX_PID" ]]; then
      ready=yes
      break
    fi
    sleep 0.3
  done
  printf '{"instance":"%s","ready":%s,"port":%s,"rx_port":%s,"pid":%s,"rx_pid":%s,"run":"%s"}\n' \
    "$inst" "$([[ $ready == yes ]] && echo true || echo false)" "$PORT" "$RX_PORT" "$PID" "$RX_PID" "$RUN"
  [[ $ready == yes ]] || { echo "not ready after ${READY_TIMEOUT}s; see $RUN/server.log" >&2; exit 1; }
  ;;

status)
  read_state
  [[ -n "$PID" ]] || { echo "{\"instance\":\"$inst\",\"ok\":false,\"error\":\"not launched\"}"; exit 1; }
  chk() { if eval "$2" >/dev/null 2>&1; then printf '"%s":"pass"' "$1"; else printf '"%s":"fail"' "$1"; fail=1; fi; }
  fail=0
  out="$(
    chk process "kill -0 $PID"
    printf ','
    chk port_owner "[[ \"\$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t | head -1)\" == \"$PID\" ]]"
    printf ','
    chk build "grep -qF 'config: $RUN/mocks' '$RUN/server.log'"
    printf ','
    chk health "curl -sf http://127.0.0.1:$PORT/health"
    printf ','
    chk admin_auth "curl -sf -H 'authorization: Bearer $TOKEN' http://127.0.0.1:$PORT/__admin/tenants/acme/mocks"
    printf ','
    chk receiver "[[ \"\$(curl -sf http://127.0.0.1:$RX_PORT/__rx/health | sed -n 's/.*\"pid\":\\([0-9]*\\).*/\\1/p')\" == \"$RX_PID\" ]]"
  )"
  if [[ "$out" == *fail* ]]; then ok=false; else ok=true; fi
  echo "{\"instance\":\"$inst\",\"ok\":$ok,\"port\":$PORT,\"checks\":{$out}}"
  [[ $ok == true ]]
  ;;

env)
  read_state
  [[ -n "$PORT" ]] || { echo "instance $inst is not launched" >&2; exit 1; }
  echo "export PORT=$PORT RX_PORT=$RX_PORT TOKEN=$TOKEN RUN=$RUN BASE=http://127.0.0.1:$PORT PYTHON=$PY"
  ;;

stop)
  read_state
  for p in "$PID" "$RX_PID"; do
    [[ -n "$p" ]] && kill "$p" 2>/dev/null || true
  done
  "$PY" "$EV" release --worktree "$REPO" --instance "$inst" >/dev/null 2>&1 || true
  "$PY" "$EV" release --worktree "$REPO" --instance "$inst-rx" >/dev/null 2>&1 || true
  rm -rf "$REPO/.verify-run/$inst"
  echo "{\"instance\":\"$inst\",\"stopped\":true}"
  ;;

*)
  echo "unknown command: $cmd" >&2
  exit 2
  ;;
esac
