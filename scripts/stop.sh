#!/bin/bash
# ============================================================================
# stop.sh — Stop OhMyAgent
# ============================================================================

set -euo pipefail

PORT="${OHMYAGENT_PORT:-${PORT:-9191}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

SESSION_NAME="ohmyagent"

if command -v tmux &>/dev/null && tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "[INFO] Stopping tmux session: $SESSION_NAME"
  tmux kill-session -t "$SESSION_NAME"
  echo "[INFO] Stopped"
elif [ -d "/data/data/com.termux" ]; then
  echo "[INFO] Attempting to stop OhMyAgent (port $PORT)..."
  fuser -k $PORT/tcp 2>/dev/null && echo "[INFO] Stopped" || echo "[INFO] No running OhMyAgent detected"
else
  echo "[INFO] Attempting to stop OhMyAgent (port $PORT)..."
  fuser -k $PORT/tcp 2>/dev/null && echo "[INFO] Stopped" || echo "[INFO] No running OhMyAgent detected"
fi
