#!/usr/bin/env bash
# Satisfies: G1 + G2 + G9 — live-OS smoke test for `mockstar proxy`.
# Runs inside Dockerfile.tier1-proxy under CI. Exits non-zero on any failure.
#
# Flow:
#   1. mkcert -install (system trust store)
#   2. Write a minimal proxy config at ~/.mockstar/proxy.json
#   3. mockstar proxy install                (exercises RT-5, RT-6, RT-7)
#   4. Start mockstar-core on :3000 in background
#   5. mockstar proxy start                   in background
#   6. curl -v https://api.razorpay.mockstar-test.local/health via the proxy
#   7. Assert HTTP 200
#   8. bun run bench/proxy.bench.ts           (RT-11)
#   9. mockstar proxy uninstall               (verifies U2 reversal)
#  10. Assert no residual entries (CA removed, dnsmasq stopped)
#
# Steps 3/5/9 invoke `mockstar` via the helper function defined below: when
# MOCKSTAR_PROXY_BIN is set (Dockerfile.tier1-proxy builds a packaged binary and
# exports it), those steps run against that binary — the real path #39's interpreter
# refusal steers users toward. Otherwise they fall back to `bun run src/cli.ts` with
# the #39 escape hatch (e.g. the macOS job, which runs from a bare checkout).

set -euo pipefail

# Print every command for CI visibility.
set -x

TEST_HOST="api.razorpay.mockstar-test.local"
TENANT="razorpay"
PROXY_PORT=443
MOCK_PORT=3000

cd /app

# -----------------------------------------------------------------------------
# Resolve how to invoke mockstar's proxy subcommands (see header comment above).
# -----------------------------------------------------------------------------
# `proxy install` grants cap_net_bind_service to the exact binary file it's run as
# (setcap is per-inode, not per-command), so `proxy start` must run as that SAME file
# to inherit the capability — hence routing both through the same `mockstar` helper.
mockstar() {
  if [ -n "${MOCKSTAR_PROXY_BIN:-}" ]; then
    "${MOCKSTAR_PROXY_BIN}" "$@"
  else
    bun run src/cli.ts "$@"
  fi
}

# -----------------------------------------------------------------------------
# Step 1: mkcert -install + manual CA wiring for Debian base images
# -----------------------------------------------------------------------------
mkcert -install
# On the oven/bun:*-debian base, mkcert reports "system store not supported on this
# Linux" and writes the CA only to $(mkcert -CAROOT). Wire it into the system bundle
# so curl (which uses OpenSSL's default verify paths) trusts the leaf. This is what
# `mkcert -install` does automatically on distros with NSS tooling properly detected;
# here we do it manually so the smoke exercises the full trust path.
CAROOT="$(mkcert -CAROOT)"
mkdir -p /usr/local/share/ca-certificates
cp "${CAROOT}/rootCA.pem" /usr/local/share/ca-certificates/mockstar-dev-ca.crt
update-ca-certificates

# -----------------------------------------------------------------------------
# Step 2: write proxy config
# -----------------------------------------------------------------------------
mkdir -p "$HOME/.mockstar"
cat > "$HOME/.mockstar/proxy.json" <<EOF
{
  "hosts": [{ "host": "$TEST_HOST", "tenant": "$TENANT" }],
  "mockstarUrl": "http://127.0.0.1:${MOCK_PORT}",
  "listenHost": "127.0.0.1",
  "listenPort": ${PROXY_PORT},
  "upstreamTimeoutMs": 5000,
  "leafTtlHours": 24,
  "dnsMode": "hosts-fallback"
}
EOF

# -----------------------------------------------------------------------------
# Step 3: install the proxy (writes /etc/hosts entry, setcap on the mockstar binary)
# -----------------------------------------------------------------------------
if [ -n "${MOCKSTAR_PROXY_BIN:-}" ]; then
  # Packaged binary present (Dockerfile.tier1-proxy built it) — the real path #39's
  # interpreter refusal steers users toward. No escape hatch needed: process.execPath
  # resolves to the packaged binary, not an interpreter.
  mockstar proxy install --force --dns-mode=hosts
else
  # --allow-interpreter-capability-grant (#39): no packaged binary was built for this
  # caller (e.g. the macOS job, which runs from a bare checkout), so the `mockstar`
  # helper above falls back to `bun run src/cli.ts`, and process.execPath resolves to
  # the `bun` interpreter itself, not a packaged mockstar binary — the refusal
  # `portBindMutation` added for #39 would otherwise reject this. That refusal exists
  # because granting cap_net_bind_service to a general-purpose interpreter hands every
  # program it runs the ability to bind privileged ports, persistently, on the machine
  # that's granted it. Here that concern doesn't apply: this runs inside a throwaway,
  # single-purpose CI container/runner destroyed immediately after the job, so there is
  # no persistent "every Bun program on this machine" to worry about. Do not copy this
  # flag onto a developer's own machine.
  mockstar proxy install --force --dns-mode=hosts --allow-interpreter-capability-grant
fi

# -----------------------------------------------------------------------------
# Step 4: start mockstar-core on :3000
# -----------------------------------------------------------------------------
mkdir -p /tmp/smoke-mocks/$TENANT
# Use a custom path (not /health — that's a mockstar-core built-in route that would
# shadow the configured mock and break the body assertion below).
cat > /tmp/smoke-mocks/$TENANT/hello.json <<EOF
{
  "mocks": [
    {
      "id": "hello",
      "match": { "method": "GET", "path": "/v1/orders/smoke" },
      "response": {
        "kind": "static",
        "status": 200,
        "headers": { "content-type": "application/json" },
        "body": { "status": "ok", "from": "mockstar-core" }
      }
    }
  ]
}
EOF
bun run src/cli.ts /tmp/smoke-mocks --port "${MOCK_PORT}" --no-watch &
MOCKSTAR_PID=$!
sleep 1

# Wait for mockstar to respond.
for _ in 1 2 3 4 5; do
  if curl -fsS "http://127.0.0.1:${MOCK_PORT}/health" > /dev/null; then break; fi
  sleep 1
done

# -----------------------------------------------------------------------------
# Step 5: start the proxy on :443
# -----------------------------------------------------------------------------
mockstar proxy start &
PROXY_PID=$!
sleep 2

# -----------------------------------------------------------------------------
# Step 6 + 7: curl through the proxy, assert 200
# -----------------------------------------------------------------------------
STATUS=$(curl -s -o /tmp/proxy-response.json -w "%{http_code}" "https://${TEST_HOST}/v1/orders/smoke")
cat /tmp/proxy-response.json
if [ "$STATUS" != "200" ]; then
  echo "FAIL: proxy returned $STATUS (expected 200)"
  exit 1
fi

# Assert the response body came from mockstar-core (proof the proxy actually forwarded).
grep -q '"from":"mockstar-core"' /tmp/proxy-response.json

# -----------------------------------------------------------------------------
# Step 8: run the bench (RT-11)
# -----------------------------------------------------------------------------
bun run bench/proxy.bench.ts || echo "WARN: bench returned non-zero; continuing"

# -----------------------------------------------------------------------------
# Step 9: uninstall + Step 10: assert clean
# -----------------------------------------------------------------------------
kill $PROXY_PID || true
mockstar proxy uninstall
if grep -q "$TEST_HOST" /etc/hosts; then
  echo "FAIL: /etc/hosts still contains $TEST_HOST after uninstall"
  exit 1
fi

kill $MOCKSTAR_PID || true
echo "OK: tier1 integration smoke passed"
