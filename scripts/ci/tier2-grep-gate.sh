#!/usr/bin/env bash
# Satisfies: RT-9 — CI-level grep gate (provider-agnostic core).
#
# Delegates to the in-process Bun test for consistency with the test suite. A shell re-implementation
# is fragile across grep flavours and escape rules; the Bun test is the source of truth, and this
# wrapper exists so CI can run a single command before the full test suite.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if ! command -v bun >/dev/null 2>&1; then
  echo "ERROR: bun is required for the tier2 grep gate" >&2
  exit 2
fi

exec bun test tests/tier2-provider-agnostic.test.ts
