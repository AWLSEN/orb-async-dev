#!/usr/bin/env bash
# Smoke-test a live deployment: GET {live-url}/health must return 200 "ok".
# Reads .orb-state/live-url written by `bun run deploy`.
#
# Exit codes: 0 ok, 1 missing state, 2 non-200 response.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$ROOT/.orb-state"
URL_FILE="$STATE_DIR/live-url"

if [[ ! -f "$URL_FILE" ]]; then
    echo "[smoke] $URL_FILE not found — run \`bun run deploy\` first" >&2
    exit 1
fi

URL="$(cat "$URL_FILE")"
echo "[smoke] GET $URL/health"

status=$(curl -sS -o /tmp/orb-smoke-body -w '%{http_code}' --max-time 30 "$URL/health")
body=$(cat /tmp/orb-smoke-body 2>/dev/null || true)

if [[ "$status" != "200" ]]; then
    echo "[smoke] FAIL status=$status body=$body" >&2
    exit 2
fi
if [[ "$body" != "ok" ]]; then
    echo "[smoke] FAIL expected body 'ok', got: $body" >&2
    exit 2
fi

echo "[smoke] PASS status=$status body=$body"
