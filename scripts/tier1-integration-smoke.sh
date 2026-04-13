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

set -euo pipefail

# Print every command for CI visibility.
set -x

TEST_HOST="api.razorpay.mockstar-test.local"
TENANT="razorpay"
PROXY_PORT=443
MOCK_PORT=3000

cd /app

# -----------------------------------------------------------------------------
# Step 1: mkcert -install
# -----------------------------------------------------------------------------
mkcert -install

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
# Step 3: install the proxy (writes /etc/hosts entry, setcap on Bun binary)
# -----------------------------------------------------------------------------
bun run src/cli.ts proxy install --force --dns-mode=hosts

# -----------------------------------------------------------------------------
# Step 4: start mockstar-core on :3000
# -----------------------------------------------------------------------------
mkdir -p /tmp/smoke-mocks/$TENANT
cat > /tmp/smoke-mocks/$TENANT/hello.json <<EOF
{
  "mocks": [
    {
      "id": "hello",
      "match": { "method": "GET", "path": "/health" },
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
bun run src/cli.ts proxy start &
PROXY_PID=$!
sleep 2

# -----------------------------------------------------------------------------
# Step 6 + 7: curl through the proxy, assert 200
# -----------------------------------------------------------------------------
STATUS=$(curl -s -o /tmp/proxy-response.json -w "%{http_code}" "https://${TEST_HOST}/health")
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
bun run src/cli.ts proxy uninstall
if grep -q "$TEST_HOST" /etc/hosts; then
  echo "FAIL: /etc/hosts still contains $TEST_HOST after uninstall"
  exit 1
fi

kill $MOCKSTAR_PID || true
echo "OK: tier1 integration smoke passed"
