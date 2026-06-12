#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATES_DIR="$REPO_DIR/templates"

mkdir -p "$TEMPLATES_DIR"

REPOS=(
  "agency-agents|https://github.com/msitarzewski/agency-agents.git"
  "agency-agents-zh|https://github.com/jnMetaCode/agency-agents-zh.git"
)

for entry in "${REPOS[@]}"; do
  dir="${entry%%|*}"
  url="${entry##*|}"
  target="$TEMPLATES_DIR/$dir"

  if [ -d "$target/.git" ]; then
    echo "[sync] Pulling $dir..."
    git -C "$target" pull --ff-only
  else
    echo "[sync] Cloning $dir..."
    git clone --depth 1 "$url" "$target"
  fi
done

echo "[sync] Generating template index..."
cd "$REPO_DIR"
npx tsx "$SCRIPT_DIR/generate-template-index.ts"

echo "[sync] Done. Templates synced to $TEMPLATES_DIR"
