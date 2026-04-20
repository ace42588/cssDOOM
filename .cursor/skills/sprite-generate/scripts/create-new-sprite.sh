#!/usr/bin/env bash
# Usage: bash .cursor/skills/sprite-generate/scripts/create-new-sprite.sh RBSP
set -euo pipefail

NAME="${1:-}"

if [[ -z "$NAME" ]]; then
  echo "ERROR: Sprite name required."
  echo "Usage: create-new-sprite.sh <NAME>  (e.g. RBSP)"
  exit 1
fi

if [[ ! "$NAME" =~ ^[A-Z0-9]{4}$ ]]; then
  echo "ERROR: Sprite name must be exactly 4 uppercase alphanumeric characters."
  exit 1
fi

WORKSPACE="sprites/$NAME"

if [[ -d "$WORKSPACE" ]]; then
  echo "ERROR: Workspace already exists at $WORKSPACE"
  exit 1
fi

mkdir -p "$WORKSPACE/cells"
mkdir -p "$WORKSPACE/sheets"
touch "$WORKSPACE/SPEC.md"

echo ""
echo "Workspace created: $WORKSPACE"
echo ""
echo "  $WORKSPACE/"
echo "  ├── SPEC.md       ← Phase A will write here"
echo "  ├── cells/        ← Phase B will write here"
echo "  └── sheets/       ← assemble_sprite.py will write here"
echo ""
echo "Next: invoke /sprite-generate with this character (name: $NAME)"