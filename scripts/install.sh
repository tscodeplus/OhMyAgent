#!/bin/bash
# ============================================================================
# install.sh — OhMyAgent one-click install script (Linux / macOS / Termux)
#
# Usage:
#   git clone <repo-url> ~/.ohmyagent
#   cd ~/.ohmyagent
#   bash scripts/install.sh
# ============================================================================

set -euo pipefail

# cd to project root (parent of scripts/ directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
step()  { echo -e "${CYAN}[$1/7]${NC} $2"; }

echo "============================================="
echo "  OhMyAgent Installer"
echo "============================================="
echo ""

# ─── Platform detection ───
PLATFORM="$(uname -s)"
IS_TERMUX=false
if [ -d "/data/data/com.termux" ] || [ -n "${PREFIX:-}" ]; then
  IS_TERMUX=true
  info "Platform: Termux (Android)"
else
  info "Platform: $PLATFORM"
fi

# ─── Step 1: Check Node.js >= 20 ───
step 1 "Checking Node.js >= 20..."
if ! command -v node &>/dev/null; then
  error "Node.js is not installed. Please install Node.js >= 20:
  Linux:  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  macOS:  brew install node@20"
fi

NODE_MAJOR=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ]; then
  error "Node.js >= 20 is required, current version: $(node -v)"
fi
info "Node.js $(node -v)"

# ─── Step 2: Install pnpm ───
step 2 "Installing pnpm..."
if ! command -v pnpm &>/dev/null; then
  npm install -g pnpm 2>/dev/null || {
    warn "npm install -g pnpm failed, trying corepack..."
    corepack enable pnpm 2>/dev/null || error "Please install pnpm manually: npm install -g pnpm"
  }
fi
info "pnpm $(pnpm -v)"

# ─── Step 3: Install dependencies ───
step 3 "Installing dependencies..."
pnpm install

# ─── Step 4: Build ───
step 4 "Building TypeScript..."
pnpm build

# ─── Step 4b: Build WebUI ───
step 4b "Building WebUI frontend..."
if [ -f ui/package.json ]; then
  cd ui && pnpm install && pnpm build && cd ..
  info "WebUI built to ui/dist/"
else
  warn "ui/package.json not found, skipping WebUI build"
fi

# ─── Step 5: Create directories and config ───
step 5 "Creating runtime directories and config files..."
mkdir -p ~/.ohmyagent/data/logs

if [ ! -f config.yaml ]; then
  if [ -f config.yaml.example ]; then
    cp config.yaml.example config.yaml
    warn "Created config.yaml from config.yaml.example. Please edit with your settings."
  fi
fi

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    warn "Created .env from .env.example. Please fill in your API keys."
  fi
fi

# ─── Step 6: Link CLI ───
step 6 "Setting up ohmyagent command..."
npm link 2>/dev/null || {
  warn "npm link failed. Please run manually: npm link"
}

echo ""
echo "============================================="
info "Installation complete!"
echo "============================================="
echo ""

INSTALLED_SERVICE=false

# ─── Offer to install system service ───
if [ "$IS_TERMUX" = true ]; then
  read -r -p "Install auto-start service? (runit/sv) [y/N]: " -n 1 SERVICE_CHOICE
  echo ""
  if [[ "$SERVICE_CHOICE" =~ ^[Yy]$ ]]; then
    info "Installing runit service..."
    ohmyagent service install && INSTALLED_SERVICE=true
  fi
else
  read -r -p "Install auto-start service? (systemd/launchd) [y/N]: " -n 1 SERVICE_CHOICE
  echo ""
  if [[ "$SERVICE_CHOICE" =~ ^[Yy]$ ]]; then
    info "Installing system service..."
    ohmyagent service install && INSTALLED_SERVICE=true
  fi
fi

echo ""

# ─── Show platform-appropriate next steps ───
echo "  Quick start:"
echo "    1. Edit config.yaml and .env"
echo "    2. ohmyagent doctor        # System diagnostics"

if [ "$INSTALLED_SERVICE" = true ]; then
  if [ "$IS_TERMUX" = true ]; then
    echo ""
    echo "  Service management (runit):"
    echo "    sv status ohmyagent       # Check status"
    echo "    sv up ohmyagent           # Start"
    echo "    sv down ohmyagent         # Stop"
    echo "    sv restart ohmyagent      # Restart"
  else
    echo ""
    echo "  Service management (systemd):"
    echo "    systemctl --user status ohmyagent"
    echo "    systemctl --user stop ohmyagent"
    echo "    systemctl --user restart ohmyagent"
    echo "    journalctl --user -u ohmyagent -f    # Logs"
  fi
  echo ""
  echo "  ohmyagent status also works on all platforms."
else
  echo "    3. ohmyagent start         # Start in background"
  echo "    4. ohmyagent status        # Check status"
  echo ""
  echo "  To install as a system service later: ohmyagent service install"
fi
