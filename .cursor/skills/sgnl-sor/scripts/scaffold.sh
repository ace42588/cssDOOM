#!/usr/bin/env bash
# scaffold.sh — create the sgnl-work/<SOR_NAME>/ working directory layout.
#
# Usage: bash .cursor/skills/sgnl-sor/scripts/scaffold.sh <SOR_NAME>
#
# Layout created (idempotent):
#   sgnl-work/<SOR_NAME>/
#     brief/    completed ENTITY_DESIGN_BRIEF.md
#     draft/    rendered sor.yaml + adapter source
#     out/      final artifacts to copy into the repo
#     validate.log
#
# Adds sgnl-work/ to .gitignore if a .gitignore exists and the entry is
# missing.

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "usage: scaffold.sh <SOR_NAME>" >&2
    exit 2
fi

NAME="$1"
case "$NAME" in
    *[!A-Za-z0-9._-]*)
        echo "scaffold.sh: SOR_NAME must be [A-Za-z0-9._-]+" >&2
        exit 2
        ;;
esac

ROOT="sgnl-work/${NAME}"
mkdir -p "${ROOT}/brief" "${ROOT}/draft" "${ROOT}/out"
: > "${ROOT}/validate.log"

if [[ -f .gitignore ]] && ! grep -qE '^sgnl-work/?$' .gitignore; then
    printf '\n# SGNL SoR skill working directory\nsgnl-work/\n' >> .gitignore
    echo "scaffold.sh: appended sgnl-work/ to .gitignore"
fi

echo "${ROOT}"
