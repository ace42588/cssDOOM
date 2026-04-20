#!/usr/bin/env bash
# provision_lxc.sh - SSH a rendered pct-create script to the Proxmox node
# and capture the resulting host.json (ip, id, kind).
#
# Usage:
#   bash provision_lxc.sh deploy-work/<APP>/draft/provision.sh
#
# Requires env: PVE_HOST, PVE_SSH_USER (default: root).
# Writes host.json next to the brief (deploy-work/<APP>/brief/host.json).

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "usage: provision_lxc.sh <rendered-provision.sh>" >&2
    exit 2
fi

SCRIPT_PATH="$1"
[[ -f "${SCRIPT_PATH}" ]] || { echo "provision_lxc: ${SCRIPT_PATH} not found" >&2; exit 2; }

: "${PVE_HOST:?PVE_HOST not set}"
PVE_SSH_USER="${PVE_SSH_USER:-root}"

# Brief lives at deploy-work/<APP>/brief/, draft at deploy-work/<APP>/draft/
APP_DIR="$(dirname "$(dirname "${SCRIPT_PATH}")")"
HOST_JSON="${APP_DIR}/brief/host.json"

REMOTE_PATH="/tmp/$(basename "${SCRIPT_PATH}").$$"

scp -q -o StrictHostKeyChecking=accept-new \
    "${SCRIPT_PATH}" "${PVE_SSH_USER}@${PVE_HOST}:${REMOTE_PATH}"

# The rendered script's last line is the JSON we want to capture; everything
# else (pct create chatter) goes to stderr so the JSON parse stays clean.
OUTPUT="$(ssh -o StrictHostKeyChecking=accept-new "${PVE_SSH_USER}@${PVE_HOST}" \
    "bash ${REMOTE_PATH}; rm -f ${REMOTE_PATH}")"

LAST_LINE="$(printf '%s\n' "${OUTPUT}" | tail -n1)"
if ! printf '%s' "${LAST_LINE}" | python3 -c 'import json,sys; json.loads(sys.stdin.read())' >/dev/null 2>&1; then
    echo "provision_lxc: did not get JSON from remote; full output:" >&2
    printf '%s\n' "${OUTPUT}" >&2
    exit 5
fi

mkdir -p "$(dirname "${HOST_JSON}")"
printf '%s\n' "${LAST_LINE}" > "${HOST_JSON}"
echo "provision_lxc: wrote ${HOST_JSON}"
cat "${HOST_JSON}"
