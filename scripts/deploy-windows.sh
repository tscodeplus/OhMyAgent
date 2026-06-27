#!/bin/bash
# ============================================================================
# deploy-windows.sh — Dev tool: deploy from WSL to Windows host
#
# Copies source from WSL to a Windows-accessible path and rebuilds.
# The Windows path is accessed via /mnt/<drive>/ from WSL.
#
# Usage:
#   bash scripts/deploy-windows.sh              # Deploy/update
#   bash scripts/deploy-windows.sh start        # Start service only
#   bash scripts/deploy-windows.sh stop         # Stop service only
#   bash scripts/deploy-windows.sh restart      # Restart service
#   bash scripts/deploy-windows.sh status       # View status
#   bash scripts/deploy-windows.sh logs         # View task logs
#
# Config:
#   WIN_DEPLOY_PATH — Windows project path (default: /mnt/e/Code/OhMyAgent)
# ============================================================================

set -euo pipefail

WIN_DEPLOY_PATH="${WIN_DEPLOY_PATH:-/mnt/e/Code/OhMyAgent}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Convert WSL path to Windows path for PowerShell commands
# /mnt/e/Code/OhMyAgent → E:\Code\OhMyAgent
WIN_PATH=$(echo "$WIN_DEPLOY_PATH" | sed 's|^/mnt/\([a-z]\)/|\U\1:\\|; s|/|\\|g')

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
step()  { echo -e "${CYAN}[$1/7]${NC} $2"; }

# ─── Verify Windows path is accessible ───
check_path() {
  if [ ! -d "$WIN_DEPLOY_PATH" ]; then
    error "Windows path not found: $WIN_DEPLOY_PATH\n  Clone the repo on Windows first:\n  git clone <repo-url> E:\\Code\\OhMyAgent"
  fi
  info "Deploy target: $WIN_DEPLOY_PATH"
}

# ─── Package source (respects .gitignore) ───
package_source() {
  step 1 "Packaging source (respecting .gitignore)..."
  cd "$PROJECT_DIR"

  # Collect git-aware file list (same approach as deploy-termux.sh)
  local filelist
  filelist=$(mktemp)
  {
    # Tracked files
    git ls-files -z --cached
    # Untracked files not ignored
    git ls-files -z --others --exclude-standard
  } > "$filelist"

  # No .git — Windows uses schtasks, not git pull
  tar -czf /tmp/ohmyagent-win-deploy.tar.gz --null -T "$filelist"

  rm -f "$filelist"

  local size
  size=$(du -h /tmp/ohmyagent-win-deploy.tar.gz | cut -f1)
  info "Packaged: /tmp/ohmyagent-win-deploy.tar.gz ($size)"
}

# ─── Extract to Windows path ───
extract_source() {
  step 2 "Extracting source to Windows..."
  rm -rf "$WIN_DEPLOY_PATH/dist" "$WIN_DEPLOY_PATH/src"
  tar xzf /tmp/ohmyagent-win-deploy.tar.gz -C "$WIN_DEPLOY_PATH"
  rm -f /tmp/ohmyagent-win-deploy.tar.gz
  info "Source extracted"
}

# ─── Install dependencies ───
install_deps() {
  step 3 "Installing dependencies (via PowerShell)..."
  powershell.exe -Command "
    cd '$WIN_PATH';
    Write-Host '  Running pnpm install...';
    pnpm install 2>&1 | Select-Object -Last 5;
  " || warn "pnpm install had warnings (may need pnpm approve-builds for native modules)"
}

# ─── Build ───
build() {
  step 4 "Building TypeScript (via PowerShell)..."
  powershell.exe -Command "
    cd '$WIN_PATH';
    pnpm build 2>&1 | Select-Object -Last 3;
  "
  info "Backend build complete"

  step 5 "Building WebUI frontend (via PowerShell)..."
  powershell.exe -Command "
    cd '$WIN_PATH';
    if (Test-Path ui/package.json) {
      cd ui;
      pnpm install 2>&1 | Select-Object -Last 3;
      pnpm build 2>&1 | Select-Object -Last 3;
      cd ..;
      Write-Host '  WebUI built to ui/dist/';
    } else {
      Write-Host '  ui/package.json not found, skipping WebUI build';
    }
  "
  info "Build complete"
}

# ─── Stop existing service ───
stop_service() {
  step 6 "Stopping scheduled task..."
  powershell.exe -Command "
    cd '$WIN_PATH';
    \$task = schtasks /Query /TN 'OhMyAgent' 2>\$null;
    if (\$LASTEXITCODE -eq 0) {
      Write-Host '  Stopping scheduled task...';
      schtasks /End /TN 'OhMyAgent' 2>&1;
      Start-Sleep 3;
      Write-Host '  Stopped.';
    } else {
      Write-Host '  Task not installed, skipping.';
    }
  " || true
}

# ─── Start service ───
start_service() {
  step 7 "Starting scheduled task..."
  powershell.exe -Command "
    cd '$WIN_PATH';
    \$task = schtasks /Query /TN 'OhMyAgent' 2>\$null;
    if (\$LASTEXITCODE -eq 0) {
      schtasks /Run /TN 'OhMyAgent' 2>&1;
    } else {
      Write-Host '  Task not installed. Run: ohmyagent service install';
      exit 1;
    }
    Start-Sleep 6;
    try {
      \$port = if (\$env:OHMYAGENT_PORT) { \$env:OHMYAGENT_PORT } elseif (\$env:PORT) { \$env:PORT } else { '9191' };
      \$r = Invoke-WebRequest -Uri \"http://127.0.0.1:\$port/health\" -UseBasicParsing -TimeoutSec 3;
      Write-Host '  Health:' \$r.Content;
    } catch {
      Write-Host '  Health check failed — check logs:';
      Write-Host '    E:\\Code\\OhMyAgent\\data/logs/ohmyagent.log';
    }
  "

  # Verify the restart actually happened
  # Verify restart actually happened
  local running
  running=$(powershell.exe -Command "schtasks /Query /TN 'OhMyAgent' 2>&1 | Select-String 'Running'" 2>/dev/null || echo '')
  if [ -z "$running" ]; then
    warn "Task may NOT have started (no admin rights from WSL)."
    warn "Please manually start on Windows (Admin PowerShell):"
    warn "  schtasks /Run /TN 'OhMyAgent'"
  fi
}

# ─── Full deploy ───
do_deploy() {
  echo "============================================="
  echo "  OhMyAgent Windows Deploy (WSL → Windows)"
  echo "============================================="
  echo ""

  check_path
  package_source
  extract_source
  install_deps
  build
  stop_service
  start_service

  echo ""
  info "Deploy complete"
  echo ""
  echo "  Manage on Windows (PowerShell as Administrator):"
  echo "    schtasks /Run /TN ""OhMyAgent""   # Start"
  echo "    schtasks /End /TN ""OhMyAgent""   # Stop"
  echo "    schtasks /Query /TN ""OhMyAgent"" # Status"
  echo "    taskschd.msc                      # GUI"
}

# ─── Status ───
do_status() {
  check_path
  powershell.exe -Command "
    Write-Host '=== Scheduled Task ===';
    schtasks /Query /TN 'OhMyAgent' 2>&1;
    Write-Host '';
    Write-Host '=== Health Check ===';
    try {
      \$port = if (\$env:OHMYAGENT_PORT) { \$env:OHMYAGENT_PORT } elseif (\$env:PORT) { \$env:PORT } else { '9191' };
      \$r = Invoke-WebRequest -Uri \"http://127.0.0.1:\$port/health\" -UseBasicParsing -TimeoutSec 3;
      Write-Host '  OK:' \$r.Content;
    } catch {
      Write-Host '  Not responding';
    }
  "
}

# ─── Logs ───
do_logs() {
  local logfile="$WIN_DEPLOY_PATH/data/logs/ohmyagent.log"
  if [ -f "$logfile" ]; then
    tail -f "$logfile"
  else
    warn "Log file not found: $logfile"
    echo "  Check: $WIN_DEPLOY_PATH/ohmyagent-service.err.log"
  fi
}

# ─── Main ───
main() {
  local cmd="${1:-deploy}"

  case "$cmd" in
    deploy)
      do_deploy
      ;;
    start)
      check_path
      start_service
      ;;
    stop)
      check_path
      stop_service
      ;;
    restart)
      check_path
      stop_service
      start_service
      ;;
    status)
      do_status
      ;;
    logs)
      do_logs
      ;;
    *)
      echo "Usage: $0 {deploy|start|stop|restart|status|logs}"
      echo ""
      echo "  deploy   - Full deploy (package → extract → install → build → start)"
      echo "  start    - Start scheduled task only"
      echo "  stop     - Stop scheduled task only"
      echo "  restart  - Restart scheduled task"
      echo "  status   - View task status and health"
      echo "  logs     - View task logs (tail -f)"
      echo ""
      echo "  Config: WIN_DEPLOY_PATH=$WIN_DEPLOY_PATH"
      exit 1
      ;;
  esac
}

main "$@"
