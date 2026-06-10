# ============================================================================
# install.ps1 — OhMyAgent one-click install script (Windows)
#
# Usage:
#   git clone <repo-url> $env:USERPROFILE\.ohmyagent
#   cd $env:USERPROFILE\.ohmyagent
#   .\scripts\install.ps1
# ============================================================================

$ErrorActionPreference = "Stop"

# cd to project root (parent of scripts/ directory)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
Set-Location $ProjectDir

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  OhMyAgent Installer (Windows)" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "[INFO] Platform: Windows" -ForegroundColor Green

# ─── Step 1: Check Node.js >= 20 ───
Write-Host "[1/7] Checking Node.js >= 20..." -ForegroundColor Cyan
try {
    $nodeVersion = node -v
    $major = [int]($nodeVersion -replace 'v', '').Split('.')[0]
    if ($major -lt 20) {
        Write-Host "[ERROR] Node.js >= 20 is required, current version: $nodeVersion" -ForegroundColor Red
        Write-Host "Download from https://nodejs.org" -ForegroundColor Red
        exit 1
    }
    Write-Host "[INFO] Node.js $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Node.js is not installed. Download from https://nodejs.org" -ForegroundColor Red
    exit 1
}

# ─── Step 2: Install pnpm ───
Write-Host "[2/7] Installing pnpm..." -ForegroundColor Cyan
try {
    $null = pnpm --version 2>$null
} catch {
    Write-Host "[INFO] Installing pnpm..." -ForegroundColor Yellow
    npm install -g pnpm
}
Write-Host "[INFO] pnpm $(pnpm -v)" -ForegroundColor Green

# ─── Step 3: Install dependencies ───
Write-Host "[3/7] Installing dependencies..." -ForegroundColor Cyan
pnpm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "[WARN] pnpm install failed. You may need Visual Studio Build Tools." -ForegroundColor Yellow
    Write-Host "       npm install -g windows-build-tools" -ForegroundColor Yellow
    Write-Host "       Or install Visual Studio 2022 Community with 'Desktop development with C++'" -ForegroundColor Yellow
}

# ─── Step 4: Build ───
Write-Host "[4/7] Building TypeScript..." -ForegroundColor Cyan
pnpm build

# ─── Step 5: Build WebUI ───
Write-Host "[5/7] Building WebUI frontend..." -ForegroundColor Cyan
if (Test-Path ui/package.json) {
    Push-Location ui
    pnpm install | Out-Null
    pnpm build
    Pop-Location
    Write-Host "[INFO] WebUI built to ui/dist/" -ForegroundColor Green
} else {
    Write-Host "[WARN] ui/package.json not found, skipping WebUI build" -ForegroundColor Yellow
}

# ─── Step 6: Create directories and config ───
Write-Host "[6/7] Creating runtime directories and config files..." -ForegroundColor Cyan
$homeDir = $env:USERPROFILE
New-Item -ItemType Directory -Force -Path "$homeDir\.ohmyagent\data\logs" | Out-Null

if (-not (Test-Path config.yaml)) {
    if (Test-Path config.yaml.example) {
        Copy-Item config.yaml.example config.yaml
        Write-Host "[WARN] Created config.yaml from config.yaml.example. Please edit with your settings." -ForegroundColor Yellow
    }
}

if (-not (Test-Path .env)) {
    if (Test-Path .env.example) {
        Copy-Item .env.example .env
        Write-Host "[WARN] Created .env from .env.example. Please fill in your API keys." -ForegroundColor Yellow
    }
}

# ─── Step 6: Link CLI ───
Write-Host "[7/7] Setting up ohmyagent command..." -ForegroundColor Cyan
try {
    npm link 2>$null
} catch {
    Write-Host "[WARN] npm link failed. Run manually: npm link" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "[INFO] Installation complete!" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Cyan

$installedService = $false

# Offer to install scheduled task (auto-start at logon, runs in user session)
$choice = Read-Host "Install as scheduled task (auto-start at logon, no terminal window)? [y/N]"
if ($choice -match '^[Yy]$') {
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")
    if (-not $isAdmin) {
        Write-Host "[WARN] Installing a scheduled task requires Administrator privileges." -ForegroundColor Yellow
        Write-Host "       Restart PowerShell as Administrator and run: ohmyagent service install" -ForegroundColor Yellow
    } else {
        Write-Host "[INFO] Installing scheduled task..." -ForegroundColor Green
        ohmyagent service install
        if ($LASTEXITCODE -eq 0) { $installedService = $true }
    }
}

Write-Host ""
Write-Host "  Quick start:"
Write-Host "    1. Edit config.yaml and .env"
Write-Host "    2. ohmyagent doctor           # System diagnostics"

if ($installedService) {
    Write-Host ""
    Write-Host "  Service management (Task Scheduler):"
    Write-Host "    schtasks /Query /TN ""OhMyAgent""  # Status"
    Write-Host "    schtasks /Run /TN ""OhMyAgent""    # Start"
    Write-Host "    schtasks /End /TN ""OhMyAgent""    # Stop"
    Write-Host "    taskschd.msc                      # GUI"
    Write-Host ""
    Write-Host "  ohmyagent status also works to check if running."
} else {
    Write-Host "    3. ohmyagent start            # Start in background"
    Write-Host "    4. ohmyagent status           # Check status"
    Write-Host ""
    Write-Host "  To install as a scheduled task later (admin required):"
    Write-Host "    ohmyagent service install"
}
