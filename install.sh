#!/usr/bin/env bash
set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ── Banner ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}${BOLD}║       OhMyAgent Installer           ║${NC}"
echo -e "${CYAN}${BOLD}║   Remembers. Understands. Respects. ║${NC}"
echo -e "${CYAN}${BOLD}╚══════════════════════════════════════╝${NC}"
echo ""

INSTALL_DIR="${OHMYAGENT_INSTALL_DIR:-$HOME/OhMyAgent}"
REPO_URL="https://github.com/tscodeplus/OhMyAgent.git"

# ── Helpers ─────────────────────────────────────────────────────────────────────
info()  { echo -e "  ${CYAN}[•]${NC} $1"; }
ok()    { echo -e "  ${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "  ${YELLOW}[!]${NC} $1"; }
err()   { echo -e "  ${RED}[✗]${NC} $1"; }
abort() { err "$1"; echo ""; exit 1; }

# ── Platform detection ──────────────────────────────────────────────────────────
detect_platform() {
  case "$(uname -s)" in
    Linux)
      if [ -d /data/data/com.termux ] || [ -n "${TERMUX_VERSION:-}" ]; then
        echo "termux"
      else
        echo "linux"
      fi
      ;;
    Darwin) echo "macos" ;;
    *)      echo "unknown" ;;
  esac
}

PLATFORM=$(detect_platform)
info "Detected platform: ${PLATFORM}"

# ── Step 1: Node.js ─────────────────────────────────────────────────────────────
check_node() {
  if command -v node &>/dev/null; then
    local ver
    ver=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$ver" -ge 20 ]; then
      ok "Node.js $(node -v)"
      return 0
    fi
    warn "Node.js $(node -v) found, but >= 20 required"
  else
    warn "Node.js not found"
  fi

  echo ""
  echo -e "  ${YELLOW}Install Node.js >= 20:${NC}"
  case "$PLATFORM" in
    termux)
      echo "    pkg install nodejs"
      ;;
    linux)
      echo "    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
      echo "    sudo apt-get install -y nodejs"
      echo ""
      echo "  Or use nvm / fnm / n to manage Node.js versions."
      ;;
    macos)
      echo "    brew install node"
      echo ""
      echo "  Or: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash"
      echo "      nvm install 22"
      ;;
  esac
  abort "Please install Node.js >= 20 and re-run this script."
}

# ── Step 2: pnpm ────────────────────────────────────────────────────────────────
check_pnpm() {
  if command -v pnpm &>/dev/null; then
    ok "pnpm $(pnpm -v)"
    return 0
  fi

  info "Installing pnpm..."
  if command -v npm &>/dev/null; then
    npm install -g pnpm 2>/dev/null && ok "pnpm installed" && return 0
  fi
  if command -v corepack &>/dev/null; then
    corepack enable && corepack prepare pnpm@latest --activate 2>/dev/null && ok "pnpm installed via corepack" && return 0
  fi

  # Fallback: standalone install
  curl -fsSL https://get.pnpm.io/install.sh | sh - 2>/dev/null || true
  export PNPM_HOME="$HOME/.local/share/pnpm"
  export PATH="$PNPM_HOME:$PATH"
  if command -v pnpm &>/dev/null; then
    ok "pnpm installed via standalone script"
    return 0
  fi

  abort "Failed to install pnpm. Install it manually: https://pnpm.io/installation"
}

# ── Step 3: Git ─────────────────────────────────────────────────────────────────
check_git() {
  if command -v git &>/dev/null; then
    ok "git $(git --version | grep -oP '\d+\.\d+\.\d+' | head -1)"
    return 0
  fi

  echo ""
  echo -e "  ${YELLOW}Install git:${NC}"
  case "$PLATFORM" in
    termux)  echo "    pkg install git" ;;
    linux)   echo "    sudo apt-get install -y git  (or: sudo dnf install -y git)" ;;
    macos)   echo "    brew install git  (or: xcode-select --install)" ;;
  esac
  abort "git not found. Install it and re-run."
}

# ── Step 4: Clone ───────────────────────────────────────────────────────────────
clone_repo() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    ok "Repository already exists: $INSTALL_DIR"
    info "Pulling latest changes..."
    git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || warn "Could not pull (ignored)"
    return 0
  fi

  if [ -d "$INSTALL_DIR" ]; then
    warn "$INSTALL_DIR exists but is not a git repo. Cloning to ${INSTALL_DIR}-new instead."
    INSTALL_DIR="${INSTALL_DIR}-new"
  fi

  info "Cloning OhMyAgent to $INSTALL_DIR..."
  git clone "$REPO_URL" "$INSTALL_DIR" 2>/dev/null || \
    abort "Failed to clone $REPO_URL"
  ok "Repository cloned"
}

# ── Step 5: Install dependencies ────────────────────────────────────────────────
install_deps() {
  info "Installing dependencies..."
  cd "$INSTALL_DIR"

  # better-sqlite3 and sqlite-vec ship prebuilt binaries for all common platforms.
  # A C++ toolchain is only needed if prebuilds fail (rare architectures).
  if pnpm install --prefer-offline 2>&1; then
    ok "Dependencies installed (prebuilt binaries)"
    return 0
  fi

  # Prebuilds failed — need to compile from source
  warn "Prebuilt binaries unavailable for this platform. Need C++ toolchain to compile."

  case "$PLATFORM" in
    termux)
      info "Installing clang + make + python..."
      pkg install clang make python -y 2>/dev/null || true
      ;;
    linux)
      if command -v apt-get &>/dev/null; then
        sudo apt-get install -y build-essential python3 2>/dev/null || true
      elif command -v dnf &>/dev/null; then
        sudo dnf install -y gcc-c++ make python3 2>/dev/null || true
      fi
      ;;
    macos)
      if ! xcode-select -p &>/dev/null; then
        xcode-select --install 2>/dev/null || true
        warn "Xcode Command Line Tools dialog should appear. Re-run after install."
        exit 0
      fi
      ;;
  esac

  info "Retrying with source compilation..."
  if pnpm install --prefer-offline 2>&1; then
    ok "Dependencies installed (compiled from source)"
    return 0
  fi

  abort "Dependency installation failed. Check the output above."
}

# ── Step 6: Install UI dependencies ──────────────────────────────────────────────
install_ui_deps() {
  info "Installing WebUI dependencies..."

  cd "$INSTALL_DIR"

  if [ -f ui/package.json ]; then
    (cd ui && pnpm install --prefer-offline 2>&1) && ok "WebUI dependencies installed" || warn "WebUI dependency installation failed"
    info "Building WebUI frontend..."
    (cd ui && pnpm build 2>&1) && ok "WebUI built to ui/dist/" || warn "WebUI build had issues (server can still serve UI in dev mode)"
  else
    warn "ui/package.json not found, skipping WebUI"
  fi
}

# ── Step 7: Configuration ───────────────────────────────────────────────────────
setup_config() {
  info "Setting up configuration..."

  cd "$INSTALL_DIR"

  # Copy example files if targets don't exist
  if [ ! -f config.yaml ]; then
    cp config.yaml.example config.yaml
    ok "Created config.yaml from example"
  else
    ok "config.yaml already exists"
  fi

  if [ ! -f .env ]; then
    cp .env.example .env
    ok "Created .env from example"
  else
    ok ".env already exists"
  fi

  echo ""
  echo -e "  ${YELLOW}${BOLD}Quick setup — at minimum you need an LLM API key.${NC}"
  echo ""
  echo -e "  Popular options:"
  echo -e "    ${CYAN}1${NC}) DeepSeek  — get key at https://platform.deepseek.com"
  echo -e "    ${CYAN}2${NC}) Anthropic — get key at https://console.anthropic.com"
  echo -e "    ${CYAN}3${NC}) OpenAI    — get key at https://platform.openai.com"
  echo -e "    ${CYAN}4${NC}) Other     — enter provider/model/URL/key manually"
  echo ""

  read -r -p "  Choose [1-4] (default: 1): " choice
  choice="${choice:-1}"

  case "$choice" in
    1)
      PI_AI_PROVIDER="deepseek"
      PI_AI_MODEL="deepseek-chat"
      PI_AI_REASONING_MODEL="deepseek-reasoner"
      DEFAULT_BASE_URL="https://api.deepseek.com/v1"
      ;;
    2)
      PI_AI_PROVIDER="anthropic"
      PI_AI_MODEL="claude-sonnet-4-6"
      PI_AI_REASONING_MODEL="claude-opus-4-8"
      DEFAULT_BASE_URL=""
      ;;
    3)
      PI_AI_PROVIDER="openai"
      PI_AI_MODEL="gpt-4o"
      PI_AI_REASONING_MODEL="gpt-5.4"
      DEFAULT_BASE_URL=""
      ;;
    4)
      read -r -p "  Provider ID: " PI_AI_PROVIDER
      read -r -p "  Model name: " PI_AI_MODEL
      read -r -p "  Reasoning model (or same as above): " PI_AI_REASONING_MODEL
      PI_AI_REASONING_MODEL="${PI_AI_REASONING_MODEL:-$PI_AI_MODEL}"
      read -r -p "  Base URL (or leave empty): " DEFAULT_BASE_URL
      ;;
    *)
      abort "Invalid choice"
      ;;
  esac

  read -r -s -p "  API Key: " PI_AI_API_KEY
  echo ""

  if [ -z "$PI_AI_API_KEY" ]; then
    abort "API key is required."
  fi

  # Generate a random WEBUI_TOKEN or let user set one
  WEBUI_TOKEN=""
  read -r -s -p "  WebUI password (leave empty to auto-generate): " WEBUI_TOKEN
  echo ""
  if [ -z "$WEBUI_TOKEN" ]; then
    WEBUI_TOKEN=$(openssl rand -hex 16 2>/dev/null || python3 -c "import secrets; print(secrets.token_hex(16))" 2>/dev/null || cat /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 32)
    TOKEN_WAS_GENERATED=true
  fi

  # Write .env
  {
    echo ""
    echo "# ── OhMyAgent configuration ──"
    echo "PI_AI_PROVIDER=${PI_AI_PROVIDER}"
    echo "PI_AI_MODEL=${PI_AI_MODEL}"
    echo "PI_AI_REASONING_MODEL=${PI_AI_REASONING_MODEL}"
    echo "PI_AI_API_KEY=${PI_AI_API_KEY}"
    [ -n "$DEFAULT_BASE_URL" ] && echo "PI_AI_BASE_URL=${DEFAULT_BASE_URL}"
    echo "WEBUI_TOKEN=${WEBUI_TOKEN}"
    echo "LOG_LEVEL=info"
  } > .env

  ok "Configuration saved"
}

# ── Step 8: Build ───────────────────────────────────────────────────────────────
build_project() {
  info "Building TypeScript..."
  cd "$INSTALL_DIR"
  pnpm build 2>&1 | tail -3
  ok "Build complete"
}

# ── Step 9: Service ─────────────────────────────────────────────────────────────
install_service() {
  echo ""
  read -r -p "  Install as system service (auto-start on boot)? [y/N] " svc
  if [ "${svc:-n}" = "y" ] || [ "${svc:-n}" = "Y" ]; then
    cd "$INSTALL_DIR"
    if node dist/src/cli/index.js service install 2>/dev/null; then
      ok "Service installed — OhMyAgent will start automatically on boot"
    else
      warn "Service installation failed. You can try manually later: ohmyagent service install"
    fi
  fi
}

# ── Step 10: Ready ───────────────────────────────────────────────────────────────
finish() {
  echo ""
  echo -e "${GREEN}${BOLD}╔══════════════════════════════════════╗${NC}"
  echo -e "${GREEN}${BOLD}║      Installation complete!          ║${NC}"
  echo -e "${GREEN}${BOLD}╚══════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  ${BOLD}WebUI:${NC}  http://localhost:9191/webui"
  echo -e "  ${BOLD}Token:${NC}  ${WEBUI_TOKEN}"
  if [ "${TOKEN_WAS_GENERATED:-false}" = true ]; then
    echo -e "           ${YELLOW}(auto-generated — saved in .env, change with WEBUI_TOKEN)${NC}"
  fi
  echo ""
  echo -e "  ${BOLD}Start the server:${NC}"
  echo -e "    cd ${INSTALL_DIR} && pnpm dev"
  echo ""
  echo -e "  ${BOLD}Or use the CLI:${NC}"
  echo -e "    ohmyagent start     # Start in background"
  echo -e "    ohmyagent status    # Check if running"
  echo -e "    ohmyagent doctor    # System diagnostics"
  echo ""
  echo -e "  ${BOLD}Desktop app:${NC} https://github.com/tscodeplus/OhMyAgent/releases"
  echo ""

  read -r -p "  Start now? [Y/n] " start
  if [ "${start:-y}" = "y" ] || [ "${start:-y}" = "Y" ]; then
    cd "$INSTALL_DIR"
    pnpm dev
  fi
}

# ── Main ────────────────────────────────────────────────────────────────────────
check_node
check_pnpm
check_git
clone_repo
install_deps
install_ui_deps
setup_config
build_project
install_service
finish
