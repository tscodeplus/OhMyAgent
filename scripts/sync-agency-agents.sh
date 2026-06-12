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
  tmpdir="$TEMPLATES_DIR/.tmp-$dir"

  echo "[sync] Updating $dir..."

  # Remove previous temp clone if it exists
  rm -rf "$tmpdir"

  # Clone fresh to temp location
  git clone --depth 1 "$url" "$tmpdir"

  # Remove .git so it can be committed as plain files
  rm -rf "$tmpdir/.git"

  # Replace target directory
  rm -rf "$target"
  mv "$tmpdir" "$target"

  echo "[sync] $dir updated"
done

echo "[sync] Generating template index..."
cd "$REPO_DIR"
npx tsx "$SCRIPT_DIR/generate-template-index.ts"

echo "[sync] Done. Templates synced to $TEMPLATES_DIR"
