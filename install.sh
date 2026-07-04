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
echo -e "${CYAN}${BOLD}║       OhMyAgent Installer            ║${NC}"
echo -e "${CYAN}${BOLD}║   Remembers. Understands. Respects.  ║${NC}"
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
install_nodejs() {
  info "Installing Node.js >= 20..."
  case "$PLATFORM" in
    termux)
      pkg install nodejs -y 2>/dev/null && return 0
      ;;
    linux)
      # Try n (simple Node version manager) — no sudo, no shell integration needed
      if command -v n &>/dev/null; then
        sudo -n n lts 2>/dev/null && return 0
      fi
      # Try to install n if curl is available
      if command -v curl &>/dev/null; then
        curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n | sudo -E bash - lts 2>/dev/null && return 0
      fi
      # Fallback: nodesource
      if command -v curl &>/dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - 2>/dev/null && \
          sudo apt-get install -y nodejs 2>/dev/null && return 0
      fi
      ;;
    macos)
      # Try brew first
      if command -v brew &>/dev/null; then
        brew install node 2>/dev/null && return 0
      fi
      # Try n (simple, no shell integration needed)
      if command -v n &>/dev/null; then
        sudo -n n lts 2>/dev/null && return 0
      fi
      # Install n and use it
      if command -v curl &>/dev/null; then
        curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n | sudo -E bash - lts 2>/dev/null && return 0
      fi
      # Fallback: download Node.js pkg
      if command -v curl &>/dev/null; then
        local arch
        arch=$(uname -m)
        [ "$arch" = "arm64" ] && arch="arm64" || arch="x64"
        local pkg="node-v22.17.0-darwin-${arch}.tar.gz"
        curl -fsSL "https://nodejs.org/dist/v22.17.0/${pkg}" -o "/tmp/${pkg}" 2>/dev/null && \
          sudo tar -xzf "/tmp/${pkg}" -C /usr/local --strip-components=1 2>/dev/null && \
          rm -f "/tmp/${pkg}" && return 0
      fi
      ;;
  esac
  return 1
}

check_node() {
  if command -v node &>/dev/null; then
    local ver
    ver=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$ver" -ge 20 ]; then
      ok "Node.js $(node -v)"
      return 0
    fi
    # Exists but too old — do NOT auto-upgrade (user may have intentional version)
    warn "Node.js $(node -v) found, but >= 20 required"
    echo ""
    echo -e "  ${YELLOW}Your Node.js is too old. Please upgrade manually:${NC}"
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
        echo "    brew upgrade node"
        echo ""
        echo "  Or: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash"
        echo "      nvm install 22"
        ;;
    esac
    abort "Please upgrade Node.js to >= 20 and re-run this script."
  fi

  # Not installed at all — auto-install the recommended version
  warn "Node.js not found"
  info "Installing Node.js LTS automatically..."

  if install_nodejs; then
    ok "Node.js $(node -v) installed successfully"
    return 0
  fi

  # Manual instructions as fallback
  echo ""
  echo -e "  ${YELLOW}Automatic install failed. Please install manually:${NC}"
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
    local ver
    ver=$(pnpm -v | cut -d. -f1)
    if [ "$ver" -ge 9 ]; then
      ok "pnpm $(pnpm -v)"
      return 0
    fi
    # Exists but too old — do NOT auto-upgrade
    warn "pnpm $(pnpm -v) found, but >= 9 required"
    echo ""
    echo -e "  ${YELLOW}Your pnpm is too old. Please upgrade manually:${NC}"
    echo "    npm install -g pnpm@latest"
    echo "    corepack prepare pnpm@latest --activate"
    echo ""
    abort "Please upgrade pnpm to >= 9 and re-run this script."
  fi

  # Not installed at all — auto-install
  warn "pnpm not found"
  info "Installing pnpm..."

  # Use corepack (ships with Node.js >= 16)
  if command -v corepack &>/dev/null; then
    corepack enable 2>/dev/null && \
      corepack prepare pnpm@latest --activate 2>/dev/null && \
      ok "pnpm $(pnpm -v) installed via corepack" && return 0
  fi

  # Use npm to install
  if command -v npm &>/dev/null; then
    npm install -g pnpm@latest 2>/dev/null && ok "pnpm $(pnpm -v) installed" && return 0
  fi

  # Fallback: standalone install
  curl -fsSL https://get.pnpm.io/install.sh | sh - 2>/dev/null || true
  export PNPM_HOME="$HOME/.local/share/pnpm"
  export PATH="$PNPM_HOME:$PATH"
  if command -v pnpm &>/dev/null; then
    ok "pnpm $(pnpm -v) installed via standalone script"
    return 0
  fi

  abort "Failed to install pnpm. Install it manually: https://pnpm.io/installation"
}

# ── Step 3: Git ─────────────────────────────────────────────────────────────────
check_git() {
  if command -v git &>/dev/null; then
    ok "git $(git --version | awk '{print $3}')"
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
    PULL_OUTPUT=$(git -C "$INSTALL_DIR" pull --ff-only 2>&1) || {
      warn "Could not pull: ${PULL_OUTPUT}"
      # If the failure is due to untracked files that would be overwritten,
      # stash them and retry so the user gets the latest installer fixes.
      if echo "$PULL_OUTPUT" | grep -qi 'would be overwritten\|untracked working tree'; then
        warn "Local files conflict with incoming changes. Stashing and retrying..."
        git -C "$INSTALL_DIR" stash --include-untracked 2>/dev/null || true
        PULL_OUTPUT2=$(git -C "$INSTALL_DIR" pull --ff-only 2>&1) && \
          ok "Pulled latest changes (local changes stashed)" || \
          warn "Pull still failed: ${PULL_OUTPUT2}"
      fi
    }
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

# ── CA Certificates ─────────────────────────────────────────────────────────
# Some Node.js installations (especially Homebrew on macOS) ship with an
# incomplete CA bundle that doesn't include Google Trust Services — which
# npmjs.org uses. The macOS system keychain has a more complete set.
# Setting NODE_EXTRA_CA_CERTS to the system CA file fixes this.
_ensure_node_ca_certs() {
  # Already set by user — trust it
  if [ -n "${NODE_EXTRA_CA_CERTS:-}" ]; then
    return 0
  fi

  local sys_ca=""
  if [ "$PLATFORM" = "macos" ] && [ -f /etc/ssl/cert.pem ]; then
    sys_ca="/etc/ssl/cert.pem"
  elif [ -f /etc/ssl/certs/ca-certificates.crt ]; then
    sys_ca="/etc/ssl/certs/ca-certificates.crt"   # Linux (Debian/Ubuntu)
  elif [ -f /etc/pki/tls/certs/ca-bundle.crt ]; then
    sys_ca="/etc/pki/tls/certs/ca-bundle.crt"       # Linux (RHEL/Fedora)
  fi

  if [ -n "$sys_ca" ]; then
    # Quick smoke test: does Node.js trust npmjs.org with our CA?
    if NODE_EXTRA_CA_CERTS="$sys_ca" node -e "
var https = require('https');
https.get('https://registry.npmjs.org/', function(res) { process.exit(res.statusCode === 200 ? 0 : 1); })
  .on('error', function() { process.exit(1); });
" 2>/dev/null; then
      export NODE_EXTRA_CA_CERTS="$sys_ca"
      info "Using system CA certificates (${sys_ca})"
      return 0
    fi
  fi
  return 1
}

# ── Proxy detection ──────────────────────────────────────────────────────────
# Detects local HTTP proxy servers (INCY/Clash/V2Ray/etc.) and sets
# https_proxy / http_proxy env vars so that Node.js/pnpm can route through
# the proxy directly. This is more reliable than relying on TUN-mode virtual
# network interfaces, which can have DNS and connection-tracking issues on macOS.

# Test whether a given host:port is a working HTTP forward proxy.
# Returns 0 if the proxy successfully tunnels to registry.npmjs.org.
_probe_http_proxy() {
  local host="$1" port="$2"
  node -e "
var http = require('http');
var opts = {
  hostname: '$host', port: $port,
  method: 'CONNECT', path: 'registry.npmjs.org:443',
  timeout: 5000
};
var req = http.request(opts);
req.on('connect', function(res, socket) {
  // Got a 2xx response — proxy is working
  socket.end();
  process.exit(0);
});
req.on('error', function() { process.exit(1); });
req.on('timeout', function() { req.destroy(); process.exit(1); });
req.end();
" 2>/dev/null
}

# Fetch macOS system proxy settings (set by GUI or proxy apps like INCY/Clash).
# Uses scutil --proxy which reads from the System Configuration dynamic store,
# so it works regardless of which network service (Wi-Fi/Ethernet/etc.) is active.
_get_macos_system_proxy() {
  [ "$PLATFORM" = "macos" ] || return 1

  local out https_enabled http_enabled host port
  out=$(scutil --proxy 2>/dev/null) || return 1

  # Prefer HTTPS proxy, fall back to HTTP proxy
  https_enabled=$(echo "$out" | grep "HTTPSEnable" | awk '{print $3}')
  http_enabled=$(echo "$out"  | grep "HTTPEnable"  | awk '{print $3}')

  if [ "$https_enabled" = "1" ]; then
    host=$(echo "$out" | grep "HTTPSProxy" | awk '{print $3}')
    port=$(echo "$out" | grep "HTTPSPort"  | awk '{print $3}')
  elif [ "$http_enabled" = "1" ]; then
    host=$(echo "$out" | grep "HTTPProxy"  | awk '{print $3}')
    port=$(echo "$out" | grep "HTTPPort"   | awk '{print $3}')
  else
    return 1
  fi

  [ -n "$host" ] && [ -n "$port" ] && echo "${host}:${port}" && return 0
  return 1
}

_detect_and_set_proxy() {
  # Respect user's explicit proxy settings
  if [ -n "${https_proxy:-}" ] || [ -n "${HTTPS_PROXY:-}" ] || \
     [ -n "${http_proxy:-}" ]  || [ -n "${HTTP_PROXY:-}" ]; then
    export https_proxy="${https_proxy:-${HTTPS_PROXY:-}}"
    export http_proxy="${http_proxy:-${HTTP_PROXY:-${https_proxy}}}"
    return 0
  fi

  # --- Strategy 1: macOS system proxy (set by INCY/Clash GUI) ---
  local sys_proxy
  sys_proxy=$(_get_macos_system_proxy) || true
  if [ -n "${sys_proxy:-}" ]; then
    local sys_host="${sys_proxy%%:*}" sys_port="${sys_proxy##*:}"
    if _probe_http_proxy "$sys_host" "$sys_port"; then
      export https_proxy="http://${sys_proxy}"
      export http_proxy="http://${sys_proxy}"
      info "Using macOS system proxy at ${sys_proxy}"
      return 0
    fi
    warn "System proxy ${sys_proxy} is configured but does not respond as an HTTP forward proxy"
    warn "It may be a SOCKS proxy or TUN-only — falling back to port scan"
  fi

  # --- Strategy 2: scan common local HTTP proxy ports ---
  #   7890  — Clash / Stash (HTTP)
  #   10809 — INCY / Xray (HTTP inbound, Clash uses 7890 but INCY uses 10809)
  #   10808 — V2Ray / Xray (SOCKS inbound — often paired with 10809 HTTP)
  #   6152  — Surge (HTTP)
  #   8118  — Privoxy
  #   8080  — Generic / CNTLM
  local proxy_ports="7890 10809 10808 6152 8118 8080"

  for port in $proxy_ports; do
    if _probe_http_proxy "127.0.0.1" "$port"; then
      export https_proxy="http://127.0.0.1:$port"
      export http_proxy="http://127.0.0.1:$port"
      info "Detected HTTP proxy at 127.0.0.1:$port — routing pnpm through it"
      return 0
    fi
  done

  # --- No explicit proxy found ---
  # If we're on macOS, the user may be using TUN-only mode (no HTTP proxy port).
  # TUN virtual interfaces can cause two problems for Node.js:
  #   1. DNS resolution issues (IPv6 vs IPv4)
  #   2. SSL certificate errors (TUN proxies often inspect/re-encrypt TLS)
  # Pre-configure both workarounds so pnpm can connect.
  if [ "$PLATFORM" = "macos" ]; then
    # Check if any utun (TUN) interfaces are up — strong signal of TUN-mode proxy
    if ifconfig 2>/dev/null | grep -q '^utun.*RUNNING'; then
      warn "TUN interface detected but no HTTP proxy found"
      warn "For best results, enable the HTTP proxy in your proxy app (usually port 7890 or 10809)"
      # Help Node.js cope with TUN DNS + SSL-inspection quirks
      export NODE_OPTIONS="${NODE_OPTIONS:-} --dns-result-order=ipv4first"
      export NODE_TLS_REJECT_UNAUTHORIZED="${NODE_TLS_REJECT_UNAUTHORIZED:-0}"
      info "Set NODE_OPTIONS=--dns-result-order=ipv4first + NODE_TLS_REJECT_UNAUTHORIZED=0 (TUN compatibility)"
      return 2
    fi
  fi

  return 1
}

# ── Step 5: Install dependencies ────────────────────────────────────────────────
install_deps() {
  info "Installing dependencies..."
  cd "$INSTALL_DIR"

  # ── Ensure build scripts are approved ─────────────────────────────────────
  # pnpm v11 replaced onlyBuiltDependencies (array) with allowBuilds (map).
  # The repo ships pnpm-workspace.yaml with both keys for cross-version compat,
  # but if the clone/pull is stale the file may lack allowBuilds.
  # This block ensures builds are approved regardless of pnpm version.
  _ensure_builds_approved() {
    local pnpm_ver
    pnpm_ver=$(pnpm -v 2>/dev/null | cut -d. -f1)

    if [ "${pnpm_ver:-0}" -ge 11 ]; then
      # pnpm 11+: onlyBuiltDependencies is removed; allowBuilds (a map) replaces it.
      #
      # Remove pnpm.onlyBuiltDependencies from package.json to suppress the
      # "no longer read" warning and avoid confusion.
      if [ -f package.json ] && grep -q 'onlyBuiltDependencies' package.json 2>/dev/null; then
        node -e "
const { readFileSync, writeFileSync } = require('fs');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (pkg.pnpm) {
  delete pkg.pnpm.onlyBuiltDependencies;
  if (!Object.keys(pkg.pnpm).length) delete pkg.pnpm;
}
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
" 2>/dev/null || true
      fi

      # Write allowBuilds into pnpm-workspace.yaml if missing.
      if ! grep -q '^allowBuilds:' pnpm-workspace.yaml 2>/dev/null; then
        cat >> pnpm-workspace.yaml <<'ALLOWBUILDS'

allowBuilds:
  better-sqlite3: true
  sqlite-vec: true
  sqlite-vec-windows-x64: true
  sqlite-vec-linux-x64: true
  sqlite-vec-darwin-x64: true
  sqlite-vec-darwin-arm64: true
  sqlite-vec-linux-arm64: true
  sharp: true
  esbuild: true
  protobufjs: true
  "@google/genai": true
  "@nut-tree-fork/nut-js": true
  electron: true
ALLOWBUILDS
      fi

      # Belt and suspenders: also write allowBuilds into .npmrc.
      # pnpm 11 says .npmrc is auth-only, but in practice some 11.x releases
      # still read allowBuilds from .npmrc as a fallback.
      if ! grep -q '^allowBuilds' .npmrc 2>/dev/null; then
        cat >> .npmrc <<'ALLOWBUILDS_NPMRC'

# allowBuilds (pnpm 11+) — also configured in pnpm-workspace.yaml
allowBuilds[better-sqlite3]=true
allowBuilds[sqlite-vec]=true
allowBuilds[sqlite-vec-windows-x64]=true
allowBuilds[sqlite-vec-linux-x64]=true
allowBuilds[sqlite-vec-darwin-x64]=true
allowBuilds[sqlite-vec-darwin-arm64]=true
allowBuilds[sqlite-vec-linux-arm64]=true
allowBuilds[sharp]=true
allowBuilds[esbuild]=true
allowBuilds[protobufjs]=true
allowBuilds[@google/genai]=true
allowBuilds[@nut-tree-fork/nut-js]=true
allowBuilds[electron]=true
ALLOWBUILDS_NPMRC
      fi
    elif command -v pnpm &>/dev/null && pnpm approve-builds --help 2>/dev/null | grep -q 'global' 2>/dev/null; then
      # pnpm v10.4+
      pnpm approve-builds --global 2>/dev/null || true
    fi
  }
  _ensure_builds_approved

  # ── Locate a Python >= 3.8 for potential native compilation ──────────────
  # check_python() already ran above and may have set PYTHON_BIN. If the system
  # python3 is too old (e.g. macOS Xcode CLT 3.7), try brew / python.org paths.
  _find_python() {
    local candidates=()
    if [ "$PLATFORM" = "macos" ]; then
      [ -x "/opt/homebrew/bin/python3" ] && candidates+=("/opt/homebrew/bin/python3")
      [ -x "/usr/local/bin/python3" ] && candidates+=("/usr/local/bin/python3")
      [ -x "/Library/Frameworks/Python.framework/Versions/3/bin/python3" ] && candidates+=("/Library/Frameworks/Python.framework/Versions/3/bin/python3")
    fi
    candidates+=("python3")
    for py in "${candidates[@]}"; do
      if command -v "$py" &>/dev/null; then
        local ver
        ver=$("$py" -c 'import sys; print(sys.version_info[:2] >= (3, 8))' 2>/dev/null) || continue
        [ "$ver" = "True" ] && { echo "$py"; return 0; }
      fi
    done
    return 1
  }
  # Run _find_python to locate a suitable Python (>= 3.8) for node-gyp 12+.
  # On macOS this prefers brew/python.org Python over Xcode CLT's Python 3.7.
  PYTHON_BIN=$(_find_python) || true
  if [ -n "${PYTHON_BIN:-}" ] && [ "$PYTHON_BIN" != "python3" ]; then
    export npm_config_python="$PYTHON_BIN"
    info "Using Python: ${PYTHON_BIN} (for native compilation)"
  fi

  # Ensure Node.js can verify TLS certificates (esp. npmjs.org which uses
  # Google Trust Services — not always in Node's bundled CA store).
  _ensure_node_ca_certs || true

  # Detect local proxy (INCY/Clash/V2Ray) — explicit proxy is more reliable
  # than TUN-mode virtual interfaces for Node.js processes.
  _detect_and_set_proxy || true
  local root_had_proxy=0
  [ -n "${https_proxy:-}" ] && root_had_proxy=1

  if pnpm install --prefer-offline 2>&1 | tee /tmp/ohmyagent-pnpm-install.log; then
    ok "Dependencies installed (prebuilt binaries)"
    rm -f /tmp/ohmyagent-pnpm-install.log
    return 0
  fi

  # If a proxy was set but install failed, the "proxy" may be a SOCKS port or
  # non-HTTP service. Unset proxy and retry (rely on TUN directly).
  if [ "$root_had_proxy" -eq 1 ]; then
    warn "Install with proxy failed — retrying without proxy (TUN direct)..."
    rm -f /tmp/ohmyagent-pnpm-install.log
    unset https_proxy http_proxy HTTPS_PROXY HTTP_PROXY
    if [ "$PLATFORM" = "macos" ]; then
      export NODE_OPTIONS="${NODE_OPTIONS:-} --dns-result-order=ipv4first"
      export NODE_TLS_REJECT_UNAUTHORIZED="${NODE_TLS_REJECT_UNAUTHORIZED:-0}"
    fi
    if pnpm install --prefer-offline 2>&1 | tee /tmp/ohmyagent-pnpm-install.log; then
      ok "Dependencies installed (TUN direct)"
      rm -f /tmp/ohmyagent-pnpm-install.log
      return 0
    fi
  fi

  # Check for network errors that are likely caused by proxy SSL/TLS inspection.
  # TUN-mode proxies (INCY/Clash/Surge) intercept HTTPS and re-encrypt with a
  # self-signed certificate — Node.js (correctly) rejects this, but the error
  # format varies by HTTP client:
  #   Node.js built-in https: "unable to get local issuer certificate"
  #   undici (pnpm ≥9):     "fetch failed" / "error (0)" / ERR_PNPM_*_FETCH_FAIL
  if grep -qi 'unable to get local issuer certificate\|UNABLE_TO_GET_ISSUER_CERT_LOCALLY\|CERT_HAS_EXPIRED\|self.signed\|certificate\|ERR_PNPM_.*FETCH\|fetch failed\|error.*(0)' /tmp/ohmyagent-pnpm-install.log 2>/dev/null; then
    warn "Network error detected (likely proxy SSL inspection)."
    warn "Retrying with NODE_TLS_REJECT_UNAUTHORIZED=0..."
    if NODE_TLS_REJECT_UNAUTHORIZED=0 pnpm install --prefer-offline 2>&1; then
      ok "Dependencies installed (SSL workaround)"
      rm -f /tmp/ohmyagent-pnpm-install.log
      return 0
    fi
    # TLS bypass didn't help — network might be blocking npmjs.org entirely
    warn "Still failing — trying npmmirror.com registry mirror..."
    if pnpm install --prefer-offline --fetch-retries=0 --registry=https://registry.npmmirror.com 2>&1; then
      ok "Dependencies installed (npmmirror mirror)"
      rm -f /tmp/ohmyagent-pnpm-install.log
      return 0
    fi
  fi

  # If lockfile is incompatible (old pnpm vs new lockfile), regenerate and retry
  if grep -qi 'not compatible with current pnpm\|Ignoring broken lockfile' /tmp/ohmyagent-pnpm-install.log 2>/dev/null; then
    warn "Lockfile incompatible with current pnpm. Regenerating..."
    rm -f pnpm-lock.yaml
    if pnpm install --prefer-offline 2>&1; then
      ok "Dependencies installed (lockfile regenerated)"
      rm -f /tmp/ohmyagent-pnpm-install.log
      return 0
    fi
  fi

  # If pnpm blocked builds (ERR_PNPM_IGNORED_BUILDS), ensure they're approved
  # and retry before falling through to the C++ toolchain path.
  if grep -qi 'ERR_PNPM_IGNORED_BUILDS\|Ignored build scripts' /tmp/ohmyagent-pnpm-install.log 2>/dev/null; then
    warn "Build scripts were blocked. Approving builds and retrying..."
    # Force-remove stale onlyBuiltDependencies from .npmrc (pnpm 11 ignores them,
    # but their presence may confuse users). Then re-apply allowBuilds.
    if [ -f .npmrc ]; then
      sed -i.bak '/^onlyBuiltDependencies/d' .npmrc 2>/dev/null || true
      rm -f .npmrc.bak
    fi
    _ensure_builds_approved
    if pnpm install --prefer-offline 2>&1 | tee /tmp/ohmyagent-pnpm-retry2.log; then
      ok "Dependencies installed (builds approved)"
      rm -f /tmp/ohmyagent-pnpm-install.log /tmp/ohmyagent-pnpm-retry2.log
      return 0
    fi
    # Native builds may hit SSL cert errors even after approval
    if grep -qi 'unable to get local issuer certificate\|CERT_HAS_EXPIRED\|self.signed\|ERR_PNPM_.*FETCH\|fetch failed\|error.*(0)' /tmp/ohmyagent-pnpm-retry2.log 2>/dev/null; then
      warn "Network error (likely proxy SSL). Retrying with NODE_TLS_REJECT_UNAUTHORIZED=0..."
      if NODE_TLS_REJECT_UNAUTHORIZED=0 pnpm install --prefer-offline 2>&1; then
        ok "Dependencies installed (SSL workaround)"
        rm -f /tmp/ohmyagent-pnpm-install.log /tmp/ohmyagent-pnpm-retry2.log
        return 0
      fi
    fi
    rm -f /tmp/ohmyagent-pnpm-retry2.log
  fi

  rm -f /tmp/ohmyagent-pnpm-install.log

  # Prebuilds failed — need to compile from source.
  # At this point PYTHON_BIN / npm_config_python was already resolved above
  # (before the first install attempt). If not, try again now.
  if [ -z "${PYTHON_BIN:-}" ]; then
    PYTHON_BIN=$(_find_python) || true
    [ -n "${PYTHON_BIN:-}" ] && export npm_config_python="$PYTHON_BIN"
  fi

  if [ -z "${PYTHON_BIN:-}" ]; then
    echo ""
    err "Python 3.8+ is required for native module compilation."
    err "Your system Python is too old."
    echo ""
    case "$PLATFORM" in
      macos)
        echo -e "  ${CYAN}Fix:${NC} brew install python"
        echo ""
        echo -e "  Then re-run this script."
        ;;
      linux)
        echo -e "  ${CYAN}Fix:${NC} sudo apt-get install python3  (or: sudo dnf install python3)"
        ;;
      termux)
        echo -e "  ${CYAN}Fix:${NC} pkg install python"
        ;;
    esac
    echo ""
    exit 1
  fi

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

  # Re-approve builds before retry — toolchain install may have reset state
  _ensure_builds_approved

  info "Retrying with source compilation..."
  if pnpm install --prefer-offline 2>&1 | tee /tmp/ohmyagent-pnpm-retry.log; then
    ok "Dependencies installed (compiled from source)"
    rm -f /tmp/ohmyagent-pnpm-retry.log
    return 0
  fi

  # Source compilation may also fail due to SSL cert issues (node-gyp downloads
  # Node headers from nodejs.org during native module compilation).
  # Only trigger SSL retry if the log contains TLS errors AND does NOT contain
  # Python SyntaxError (which means Python is too old — TLS isn't the problem).
  if grep -qi 'unable to get local issuer certificate\|UNABLE_TO_GET_ISSUER_CERT_LOCALLY\|CERT_HAS_EXPIRED\|self.signed\|ERR_PNPM_.*FETCH\|fetch failed\|error.*(0)' /tmp/ohmyagent-pnpm-retry.log 2>/dev/null && \
     ! grep -qi 'SyntaxError\|\.py.*line.*syntax\|gyp ERR.*configure' /tmp/ohmyagent-pnpm-retry.log 2>/dev/null; then
    warn "Network error (likely proxy SSL) during source compilation."
    warn "Retrying with NODE_TLS_REJECT_UNAUTHORIZED=0..."
    if NODE_TLS_REJECT_UNAUTHORIZED=0 pnpm install --prefer-offline 2>&1; then
      ok "Dependencies installed (SSL workaround)"
      rm -f /tmp/ohmyagent-pnpm-retry.log
      return 0
    fi
  fi

  # If node-gyp failed due to an old Python (SyntaxError on walrus operator),
  # surface an actionable message instead of a generic "failed" error.
  if grep -qi 'SyntaxError' /tmp/ohmyagent-pnpm-retry.log 2>/dev/null && \
     grep -qi 'gyp ERR!' /tmp/ohmyagent-pnpm-retry.log 2>/dev/null; then
    echo ""
    err "node-gyp failed: incompatible Python version detected."
    err "node-gyp 12+ requires Python >= 3.8 — your system Python is too old."
    echo ""
    case "$PLATFORM" in
      macos)
        echo -e "  ${CYAN}Fix:${NC} brew install python"
        echo -e "       (brew's python3 is 3.13+ and won't break system tools)"
        ;;
      linux)
        echo -e "  ${CYAN}Fix:${NC} Install Python >= 3.8 via your package manager"
        ;;
      termux)
        echo -e "  ${CYAN}Fix:${NC} pkg install python"
        ;;
    esac
    echo ""
  fi

  rm -f /tmp/ohmyagent-pnpm-retry.log

  abort "Dependency installation failed. Check the output above."
}

# ── Verify sqlite-vec native extension (optional dep may be skipped) ────────────
verify_sqlite_vec() {
  info "Verifying sqlite-vec native extension..."
  cd "$INSTALL_DIR"

  if node -e "require('sqlite-vec')" 2>/dev/null; then
    ok "sqlite-vec available"
  else
    warn "sqlite-vec native extension unavailable; memory vector search will use cosine fallback"
    echo -e "  ${YELLOW}This is expected if sqlite-vec has no prebuilt binary for your platform.${NC}"
    echo -e "  ${YELLOW}Everything works — just slower for large memory banks.${NC}"
  fi
}

# ── Step 6: Install UI dependencies ──────────────────────────────────────────────
install_ui_deps() {
  info "Installing WebUI dependencies..."

  cd "$INSTALL_DIR"

  if [ ! -f ui/package.json ]; then
    warn "ui/package.json not found, skipping WebUI"
    return 0
  fi

  # ── Ensure esbuild build scripts are approved for the ui/ subdirectory ──
  # pnpm 11+ blocks post-install build scripts by default (ERR_PNPM_IGNORED_BUILDS).
  # Without this, pnpm exits non-zero even though all packages are installed,
  # which triggers unnecessary network fallback retries.
  _ensure_ui_builds_approved() {
    local pnpm_ver
    pnpm_ver=$(pnpm -v 2>/dev/null | cut -d. -f1)

    if [ "${pnpm_ver:-0}" -ge 11 ]; then
      if ! grep -q 'allowBuilds\[esbuild\]' ui/.npmrc 2>/dev/null; then
        mkdir -p ui
        echo 'allowBuilds[esbuild]=true' >> ui/.npmrc
        info "Approved build scripts for ui/ (esbuild)"
      fi
    elif command -v pnpm &>/dev/null && pnpm approve-builds --help 2>/dev/null | grep -q 'global' 2>/dev/null; then
      (cd ui && pnpm approve-builds esbuild 2>/dev/null) || true
    fi
  }
  _ensure_ui_builds_approved

  # Ensure Node.js can verify TLS certificates (esp. npmjs.org which uses
  # Google Trust Services — not always in Node's bundled CA store).
  _ensure_node_ca_certs || true

  # Detect local proxy (INCY/Clash/V2Ray) — explicit proxy is more reliable
  # than TUN-mode virtual interfaces for Node.js processes.
  local proxy_result
  _detect_and_set_proxy && proxy_result=0 || proxy_result=$?
  local had_proxy=0
  [ -n "${https_proxy:-}" ] && had_proxy=1

  # Run pnpm install in the ui/ subdirectory with network fallbacks.
  # ui/ is NOT part of the root workspace — it has its own lockfile and deps.
  # --ignore-workspace is required because pnpm detects the parent directory's
  # pnpm-workspace.yaml and silently skips install (exit 0, no node_modules).
  if (cd ui && pnpm install --prefer-offline --ignore-workspace 2>&1 | tee /tmp/ohmyagent-ui-install.log); then
    ok "WebUI dependencies installed"
    rm -f /tmp/ohmyagent-ui-install.log
  else
    # ── ERR_PNPM_IGNORED_BUILDS is NOT a network error ──────────────────
    # pnpm 11+ exits non-zero when build scripts are blocked, even though
    # all packages installed successfully. Don't cycle network fallbacks.
    if grep -qi 'ERR_PNPM_IGNORED_BUILDS\|Ignored build scripts' /tmp/ohmyagent-ui-install.log 2>/dev/null; then
      warn "Build scripts were blocked — approving and retrying..."
      rm -f /tmp/ohmyagent-ui-install.log
      # Force-approve esbuild (may have been missed by pre-check)
      mkdir -p ui
      if ! grep -q 'allowBuilds\[esbuild\]' ui/.npmrc 2>/dev/null; then
        echo 'allowBuilds[esbuild]=true' >> ui/.npmrc
      fi
      if (cd ui && pnpm install --prefer-offline --ignore-workspace 2>&1 | tee /tmp/ohmyagent-ui-install.log); then
        ok "WebUI dependencies installed (builds approved)"
        rm -f /tmp/ohmyagent-ui-install.log
        return 0
      fi
      # Still blocked — packages are installed, just build scripts skipped
      if grep -qi 'ERR_PNPM_IGNORED_BUILDS\|Ignored build scripts' /tmp/ohmyagent-ui-install.log 2>/dev/null; then
        warn "Build scripts still blocked — packages are installed, continuing"
        rm -f /tmp/ohmyagent-ui-install.log
        return 0
      fi
    fi

    # If we had a proxy set but it failed, the "proxy" may be a SOCKS port
    # or a non-HTTP service. Unset proxy and retry (rely on TUN directly).
    if [ "$had_proxy" -eq 1 ]; then
      warn "Install with proxy failed — retrying without proxy (TUN direct)..."
      rm -f /tmp/ohmyagent-ui-install.log
      unset https_proxy http_proxy HTTPS_PROXY HTTP_PROXY
      if [ "$PLATFORM" = "macos" ]; then
        export NODE_OPTIONS="${NODE_OPTIONS:-} --dns-result-order=ipv4first"
        export NODE_TLS_REJECT_UNAUTHORIZED="${NODE_TLS_REJECT_UNAUTHORIZED:-0}"
      fi
      if (cd ui && pnpm install --prefer-offline --ignore-workspace 2>&1 | tee /tmp/ohmyagent-ui-install.log); then
        ok "WebUI dependencies installed (TUN direct)"
        rm -f /tmp/ohmyagent-ui-install.log
        return 0
      fi
    fi

    warn "WebUI install failed — retrying with NODE_TLS_REJECT_UNAUTHORIZED=0..."
    rm -f /tmp/ohmyagent-ui-install.log
    if (cd ui && NODE_TLS_REJECT_UNAUTHORIZED=0 pnpm install --prefer-offline --ignore-workspace 2>&1); then
      ok "WebUI dependencies installed (SSL workaround)"
    else
      # TLS bypass didn't help — likely network unreachable to npmjs.org.
      # Try npmmirror (Chinese npm mirror) as a final fallback.
      warn "Still failed — trying npmmirror.com registry mirror..."
      if (cd ui && pnpm install --prefer-offline --ignore-workspace --registry=https://registry.npmmirror.com 2>&1); then
        ok "WebUI dependencies installed (npmmirror mirror)"
      else
        warn "WebUI dependency installation failed"
        echo ""
        echo -e "  ${YELLOW}All network strategies exhausted:${NC}"
        echo -e "  ${YELLOW}  1. Direct connection${had_proxy:+ (with proxy)}${NC}"
        echo -e "  ${YELLOW}  2. NODE_TLS_REJECT_UNAUTHORIZED=0${NC}"
        echo -e "  ${YELLOW}  3. npmmirror.com registry mirror${NC}"
        if [ "$had_proxy" -eq 1 ]; then
          echo -e "  ${YELLOW}  4. TUN direct (without proxy)${NC}"
        fi
        if [ "$proxy_result" -eq 2 ]; then
          echo ""
          echo -e "  ${CYAN}${BOLD}Troubleshooting TUN mode:${NC}"
          echo -e "  ${CYAN}• Enable HTTP proxy in your proxy app (usually port 7890)${NC}"
          echo -e "  ${CYAN}• Or run: export https_proxy=http://127.0.0.1:7890${NC}"
          echo -e "  ${CYAN}  before re-running this script${NC}"
        fi
        echo ""
        warn "Skipping WebUI build — server will serve UI in dev mode"
        return 0
      fi
    fi
  fi

  info "Building WebUI frontend..."
  if (cd ui && pnpm build 2>&1); then
    ok "WebUI built to ui/dist/"
  else
    warn "WebUI build had issues (server can still serve UI in dev mode)"
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

  # Check if minimum config is already satisfied (API key in config.yaml + WebUI token in .env)
  HAS_API_KEY=0
  if [ -f config.yaml ]; then
    HAS_API_KEY=$(grep -c 'api_key:' config.yaml 2>/dev/null | head -1)
    # Still count as 0 if it's the placeholder
    grep -q 'api_key: sk-xxx' config.yaml 2>/dev/null && HAS_API_KEY=0
  fi
  HAS_TOKEN=0
  if [ -f .env ]; then
    HAS_TOKEN=$(grep -c '^WEBUI_TOKEN=' .env 2>/dev/null | head -1)
    grep -q 'WEBUI_TOKEN=changeme' .env 2>/dev/null && HAS_TOKEN=0
  fi
  if [ "$HAS_API_KEY" -gt 0 ] && [ "$HAS_TOKEN" -gt 0 ]; then
    ok "Config appears complete (API key in config.yaml, WebUI token in .env) — skipping setup"
    return 0
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
      PI_AI_MODEL="deepseek-v4-flash"
      PI_AI_REASONING_MODEL="deepseek-v4-pro"
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

  # Write provider config to config.yaml (primary source), then write a minimal
  # .env with only WEBUI_TOKEN + LOG_LEVEL. Avoids duplication and ensures the
  # Settings UI shows editable provider entries.
  BASE_URL_LINE=""
  [ -n "$DEFAULT_BASE_URL" ] && BASE_URL_LINE="cfg.provider.base_url = '${DEFAULT_BASE_URL}';"

  if [ -f config.yaml ]; then
    node -e "
const { readFileSync, writeFileSync } = require('fs');
const { load, dump } = require('js-yaml');
const cfg = load(readFileSync('config.yaml', 'utf8')) || {};
cfg.provider = cfg.provider || {};
cfg.provider.primary = '${PI_AI_PROVIDER}/${PI_AI_MODEL}';
cfg.provider.reasoning = '${PI_AI_PROVIDER}/${PI_AI_REASONING_MODEL}';
cfg.provider.api_key = '${PI_AI_API_KEY}';
${BASE_URL_LINE}
cfg.provider_keys = cfg.provider_keys || {};
cfg.provider_keys['${PI_AI_PROVIDER}'] = { api_key: '${PI_AI_API_KEY}' };
if ('${DEFAULT_BASE_URL}') cfg.provider_keys['${PI_AI_PROVIDER}'].base_url = '${DEFAULT_BASE_URL}';
writeFileSync('config.yaml', dump(cfg, { lineWidth: -1, noRefs: true }), 'utf8');
" 2>/dev/null
    ok "Provider config saved to config.yaml"
  fi

  # Write minimal .env — only values that must stay in env (WebUI auth token)
  {
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
verify_sqlite_vec
install_ui_deps
setup_config
build_project
install_service
finish
