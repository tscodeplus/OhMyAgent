#!/bin/bash
# ============================================================================
# deploy-termux.sh — Dev tool: deploy from desktop/WSL to Termux over SSH
#
# Packages git-tracked files on dev machine and transfers them to Termux via SCP.
# For end-user installation directly on Termux, use install.sh instead.
#
# Usage:
#   bash scripts/deploy-termux.sh              # Deploy/update (preserve database)
#   DELETE_DATABASE=true bash scripts/deploy-termux.sh  # Deploy with fresh DB
#   bash scripts/deploy-termux.sh start        # Start only
#   bash scripts/deploy-termux.sh stop         # Stop only
#   bash scripts/deploy-termux.sh restart      # Restart only
#   bash scripts/deploy-termux.sh status       # View status
#   bash scripts/deploy-termux.sh logs         # View logs (tail -f)
#
# Config:
#   Reads ~/.ssh/termux_askpass for SSH password by default.
#   Override with env vars: TERMUX_HOST / TERMUX_PORT / TERMUX_USER
# ============================================================================

set -euo pipefail

# ─── Configuration ───
TERMUX_HOST="${TERMUX_HOST:-192.168.1.201}"
TERMUX_PORT="${TERMUX_PORT:-8022}"
TERMUX_USER="${TERMUX_USER:-u0_a4}"
TERMUX_PROJECT_DIR="${TERMUX_PROJECT_DIR:-~/.ohmyagent}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_TARBALL="/tmp/ohmyagent-deploy.tar.gz"
SESSION_NAME="ohmyagent"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ─── SSH setup ───
setup_ssh() {
  export SSH_ASKPASS="${HOME}/.ssh/termux_askpass"
  export SSH_ASKPASS_REQUIRE="force"
  export DISPLAY=:0

  if [ ! -f "$SSH_ASKPASS" ]; then
    warn "SSH_ASKPASS script not found: $SSH_ASKPASS"
    warn "Creating temporary askpass..."
    mkdir -p "$(dirname "$SSH_ASKPASS")"
    if [ -n "${TERMUX_PASSWORD:-}" ]; then
      echo "#!/bin/sh"; echo "echo '${TERMUX_PASSWORD}'" > "$SSH_ASKPASS"
      chmod 700 "$SSH_ASKPASS"
    else
      error "Set TERMUX_PASSWORD env var or create $SSH_ASKPASS"
    fi
  fi
}

ssh_cmd() {
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p "$TERMUX_PORT" "${TERMUX_USER}@${TERMUX_HOST}" "$@"
}

# ─── Package source (include .git so git pull works on remote) ───
# Uses git ls-files to respect .gitignore, then appends .git directory for
# remote git pull support. Untracked files not covered by .gitignore are also
# included (--others --exclude-standard) so local dev changes deploy correctly.
package_source() {
  info "Packaging project source (respecting .gitignore)..."
  cd "$PROJECT_DIR"

  # Collect git-aware file list (respects .gitignore + .git/info/exclude)
  local filelist
  filelist=$(mktemp)
  {
    # Tracked files
    git ls-files -z --cached
    # Untracked files not ignored
    git ls-files -z --others --exclude-standard
  } > "$filelist"

  # Package file list + .git directory (needed for git pull on remote)
  tar -czf "$DEPLOY_TARBALL" \
    --null -T "$filelist" \
    .git

  rm -f "$filelist"

  local size
  size=$(du -h "$DEPLOY_TARBALL" | cut -f1)
  info "Packaged: $DEPLOY_TARBALL ($size)"
}

# ─── Transfer ───
transfer() {
  info "Transferring to Termux..."
  scp -o StrictHostKeyChecking=no -P "$TERMUX_PORT" \
    "$DEPLOY_TARBALL" "${TERMUX_USER}@${TERMUX_HOST}:~/ohmyagent-deploy.tar.gz"
  info "Transfer complete"
}

# ─── Stop service ───
stop_service() {
  info "Stopping ohmyagent service..."
  # sv down sends TERM to the runit service. On Termux, pkill -f can
  # inadvertently kill the SSH session, so we rely solely on sv down here.
  ssh_cmd "export SVDIR=\$PREFIX/var/service && sv down ohmyagent 2>/dev/null || true"
  sleep 2
  info "Stopped"
}

# ─── Install & build ───
install_and_build() {
  info "Installing and building on Termux..."

  ssh_cmd "DELETE_DATABASE='${DELETE_DATABASE:-}' bash -s" << 'REMOTE_SCRIPT'
set -e
cd ~/.ohmyagent

# Step 1: Database handling
echo "[1/7] Database..."
if [ "$DELETE_DATABASE" = "true" ]; then
  rm -f data/app.db data/app.db-wal data/app.db-shm
  echo "  Old database removed"
else
  echo "  Preserving database (set DELETE_DATABASE=true to clear)"
fi

# Step 2: Extract source
echo "[2/7] Extracting source..."
# Clean stale compiled output and source directories. extensions/ must also
# be cleaned — stale .js files from previous builds are NOT in the git tarball
# and would be copied by copy-extension-resources.js over fresh tsc output.
rm -rf dist src extensions
tar xzf ~/ohmyagent-deploy.tar.gz
rm ~/ohmyagent-deploy.tar.gz

# Make git remote use HTTPS so git pull works without SSH keys
if [ -d .git ]; then
  git remote set-url origin https://github.com/tscodeplus/OhMyAgent.git 2>/dev/null || true
  echo "  Git remote set to HTTPS"
fi

# Step 3: Install dependencies (full output — don't hide errors with tail)
echo "[3/7] Installing dependencies..."
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY 2>/dev/null || true
# Native builds (better-sqlite3, sqlite-vec) must compile against Termux's
# local Node headers via $PREFIX — otherwise node-gyp tries to download
# node-vX-headers.tar.gz from nodejs.org, which often fails on the device.
export ANDROID_NDK_HOME="$PREFIX"
export npm_config_nodedir="$PREFIX"
# sharp has no prebuilt for Termux and its source build (needs libvips) always
# fails. It is optional at runtime (nut-js screenshots degrade gracefully), so
# drop it from the build allow-list on the device (pnpm 11 allowBuilds map /
# onlyBuiltDependencies list / .npmrc array entries — match any line loosely
# because indentation differs between the two pnpm config formats).
sed -i '/sharp/d' pnpm-workspace.yaml
sed -i '/sharp/d' .npmrc
# Over SSH there is no TTY, so when pnpm decides the existing modules dir
# (e.g. an older pnpm layout) must be purged it aborts with
# ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY instead of asking. Try the fast
# incremental install first; fall back to a from-scratch install (the pnpm
# store cache keeps this fast) only when pnpm actually aborted on the purge
# prompt — other failures are surfaced as-is.
INSTALL_LOG=$(mktemp)
if ! pnpm install > "$INSTALL_LOG" 2>&1; then
  if grep -q "NO_TTY" "$INSTALL_LOG"; then
    echo "  Incremental install aborted (no-TTY purge prompt); installing from scratch..."
    rm -rf node_modules
    pnpm install 2>&1
  else
    echo "  pnpm install failed:"
    cat "$INSTALL_LOG"
    rm -f "$INSTALL_LOG"
    exit 1
  fi
fi
rm -f "$INSTALL_LOG"

# sharp: no prebuilt for Termux, but it compiles against the system libvips
# (pkg install libvips) via SHARP_FORCE_GLOBAL_LIBVIPS. It is optional at
# runtime (nut-js screenshots degrade gracefully), so a failed build is
# non-fatal — but it used to work on this device, so keep it working.
echo "[3b/7] Checking sharp..."
if node -e "require('sharp')" >/dev/null 2>&1; then
  echo "  sharp already available"
else
  echo "  Building sharp against system libvips..."
  pkg install -y pkg-config binutils xorgproto libvips >/dev/null 2>&1 || true
  pnpm add -D --ignore-scripts node-addon-api node-gyp >/dev/null 2>&1 || true
  # pnpm rebuild silently skips sharp (it is not in the build allow-list on
  # the device), so run sharp's own build script directly. Needs
  # ANDROID_NDK_HOME (set above) or node-gyp fails with
  # "Undefined variable android_ndk_path in binding.gyp".
  SHARP_PKG_DIR=$(find node_modules/.pnpm -maxdepth 1 -type d -name 'sharp@*' | head -1)/node_modules/sharp
  (cd "$SHARP_PKG_DIR" && SHARP_FORCE_GLOBAL_LIBVIPS=1 npm run build) 2>&1 | tail -5 || true
  if node -e "require('sharp')" >/dev/null 2>&1; then
    echo "  sharp OK"
  else
    echo "  sharp build failed (optional, continuing)"
  fi
fi

# Step 5: Compile better-sqlite3
echo "[4/7] Checking better-sqlite3..."
export ANDROID_NDK_HOME="$PREFIX"
export npm_config_nodedir="$PREFIX"
if [ -n "$(find node_modules -name better_sqlite3.node -path '*/better-sqlite3/*' 2>/dev/null | head -1)" ]; then echo "  Skipping rebuild (binary exists)"; else echo "  Rebuilding better-sqlite3..."; pnpm rebuild better-sqlite3 2>&1; fi

# Step 6: Compile TypeScript + copy locales + copy extension resources
echo "[5/7] Compiling TypeScript..."
pnpm build

# Verify build output exists before proceeding
if [ ! -f dist/src/index.js ]; then
  echo "ERROR: Build failed — dist/src/index.js not found"
  exit 1
fi
echo "  Build OK: dist/src/index.js exists"

# Step 7: Build WebUI (ui/dist)
echo "[6/7] Building WebUI frontend..."
if [ -f ui/package.json ]; then
  cd ui
  if ! pnpm install > "$INSTALL_LOG" 2>&1; then
    if grep -q "NO_TTY" "$INSTALL_LOG"; then
      echo "  ui install aborted (no-TTY purge); retrying from scratch..."
      rm -rf node_modules
      pnpm install 2>&1
    else
      echo "  ui pnpm install failed:"
      cat "$INSTALL_LOG"
      rm -f "$INSTALL_LOG"
      exit 1
    fi
  fi
  rm -f "$INSTALL_LOG"
  pnpm build 2>&1
  cd ..
  echo "  WebUI built to ui/dist/"
else
  echo "  ui/package.json not found, skipping WebUI build"
fi

# Configure runit (sv) service
SERVICE_DIR="$PREFIX/var/service/ohmyagent"
mkdir -p "$SERVICE_DIR/log"

cat > "$SERVICE_DIR/run" << 'RUNEOF'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock >/dev/null 2>&1 || true
export ANDROID_NDK_HOME=/data/data/com.termux/files/usr
export npm_config_nodedir=/data/data/com.termux/files/usr
export WEBUI_STATIC_ROOT=/data/data/com.termux/files/home/.ohmyagent/ui/dist
cd /data/data/com.termux/files/home/.ohmyagent
exec /data/data/com.termux/files/usr/bin/node dist/src/index.js 2>&1
RUNEOF
chmod +x "$SERVICE_DIR/run"

cat > "$SERVICE_DIR/log/run" << 'LOGEOF'
#!/data/data/com.termux/files/usr/bin/bash
exec svlogd -tt /data/data/com.termux/files/home/.ohmyagent/data/logs/
LOGEOF
chmod +x "$SERVICE_DIR/log/run"

# Ensure runtime directories exist
mkdir -p data/logs

echo "Install and build complete"
REMOTE_SCRIPT

  info "Install and build complete"
}

# ─── Start service ───
start_service() {
  info "Restarting ohmyagent service (force-restart)..."
  ssh_cmd "export SVDIR=\$PREFIX/var/service && sv force-restart ohmyagent 2>&1 || true"
  # Termux cold start takes a while (better-sqlite3 init, embedding models,
  # WebSocket connect) — 6s was too short and the health check warned falsely.
  sleep 20

  info "Verifying service..."
  local status
  status=$(ssh_cmd "export SVDIR=\$PREFIX/var/service && sv status ohmyagent 2>&1")
  echo "  $status"

  local http_code
  # `; true` keeps ssh's exit code 0 even when curl fails, so http_code is
  # exactly curl's %{http_code} (302/200, or 000 on connection failure).
  http_code=$(ssh_cmd "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:\${PORT:-9191}/ 2>/dev/null; true" || echo "000")
  if [ "$http_code" != "000" ]; then
    info "HTTP service OK (status: $http_code)"
  else
    warn "HTTP service not responding, check logs: bash scripts/deploy-termux.sh logs"
  fi
}

# ─── Full deploy ───
do_deploy() {
  echo "============================================="
  echo "  OhMyAgent Termux Deploy"
  echo "============================================="
  echo ""

  setup_ssh
  package_source
  transfer
  stop_service
  install_and_build
  start_service

  echo ""
  info "Deploy complete"
}

# ─── Logs ───
do_logs() {
  setup_ssh
  ssh_cmd 'tail -f ~/.ohmyagent/data/logs/current'
}

# ─── Status ───
do_status() {
  setup_ssh
  echo "=== sv status ==="
  ssh_cmd "export SVDIR=\$PREFIX/var/service && sv status ohmyagent 2>&1"
  echo ""
  echo "=== HTTP check ==="
  ssh_cmd "curl -s -o /dev/null -w 'HTTP: %{http_code}\n' http://127.0.0.1:\${PORT:-9191}/ 2>/dev/null || echo 'No response'"
  echo ""
  echo "=== Recent logs ==="
  ssh_cmd 'tail -10 ~/.ohmyagent/data/logs/current 2>/dev/null'
}

# ─── Main ───
main() {
  local cmd="${1:-deploy}"

  case "$cmd" in
    deploy)
      do_deploy
      ;;
    start)
      setup_ssh
      start_service
      ;;
    stop)
      setup_ssh
      stop_service
      ;;
    restart)
      setup_ssh
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
      echo "  deploy   - Full deploy (package → transfer → install → start)"
      echo "  start    - Start service only"
      echo "  stop     - Stop service only"
      echo "  restart  - Restart service"
      echo "  status   - View status"
      echo "  logs     - View logs (tail -f)"
      exit 1
      ;;
  esac
}

main "$@"
