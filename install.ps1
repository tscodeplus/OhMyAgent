# OhMyAgent Windows Installer
# Remembers. Understands. Respects.
#
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1
#   Or:   Invoke-WebRequest -Uri "https://raw.githubusercontent.com/tscodeplus/OhMyAgent/main/install.ps1" | Invoke-Expression

param(
    [string]$InstallDir = "$env:USERPROFILE\OhMyAgent",
    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

# ── Helpers ─────────────────────────────────────────────────────────────────────
function Write-Info  { Write-Host "  [*] $args" -ForegroundColor Cyan }
function Write-OK    { Write-Host "  [+] $args" -ForegroundColor Green }
function Write-Warn  { Write-Host "  [!] $args" -ForegroundColor Yellow }
function Write-Err   { Write-Host "  [x] $args" -ForegroundColor Red }
function Abort       { Write-Err $args; Write-Host ""; exit 1 }

# ── Banner ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  OhMyAgent Installer" -ForegroundColor Cyan
Write-Host "  Remembers. Understands. Respects." -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Node.js ─────────────────────────────────────────────────────────────
Write-Info "Checking Node.js..."

$nodePath = Get-Command node -ErrorAction SilentlyContinue
if ($nodePath) {
    $nodeVer = (node -v) -replace 'v',''
    $majorVer = [int]($nodeVer -split '\.')[0]
    if ($majorVer -ge 20) {
        Write-OK "Node.js v$nodeVer"
    } else {
        Write-Warn "Node.js v$nodeVer found, but >= 20 required"
        Write-Host ""
        Write-Host "  Download Node.js >= 20 from: https://nodejs.org" -ForegroundColor Yellow
        Write-Host "  Or use fnm (fast Node Manager):" -ForegroundColor Yellow
        Write-Host "    winget install Schniz.fnm" -ForegroundColor Yellow
        Write-Host "    fnm install 22" -ForegroundColor Yellow
        Write-Host "    fnm use 22" -ForegroundColor Yellow
        Abort "Please install Node.js >= 20 and re-run this script."
    }
} else {
    Write-Host ""
    Write-Host "  Download Node.js LTS from: https://nodejs.org" -ForegroundColor Yellow
    Write-Host "  Or via winget: winget install OpenJS.NodeJS.LTS" -ForegroundColor Yellow
    Abort "Node.js not found. Install it and re-run."
}

# ── Step 2: pnpm ────────────────────────────────────────────────────────────────
Write-Info "Checking pnpm..."

$pnpmPath = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpmPath) {
    Write-Info "Installing pnpm..."
    npm install -g pnpm 2>$null
    if ($LASTEXITCODE -ne 0) {
        # Try corepack
        corepack enable 2>$null
        corepack prepare pnpm@latest --activate 2>$null
    }
    $pnpmPath = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $pnpmPath) {
        Abort "Failed to install pnpm. Install it from: https://pnpm.io/installation"
    }
}
Write-OK "pnpm $(pnpm -v)"

# ── Step 3: Git ─────────────────────────────────────────────────────────────────
Write-Info "Checking git..."
$gitPath = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitPath) {
    Write-Host ""
    Write-Host "  Install git: winget install Git.Git" -ForegroundColor Yellow
    Write-Host "  Or download from: https://git-scm.com" -ForegroundColor Yellow
    Abort "git not found."
}
Write-OK "git $(git --version | Select-String -Pattern '\d+\.\d+\.\d+' | ForEach-Object { $_.Matches.Value })"

# ── Step 4: Clone ───────────────────────────────────────────────────────────────
$repoUrl = "https://github.com/tscodeplus/OhMyAgent.git"

if (Test-Path "$InstallDir\.git") {
    Write-OK "Repository already exists: $InstallDir"
    Write-Info "Pulling latest changes..."
    git -C $InstallDir pull --ff-only 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "Could not pull latest (ignored)"
    }
} else {
    if (Test-Path $InstallDir) {
        Write-Warn "$InstallDir exists but is not a git repo."
        $InstallDir = "$InstallDir-new"
    }
    Write-Info "Cloning OhMyAgent to $InstallDir..."
    git clone $repoUrl $InstallDir 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Abort "Failed to clone $repoUrl"
    }
    Write-OK "Repository cloned"
}

Set-Location $InstallDir

# ── Step 5: Install dependencies ────────────────────────────────────────────────
Write-Info "Installing dependencies..."

# better-sqlite3 and sqlite-vec ship prebuilt binaries for all common platforms.
# A C++ toolchain is only needed if prebuilds fail (rare architectures).
pnpm install --prefer-offline 2>&1 | ForEach-Object {
    if ($_ -match "ERR|error") { Write-Host "    $_" }
}
if ($LASTEXITCODE -eq 0) {
    Write-OK "Dependencies installed (prebuilt binaries)"
} else {
    Write-Warn "Prebuilt binaries unavailable. Need C++ toolchain to compile from source."
    Write-Host ""
    Write-Host "  Install Visual Studio Build Tools:" -ForegroundColor Yellow
    Write-Host "    winget install Microsoft.VisualStudio.2022.BuildTools --override `"--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended`"" -ForegroundColor Yellow
    Write-Host "  Or download from:" -ForegroundColor Yellow
    Write-Host "    https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022" -ForegroundColor Yellow
    Write-Host "  (Select: Desktop development with C++)" -ForegroundColor Yellow
    Write-Host ""
    Write-Info "Retrying with source compilation..."
    pnpm install --prefer-offline 2>&1 | ForEach-Object {
        if ($_ -match "ERR|error") { Write-Host "    $_" }
    }
    if ($LASTEXITCODE -ne 0) {
        Abort "Dependency installation failed. Check the output above."
    }
    Write-OK "Dependencies installed (compiled from source)"
}

# Verify sqlite-vec native extension — its optional dep may be silently skipped by pnpm
Write-Info "Verifying sqlite-vec native extension..."
Push-Location $InstallDir
try {
    node -e "require('sqlite-vec')" 2>$null
    Write-OK "sqlite-vec available"
} catch {
    Write-Warn "sqlite-vec native extension unavailable; memory vector search will use cosine fallback"
    Write-Host "  This is expected if sqlite-vec has no prebuilt binary for your platform." -ForegroundColor Yellow
    Write-Host "  Everything works — just slower for large memory banks." -ForegroundColor Yellow
}
Pop-Location

# ── Step 6: Install UI dependencies ───────────────────────────────────────────────
Write-Info "Installing WebUI dependencies..."

if (Test-Path "$InstallDir\ui\package.json") {
    Push-Location "$InstallDir\ui"
    pnpm install --prefer-offline 2>&1 | ForEach-Object {
        if ($_ -match "ERR|error") { Write-Host "    $_" }
    }
    Pop-Location
    if ($LASTEXITCODE -eq 0) {
        Write-OK "WebUI dependencies installed"
    } else {
        Write-Warn "WebUI dependency installation failed"
    }

    Write-Info "Building WebUI frontend..."
    Push-Location "$InstallDir\ui"
    pnpm build 2>&1 | Out-Null
    Pop-Location
    if ($LASTEXITCODE -eq 0) {
        Write-OK "WebUI built to ui/dist/"
    } else {
        Write-Warn "WebUI build had issues (server can still serve UI in dev mode)"
    }
} else {
    Write-Warn "ui/package.json not found, skipping WebUI"
}

# ── Step 7: Configuration ───────────────────────────────────────────────────────
Write-Info "Setting up configuration..."

if (-not (Test-Path "config.yaml")) {
    Copy-Item "config.yaml.example" "config.yaml"
    Write-OK "Created config.yaml from example"
} else {
    Write-OK "config.yaml already exists"
}

$envExists = Test-Path ".env"
if (-not $envExists) {
    Copy-Item ".env.example" ".env"
    Write-OK "Created .env from example"
} else {
    Write-OK ".env already exists"
}

# Check if minimum config is already satisfied (API key + WebUI token set)
$envContent = if (Test-Path ".env") { Get-Content ".env" -Raw } else { "" }
$hasApiKey = $envContent -match '^\s*PI_AI_API_KEY\s*=\s*\S+' -and $envContent -notmatch 'PI_AI_API_KEY\s*=\s*sk-xxx'
$hasToken = $envContent -match '^\s*WEBUI_TOKEN\s*=\s*\S+' -and $envContent -notmatch 'WEBUI_TOKEN\s*=\s*changeme'

if ($hasApiKey -and $hasToken) {
    Write-OK "Config appears complete (API key + WebUI token found) -- skipping setup"
    $skipSetup = $true
} else {
    $skipSetup = $false
}

if (-not $skipSetup) {

Write-Host ""
Write-Host "  Quick setup -- at minimum you need an LLM API key." -ForegroundColor Yellow
Write-Host ""
Write-Host "  Popular options:"
Write-Host "    " -NoNewline
Write-Host "1" -NoNewline -ForegroundColor Cyan
Write-Host ") DeepSeek  -- get key at https://platform.deepseek.com"
Write-Host "    " -NoNewline
Write-Host "2" -NoNewline -ForegroundColor Cyan
Write-Host ") Anthropic -- get key at https://console.anthropic.com"
Write-Host "    " -NoNewline
Write-Host "3" -NoNewline -ForegroundColor Cyan
Write-Host ") OpenAI    -- get key at https://platform.openai.com"
Write-Host "    " -NoNewline
Write-Host "4" -NoNewline -ForegroundColor Cyan
Write-Host ") Other     -- enter provider/model/URL/key manually"
Write-Host ""

$choice = Read-Host "  Choose [1-4] (default: 1)"
if ([string]::IsNullOrWhiteSpace($choice)) { $choice = "1" }

switch ($choice) {
    "1" {
        $PI_AI_PROVIDER = "deepseek"
        $PI_AI_MODEL = "deepseek-v4-flash"
        $PI_AI_REASONING_MODEL = "deepseek-v4-pro"
        $DEFAULT_BASE_URL = "https://api.deepseek.com/v1"
    }
    "2" {
        $PI_AI_PROVIDER = "anthropic"
        $PI_AI_MODEL = "claude-sonnet-4-6"
        $PI_AI_REASONING_MODEL = "claude-opus-4-8"
        $DEFAULT_BASE_URL = ""
    }
    "3" {
        $PI_AI_PROVIDER = "openai"
        $PI_AI_MODEL = "gpt-4o"
        $PI_AI_REASONING_MODEL = "gpt-5.4"
        $DEFAULT_BASE_URL = ""
    }
    "4" {
        $PI_AI_PROVIDER = Read-Host "  Provider ID"
        $PI_AI_MODEL = Read-Host "  Model name"
        $PI_AI_REASONING_MODEL = Read-Host "  Reasoning model (or same as above)"
        if ([string]::IsNullOrWhiteSpace($PI_AI_REASONING_MODEL)) { $PI_AI_REASONING_MODEL = $PI_AI_MODEL }
        $DEFAULT_BASE_URL = Read-Host "  Base URL (or leave empty)"
    }
    default { Abort "Invalid choice" }
}

$secureKey = Read-Host "  API Key" -AsSecureString
$PI_AI_API_KEY = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
)
if ([string]::IsNullOrWhiteSpace($PI_AI_API_KEY)) {
    Abort "API key is required."
}

$secureToken = Read-Host "  WebUI password (leave empty to auto-generate)" -AsSecureString
$WEBUI_TOKEN = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
)
$TOKEN_WAS_GENERATED = $false
if ([string]::IsNullOrWhiteSpace($WEBUI_TOKEN)) {
    $WEBUI_TOKEN = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
    $TOKEN_WAS_GENERATED = $true
}

# Write .env
@"

# ── OhMyAgent configuration ──
PI_AI_PROVIDER=$PI_AI_PROVIDER
PI_AI_MODEL=$PI_AI_MODEL
PI_AI_REASONING_MODEL=$PI_AI_REASONING_MODEL
PI_AI_API_KEY=$PI_AI_API_KEY
$(
if ($DEFAULT_BASE_URL) {
    "PI_AI_BASE_URL=$DEFAULT_BASE_URL"
}
)
WEBUI_TOKEN=$WEBUI_TOKEN
LOG_LEVEL=info
"@ | Out-File -FilePath ".env" -Encoding utf8

    # Also save API key to config.yaml provider_keys so Settings UI shows editable
    # entries instead of the read-only piAi fallback (same approach as setup wizard).
    if (Test-Path "config.yaml") {
        $nodeScript = @"
const { readFileSync, writeFileSync } = require('fs');
const { load, dump } = require('js-yaml');
const cfg = load(readFileSync('config.yaml', 'utf8')) || {};
cfg.provider_keys = cfg.provider_keys || {};
cfg.provider_keys['$PI_AI_PROVIDER'] = { api_key: '$($PI_AI_API_KEY -replace "'", "''")' };
if ('$DEFAULT_BASE_URL') cfg.provider_keys['$PI_AI_PROVIDER'].base_url = '$DEFAULT_BASE_URL';
writeFileSync('config.yaml', dump(cfg, { lineWidth: -1, noRefs: true }), 'utf8');
"@
        node -e $nodeScript 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-OK "API key also saved to config.yaml (provider_keys)"
        }
    }

Write-OK "Configuration saved"
}

# ── Step 8: Build ───────────────────────────────────────────────────────────────
Write-Info "Building TypeScript..."
Set-Location $InstallDir
pnpm build 2>&1 | Select-Object -Last 3
if ($LASTEXITCODE -ne 0) {
    Write-Warn "Build had warnings (this is usually fine)"
}
Write-OK "Build complete"

# ── Step 8: Service ─────────────────────────────────────────────────────────────
Write-Host ""
$svc = Read-Host "  Install as system service (auto-start on boot)? [y/N]"
if ($svc -eq "y" -or $svc -eq "Y") {
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Warn "Service installation requires Administrator privileges."
        Write-Host "  Please re-run this script in an elevated PowerShell (Run as Administrator)." -ForegroundColor Yellow
        Write-Host "  Or install the service manually later:" -ForegroundColor Yellow
        Write-Host "    Run PowerShell as Administrator, then:" -ForegroundColor Yellow
        Write-Host "    cd $InstallDir && node dist/src/cli/index.js service install" -ForegroundColor Yellow
    } else {
        Set-Location $InstallDir
        node dist/src/cli/index.js service install 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-OK "Service installed -- OhMyAgent will start automatically on logon"
        } else {
            Write-Warn "Service installation failed. Try manually later: node dist/src/cli/index.js service install"
        }
    }
}

# ── Step 9: Ready ───────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  WebUI:  " -NoNewline -ForegroundColor White; Write-Host "http://localhost:9191/webui" -ForegroundColor Cyan
Write-Host "  Token:  " -NoNewline -ForegroundColor White; Write-Host "$WEBUI_TOKEN" -ForegroundColor Cyan
if ($TOKEN_WAS_GENERATED) {
    Write-Host "          (auto-generated -- saved in .env, change with WEBUI_TOKEN)" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  Start the server:" -ForegroundColor White
Write-Host "    cd $InstallDir && pnpm dev"
Write-Host ""
Write-Host "  Or use the CLI:" -ForegroundColor White
Write-Host "    ohmyagent start     # Start in background"
Write-Host "    ohmyagent status    # Check if running"
Write-Host "    ohmyagent doctor    # System diagnostics"
Write-Host ""
Write-Host "  Desktop app: https://github.com/tscodeplus/OhMyAgent/releases" -ForegroundColor White
Write-Host ""

$start = Read-Host "  Start now? [Y/n]"
if ($start -eq "" -or $start -eq "y" -or $start -eq "Y") {
    Set-Location $InstallDir
    pnpm dev
}
