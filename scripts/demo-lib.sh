# Typing/pacing helpers for scripts/demo.sh.
# Sourced by demo.sh; not meant to run standalone.

DEMO_TYPE_DELAY=${DEMO_TYPE_DELAY:-0.035}   # seconds per char (~28 chars/sec)
DEMO_THINK_PAUSE=${DEMO_THINK_PAUSE:-0.6}   # pause after a command before its output
DEMO_BEAT_PAUSE=${DEMO_BEAT_PAUSE:-1.1}     # pause between beats

prompt() { printf '\033[1;32m$\033[0m '; }

type_line() {
  local s="$1"
  for ((i = 0; i < ${#s}; i++)); do
    printf '%s' "${s:$i:1}"
    sleep "$DEMO_TYPE_DELAY"
  done
  printf '\n'
}

# Print a prompt, type the command, pause, then run it via eval so quoting/pipes work.
run() {
  prompt
  type_line "$1"
  sleep "$DEMO_THINK_PAUSE"
  eval "$1"
  sleep "$DEMO_BEAT_PAUSE"
}

# Print a comment line in dim grey so viewers can follow the narrative.
note() {
  printf '\033[2;37m# %s\033[0m\n' "$1"
  sleep 0.4
}

# Poll /health until 200 OK or timeout. Silent on success.
wait_for_ready() {
  local url="${1:-http://localhost:3000/health}"
  local deadline=$((SECONDS + 30))
  until curl -fsS "$url" >/dev/null 2>&1; do
    [ $SECONDS -lt $deadline ] || { echo "mockstar did not become ready" >&2; return 1; }
    sleep 0.5
  done
}
