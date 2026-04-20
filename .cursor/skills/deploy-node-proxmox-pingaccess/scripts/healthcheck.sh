#!/usr/bin/env bash
# healthcheck.sh - verify the deployed app is reachable directly and
# through PingAccess.
#
# Usage:
#   bash healthcheck.sh deploy-work/<APP>/brief/BRIEF.md
#
# Reads BACKEND_HOST, BACKEND_WEB_PORT, PUBLIC_HOSTNAME from the brief
# (greps `KEY: value` lines, simple but sufficient). Falls back to
# host.json + the env when the brief is incomplete.

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "usage: healthcheck.sh <BRIEF.md>" >&2
    exit 2
fi

BRIEF="$1"
[[ -f "${BRIEF}" ]] || { echo "healthcheck: ${BRIEF} not found" >&2; exit 2; }

APP_DIR="$(dirname "$(dirname "${BRIEF}")")"
HOST_JSON="${APP_DIR}/brief/host.json"

read_brief() {
    grep -E "^[[:space:]]*-?[[:space:]]*\`?$1\`?[[:space:]]*[:=]" "${BRIEF}" \
        | head -n1 \
        | sed -E "s/.*[:=][[:space:]]*\`?([^\`]+)\`?.*/\1/"
}

BACKEND_HOST="$(read_brief BACKEND_HOST || true)"
if [[ -z "${BACKEND_HOST:-}" && -f "${HOST_JSON}" ]]; then
    BACKEND_HOST="$(python3 -c "import json,sys; print(json.load(open('${HOST_JSON}'))['ip'])")"
fi
BACKEND_WEB_PORT="$(read_brief BACKEND_WEB_PORT || true)"
BACKEND_WEB_PORT="${BACKEND_WEB_PORT:-8080}"
PUBLIC_HOSTNAME="$(read_brief PUBLIC_HOSTNAME || true)"
PUBLIC_HOSTNAME="${PUBLIC_HOSTNAME:-${PUBLIC_HOSTNAME_ENV:-}}"

PASS=0
FAIL=0
result() {
    local status="$1" label="$2"
    if [[ "${status}" == "PASS" ]]; then
        printf '  [PASS] %s\n' "${label}"
        PASS=$((PASS+1))
    else
        printf '  [FAIL] %s\n' "${label}"
        FAIL=$((FAIL+1))
    fi
}

echo "healthcheck: probes for $(basename "${APP_DIR}")"

if [[ -n "${BACKEND_HOST}" ]]; then
    URL="http://${BACKEND_HOST}:${BACKEND_WEB_PORT}/healthz"
    if curl -fsS --max-time 5 "${URL}" >/dev/null; then
        result PASS "backend direct: ${URL}"
    else
        result FAIL "backend direct: ${URL}"
    fi
else
    result FAIL "backend direct: BACKEND_HOST unknown"
fi

if [[ -n "${PUBLIC_HOSTNAME}" ]]; then
    URL="https://${PUBLIC_HOSTNAME}/healthz"
    if curl -fsS --max-time 10 "${URL}" >/dev/null; then
        result PASS "through PingAccess: ${URL}"
    else
        result FAIL "through PingAccess: ${URL}"
    fi

    WS_URL="https://${PUBLIC_HOSTNAME}/ws"
    HTTP_CODE="$(curl -k -s -o /dev/null -w '%{http_code}' --max-time 10 \
        -H 'Upgrade: websocket' \
        -H 'Connection: Upgrade' \
        -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
        -H 'Sec-WebSocket-Version: 13' \
        "${WS_URL}")"
    if [[ "${HTTP_CODE}" == "101" ]]; then
        result PASS "WebSocket upgrade: ${WS_URL} (101)"
    else
        result FAIL "WebSocket upgrade: ${WS_URL} (got ${HTTP_CODE})"
    fi
else
    result FAIL "through PingAccess: PUBLIC_HOSTNAME unknown"
fi

printf '\nhealthcheck: %d passed, %d failed\n' "${PASS}" "${FAIL}"
[[ "${FAIL}" -eq 0 ]]
