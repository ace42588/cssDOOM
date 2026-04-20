#!/usr/bin/env bash
# scaffold.sh - create the deploy-work/<APP_NAME>/ working directory layout.
#
# Usage: bash .cursor/skills/deploy-node-proxmox-pingaccess/scripts/scaffold.sh <APP_NAME>
#
# Layout created (idempotent):
#   deploy-work/<APP_NAME>/
#     brief/    detect.json, target.txt, BRIEF.md, host.json
#     draft/    rendered provision/compose/PA JSON
#     out/      final artifact summaries (pa-resources.json, etc.)
#     logs/     per-phase tee'd output
#     deploy.log
#
# Adds deploy-work/ to .gitignore if a .gitignore exists and the entry
# is missing.

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "usage: scaffold.sh <APP_NAME>" >&2
    exit 2
fi

NAME="$1"
case "$NAME" in
    *[!A-Za-z0-9._-]*)
        echo "scaffold.sh: APP_NAME must be [A-Za-z0-9._-]+" >&2
        exit 2
        ;;
esac

ROOT="deploy-work/${NAME}"
mkdir -p "${ROOT}/brief" "${ROOT}/draft" "${ROOT}/out" "${ROOT}/logs"
: > "${ROOT}/deploy.log"

if [[ -f .gitignore ]] && ! grep -qE '^deploy-work/?$' .gitignore; then
    printf '\n# deploy-node-proxmox-pingaccess skill working directory\ndeploy-work/\n' >> .gitignore
    echo "scaffold.sh: appended deploy-work/ to .gitignore"
fi

echo "${ROOT}"
