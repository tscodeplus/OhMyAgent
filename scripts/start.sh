#!/bin/bash
# ============================================================================
# start.sh — OhMyAgent startup script (tmux)
#
# Usage:
#   bash scripts/start.sh           # Start or reconnect
#   bash scripts/start.sh attach    # Reattach to existing session
#   bash scripts/start.sh stop      # Stop
#   bash scripts/start.sh status    # View status
#   bash scripts/start.sh restart   # Restart
# ============================================================================

set -euo pipefail

PORT="${OHMYAGENT_PORT:-${PORT:-9191}}"
SESSION_NAME="ohmyagent"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

session_exists() {
  tmux has-session -t "$SESSION_NAME" 2>/dev/null
}

do_start() {
  if session_exists; then
    info "tmux session '$SESSION_NAME' already exists"
    info "Use 'bash scripts/start.sh attach' to reconnect"
    return
  fi

  cd "$PROJECT_DIR"

  if [ ! -d "node_modules" ]; then
    info "Installing dependencies..."
    unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY 2>/dev/null || true
    pnpm install
  fi

  info "Starting OhMyAgent tmux session..."

  tmux new-session -d -s "$SESSION_NAME" -n "ohmyagent" \
    "cd $PROJECT_DIR && OHMYAGENT_PORT=$PORT while true; do node dist/src/index.js >> data/logs/ohmyagent.log 2>&1; echo '[ohmyagent] Process exited, restarting in 3s...'; sleep 3; done"

  info "OhMyAgent started"
  echo ""
  echo "  View logs:  bash scripts/start.sh attach"
  echo "  Stop:       bash scripts/start.sh stop"
  echo "  Status:     bash scripts/start.sh status"
  echo ""
}

do_attach() {
  if ! session_exists; then
    error "tmux session '$SESSION_NAME' does not exist"
  fi
  tmux attach -t "$SESSION_NAME"
}

do_stop() {
  if ! session_exists; then
    info "tmux session '$SESSION_NAME' does not exist"
    return
  fi

  info "Stopping OhMyAgent session..."
  tmux kill-session -t "$SESSION_NAME"
  info "Stopped"
}

do_status() {
  echo "============================================="
  echo "  OhMyAgent Status"
  echo "============================================="
  echo ""

  if session_exists; then
    info "tmux session: $SESSION_NAME [running]"
  else
    warn "tmux session: $SESSION_NAME [not running]"
  fi

  echo ""

  # Check process
  local pid
  pid=$(pgrep -f "node dist/src/index.js" 2>/dev/null || true)
  if [ -n "$pid" ]; then
    info "node process PID: $pid"
  else
    warn "no node dist/src/index.js process detected"
  fi

  # Check port
  if command -v ss &>/dev/null; then
    local port_info
    port_info=$(ss -tlnp 2>/dev/null | grep ":$PORT" || true)
    if [ -n "$port_info" ]; then
      info "Port $PORT: listening"
    else
      warn "Port $PORT: not listening"
    fi
  fi

  echo ""
}

main() {
  if ! command -v tmux &>/dev/null; then
    warn "tmux not installed, attempting to install..."
    if command -v pkg &>/dev/null; then
      pkg install -y tmux
    else
      error "Please install tmux manually"
    fi
  fi

  local cmd="${1:-start}"
  case "$cmd" in
    start)
      do_start
      ;;
    attach|logs)
      do_attach
      ;;
    stop)
      do_stop
      ;;
    status)
      do_status
      ;;
    restart)
      do_stop
      sleep 1
      do_start
      ;;
    *)
      echo "Usage: $0 {start|attach|stop|restart|status}"
      exit 1
      ;;
  esac
}

main "$@"
