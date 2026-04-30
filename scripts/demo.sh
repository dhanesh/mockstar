#!/usr/bin/env bash
# Scripted demo flow recorded by `make record-demo`.
# Runs end-to-end against a real container — no mocked output.

set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=./demo-lib.sh
source scripts/demo-lib.sh

cleanup() { make docker-stop >/dev/null 2>&1 || true; }
trap cleanup EXIT

clear

note "mockstar — terminal demo (Docker + curl)"
sleep 0.8

# 1. One command brings the server up with the bundled examples.
run "make docker-run"
wait_for_ready
sleep 0.6

# 2. Happy path — request reflection + faker templating.
note "request templating: id reflects {42}, faker fills the rest"
run "curl -s http://localhost:3000/users/42 | jq"

# 3. Scenario routing by path param — same route, different id, different status.
note "scenario routing by path param: /users/not-found -> 404"
run "curl -si http://localhost:3000/users/not-found | head -5"

# 4. Scenario routing by request header.
note "scenario routing by header: x-role: guest -> 403"
run "curl -si -H 'x-role: guest' http://localhost:3000/users/42 | head -5"

# 5. Scenario routing by request body (POST).
note "scenario routing by body: blocked email domain -> 422"
run "curl -s -X POST http://localhost:3000/users \\
    -H 'content-type: application/json' \\
    -d '{\"name\":\"Alice\",\"email\":\"a@blocked.com\"}' | jq"

# 6. Multi-tenancy — same path, different tenant, different shape.
note "multi-tenant: x-mockstar-tenant: razorpay -> razorpay-shaped order"
run "curl -s -X POST http://localhost:3000/v1/orders \\
    -H 'x-mockstar-tenant: razorpay' \\
    -H 'content-type: application/json' \\
    -d '{\"amount\":50000,\"currency\":\"INR\",\"receipt\":\"rcpt_001\"}' | jq"

# 7. Cleanup.
run "make docker-stop"

sleep 1.2
note "https://github.com/your-org/mockstar"
sleep 1.5
