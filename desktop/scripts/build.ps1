# ============================================================================
# OhMyAgent Desktop Build Script
# ============================================================================
# Automates: WSL sync → root TS build → WebUI build → dep flattening → packaging
#
# Usage (Windows PowerShell, run from desktop/ directory):
#   .\scripts\build.ps1                  # Sync + build portable + NSIS installer
#   .\scripts\build.ps1 -Portable        # Build portable only (win-unpacked)
#   .\scripts\build.ps1 -Installer       # Build NSIS installer only
#   .\scripts\build.ps1 -Clean           # Clean before building
#   .\scripts\build.ps1 -NoSync          # Skip WSL code sync
#   .\scripts\build.ps1 -SyncOnly        # Only sync code from WSL, no build
#   .\scripts\build.ps1 -SkipRootBuild   # Skip root TS + WebUI builds
#   .\scripts\build.ps1 -CheckOnly       # Only verify prerequisites
#
# From WSL2 / Termux:
#   powershell.exe -File "E:\Code\OhMyAgent\desktop\scripts\build.ps1"
# ============================================================================

param(
    [switch]$Portable,
    [switch]$Installer,
    [switch]$Clean,
    [switch]$NoSync,
    [switch]$SyncOnly,
    [switch]$SkipRootBuild,
    [switch]$SkipWebUI,
    [switch]$CheckOnly
)

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot
$DesktopDir = Split-Path -Parent $ScriptDir
$RootDir = Split-Path -Parent $DesktopDir

# Use npmmirror for Electron binary downloads (GitHub often unreachable from China)
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"

# If neither flag set, build both
if (-not $Portable -and -not $Installer) {
    $Portable = $true
    $Installer = $true
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

$StartTime = Get-Date

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host ">>> $msg" -ForegroundColor Cyan
}

function Write-OK([string]$msg) {
    Write-Host "    OK  $msg" -ForegroundColor Green
}

function Write-Warn([string]$msg) {
    Write-Host "    WARN  $msg" -ForegroundColor Yellow
}

function Write-Fail([string]$msg) {
    Write-Host "    FAIL  $msg" -ForegroundColor Red
}

function Write-Info([string]$msg) {
    Write-Host "    ..  $msg" -ForegroundColor Gray
}

# Run a command via cmd /c to avoid PowerShell treating stderr as fatal errors.
# Returns ($success: bool, $output: string)
function Invoke-Cmd([string]$command, [string]$cwd) {
    $prevEA = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $prevCwd = Get-Location
    try {
        Set-Location $cwd
        # Set CI=true so pnpm doesn't prompt for TTY on clean builds
        $env:CI = "true"
        $output = cmd /c "$command 2>&1" 2>&1 | Out-String
        $success = ($LASTEXITCODE -eq 0)
        return @{ Success = $success; Output = $output }
    } finally {
        Set-Location $prevCwd
        $ErrorActionPreference = $prevEA
    }
}

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------

function Check-Prerequisites {
    Write-Step "Checking prerequisites"

    $errors = @()

    # Node.js
    try {
        $nodeVer = node --version 2>&1 | Out-String
        Write-OK "Node.js $($nodeVer.Trim())"
    } catch {
        $errors += "Node.js not found. Install from https://nodejs.org/"
    }

    # npm
    try {
        $npmVer = npm --version 2>&1 | Out-String
        Write-OK "npm v$($npmVer.Trim())"
    } catch {
        $errors += "npm not found"
    }

    # pnpm (cd to local drive first to avoid UNC path warnings from WSL)
    try {
        Push-Location C:\
        $pnpmRaw = pnpm --version 2>&1 | Out-String
        Pop-Location
        $pnpmVer = ($pnpmRaw -split "`n" | Where-Object { $_ -match '^\d+\.\d+\.\d+' } | Select-Object -First 1).Trim()
        if ($pnpmVer) {
            Write-OK "pnpm v$pnpmVer"
        } else {
            $errors += "pnpm not found. Install with: npm install -g pnpm"
        }
    } catch {
        Pop-Location -ErrorAction SilentlyContinue
        $errors += "pnpm not found. Install with: npm install -g pnpm"
    }

    # Check key directories
    if (-not (Test-Path $RootDir)) {
        $errors += "Root directory not found: $RootDir"
    }
    if (-not (Test-Path "$DesktopDir\package.json")) {
        $errors += "desktop/package.json not found at $DesktopDir"
    }
    if (-not (Test-Path "$RootDir\package.json")) {
        $errors += "Root package.json not found at $RootDir"
    }

    if ($errors.Count -gt 0) {
        Write-Host ""
        Write-Host "=== PREREQUISITE ERRORS ===" -ForegroundColor Red
        foreach ($e in $errors) {
            Write-Host "  X $e" -ForegroundColor Red
        }
        exit 1
    }

    Write-OK "All prerequisites satisfied"
    Write-Info "Root:    $RootDir"
    Write-Info "Desktop: $DesktopDir"
}

# ---------------------------------------------------------------------------
# Clean
# ---------------------------------------------------------------------------

function Invoke-Clean {
    Write-Step "Cleaning previous build artifacts"

    $dirs = @(
        "$DesktopDir\.electron-deps",
        "$DesktopDir\release",
        "$DesktopDir\dist",
        "$RootDir\dist"
    )

    foreach ($dir in $dirs) {
        if (Test-Path $dir) {
            try {
                Remove-Item -Path $dir -Recurse -Force -ErrorAction Stop
                Write-OK "Removed $($dir.Replace($DesktopDir, '...'))"
            } catch {
                Write-Warn "Could not remove $dir - may be locked"
                Write-Info "Waiting 3s and retrying..."
                Start-Sleep -Seconds 3
                try {
                    Remove-Item -Path $dir -Recurse -Force -ErrorAction Stop
                    Write-OK "Removed (retry)"
                } catch {
                    Write-Fail "Cannot remove $dir. Close other programs and retry."
                    throw
                }
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Kill stale processes
# ---------------------------------------------------------------------------

function Invoke-KillStaleProcesses {
    $stale = Get-Process -Name "OhMyAgent" -ErrorAction SilentlyContinue
    if ($stale) {
        Write-Step "Killing stale OhMyAgent processes"
        $stale | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Write-OK "Terminated $($stale.Count) OhMyAgent process(es)"
    }
}

# ---------------------------------------------------------------------------
# Sync code from WSL
# ---------------------------------------------------------------------------

# Default WSL source path (Linux side) and Windows target path.
# Override via environment variables or edit the defaults below.
$WslSourcePath = if ($env:OHMYAGENT_WSL_SRC) { $env:OHMYAGENT_WSL_SRC } else { "/home/iwapu/projects/OhMyAgent/" }
$WinTargetPath  = if ($env:OHMYAGENT_WIN_TARGET) { $env:OHMYAGENT_WIN_TARGET } else { $RootDir }

# Directories/files excluded from rsync. Socket files and build artifacts can't
# be stored on NTFS and are harmless to skip.
$RsyncExcludes = @(
    "node_modules",
    "dist",
    ".electron-deps",
    "release",
    "data",
    "coverage",
    ".env",
    "*.log",
    ".git",
    ".codegraph/.daemon.sock"
)

function Invoke-SyncCode {
    Write-Step "Syncing code from WSL"

    # Check if wsl.exe is available (faster than `wsl --status` and avoids
    # UNC-path issues when powershell.exe is invoked from inside WSL).
    $wslExe = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if (-not $wslExe) {
        Write-Warn "wsl.exe not found — skipping sync"
        Write-Info "Run this script from Windows to sync from WSL."
        return
    }

    # Convert Windows path (E:\Code\OhMyAgent) to WSL path (/mnt/e/Code/OhMyAgent)
    $winDrive = ($WinTargetPath -replace '^([A-Za-z]):.*', '$1').ToLower()
    $wslTarget = $WinTargetPath -replace '^[A-Za-z]:', "/mnt/$winDrive" -replace '\\', '/'

    # Build rsync exclude arguments
    $excludeArgs = ($RsyncExcludes | ForEach-Object { "--exclude='$_'" }) -join " "

    Write-Info "Source: $WslSourcePath"
    Write-Info "Target: $WinTargetPath (WSL: $wslTarget)"

    # Run rsync inside WSL so paths are native. Use Start-Process to avoid
    # UNC-path interpretation issues when called from within WSL.
    $rsyncArgs = "rsync -av --delete $excludeArgs $WslSourcePath $wslTarget"
    Write-Info "Running: wsl rsync -av --delete [excludes] <src> <target>"

    $prevEA = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $proc = Start-Process -FilePath "wsl.exe" -ArgumentList $rsyncArgs -NoNewWindow -Wait -PassThru -RedirectStandardOutput "$env:TEMP\ohmyagent-rsync-stdout.txt" -RedirectStandardError "$env:TEMP\ohmyagent-rsync-stderr.txt"
    $success = ($proc.ExitCode -eq 0)
    $ErrorActionPreference = $prevEA

    if ($success) {
        Write-OK "Code synced successfully"
    } else {
        # rsync often exits non-zero on harmless errors (socket files, etc.)
        # Treat as warning — the build can still succeed.
        Write-Warn "rsync completed with warnings (non-fatal)"
        try {
            $errOutput = Get-Content "$env:TEMP\ohmyagent-rsync-stderr.txt" -ErrorAction SilentlyContinue
            if ($errOutput) {
                $lines = $errOutput -split "`n"
                $lastLines = $lines[-5..-1] | Where-Object { $_ }
                foreach ($line in $lastLines) { Write-Info $line.Trim() }
            }
        } catch { }
    }
    # Clean up temp files
    Remove-Item "$env:TEMP\ohmyagent-rsync-stdout.txt", "$env:TEMP\ohmyagent-rsync-stderr.txt" -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# Root project build
# ---------------------------------------------------------------------------

function Invoke-RootBuild {
    Write-Step "Building root project (TypeScript + Locales)"

    $tscStart = Get-Date
    $r = Invoke-Cmd "pnpm build" $RootDir

    # pnpm may exit non-zero on warnings (deprecated config fields).
    # Actual failure indicator: dist/src/app/bootstrap.js is missing.
    if (-not (Test-Path "$RootDir\dist\src\app\bootstrap.js")) {
        Write-Fail "Root build failed — dist/src/app/bootstrap.js not found"
        Write-Host $r.Output
        throw "Root build failed"
    }

    # Verify tsc-alias resolved all tsconfig path aliases.
    # Unresolved @earendil-works imports cause runtime "Cannot find package" errors.
    $unresolved = Select-String -Path "$RootDir\dist\src\app\bootstrap.js" -Pattern "@earendil-works" -SimpleMatch -ErrorAction SilentlyContinue
    if ($unresolved) {
        Write-Fail "tsc-alias did not resolve path aliases — @earendil-works imports remain in bootstrap.js"
        Write-Info "This happens when tsc fails before tsc-alias runs. Check build output above for TS errors."
        throw "Root build incomplete: tsc-alias did not run"
    }

    $elapsed = [math]::Round(((Get-Date) - $tscStart).TotalSeconds, 1)
    Write-OK "Root build complete (${elapsed}s)"

    # Create a minimal package.json in dist/ so that the server-dist
    # extraResources is self-contained for ESM resolution.
    # Without this, Node.js treats .js files as CommonJS when the installed
    # Electron app has no package.json in its ancestor chain (unlike the
    # portable build which inherits "type":"module" from desktop/package.json).
    Set-Content -Path "$RootDir\dist\package.json" -Value '{ "type": "module" }'
    Write-OK "Added dist/package.json (type: module for ESM resolution)"
}

# ---------------------------------------------------------------------------
# WebUI build
# ---------------------------------------------------------------------------

function Invoke-WebUIBuild {
    Write-Step "Building WebUI (Vite + React)"

    $distPath = "$RootDir\ui\dist"
    $srcPath = "$RootDir\ui\src"

    if (-not (Test-Path $srcPath)) {
        Write-Warn "ui/src/ not found - skipping WebUI build"
        if (-not (Test-Path $distPath)) {
            throw "ui/dist/ not found and ui/src/ not found — cannot build WebUI"
        }
        Write-Info "Using existing ui/dist/"
        return
    }

    $r = Invoke-Cmd "pnpm build" "$RootDir\ui"

    if (Test-Path $distPath) {
        Write-OK "WebUI build complete"
    } else {
        Write-Fail "WebUI build failed — ui/dist/ not found"
        Write-Host $r.Output
        throw "WebUI build failed"
    }
}

# ---------------------------------------------------------------------------
# Bundle dependencies
# ---------------------------------------------------------------------------

function Invoke-BundleDeps {
    Write-Step "Bundling dependencies (flat node_modules)"

    $r = Invoke-Cmd "node scripts/bundle-deps.cjs" $DesktopDir

    $nmPath = "$DesktopDir\.electron-deps\node_modules"
    if (Test-Path $nmPath) {
        $count = (Get-ChildItem $nmPath).Count
        if ($count -gt 10) {
            Write-OK "$count packages staged in .electron-deps/node_modules/"
        } else {
            Write-Fail "Only $count packages staged — expected 300+. bundle-deps likely failed."
            Write-Host $r.Output
            throw "bundle-deps produced too few packages"
        }
    } else {
        Write-Fail "bundle-deps failed — .electron-deps/node_modules/ not created"
        Write-Host $r.Output
        throw "bundle-deps failed"
    }
}

# ---------------------------------------------------------------------------
# Desktop TypeScript build
# ---------------------------------------------------------------------------

function Invoke-DesktopBuild {
    Write-Step "Building desktop TypeScript"

    $r = Invoke-Cmd "npx tsc" $DesktopDir

    if (-not $r.Success) {
        Write-Fail "Desktop TypeScript build failed"
        Write-Host $r.Output
        throw "Desktop tsc failed"
    }

    Write-OK "Desktop TypeScript compiled"

    # Build preload as CommonJS (.cjs) — ESM preload scripts can fail silently
    # inside ASAR in some Electron versions.
    Write-Info "Building preload.cjs (CommonJS)"
    $preloadR = Invoke-Cmd "npx tsc -p tsconfig.preload.json" $DesktopDir
    if ($preloadR.Success) {
        Remove-Item -Path "$DesktopDir\dist\preload.cjs" -Force -ErrorAction SilentlyContinue
        Rename-Item -Path "$DesktopDir\dist\preload.js" -NewName "preload.cjs" -Force
        Write-OK "preload.cjs compiled (CommonJS)"
    } else {
        Write-Warn "preload.cjs build had issues — check dist/preload.cjs"
        Write-Host $preloadR.Output
    }
}

# ---------------------------------------------------------------------------
# Electron Builder
# ---------------------------------------------------------------------------

function Invoke-Package([string]$Target) {
    $desc = if ($Target -eq "portable") { "portable (win-unpacked)" } else { "NSIS installer" }
    Write-Step "Packaging: $desc"

    $flags = if ($Target -eq "portable") { "--win --dir" } else { "--win --publish never" }
    $r = Invoke-Cmd "npx electron-builder $flags" $DesktopDir

    if (-not $r.Success) {
        Write-Fail "electron-builder failed"
        Write-Host $r.Output
        throw "electron-builder failed"
    }

    Write-OK "Packaging complete"
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

function Write-Summary {
    Write-Host ""
    Write-Host "======================================" -ForegroundColor Green
    Write-Host " BUILD COMPLETE" -ForegroundColor Green
    Write-Host "======================================" -ForegroundColor Green

    $elapsed = [math]::Round(((Get-Date) - $StartTime).TotalSeconds, 1)
    Write-Host "  Duration: ${elapsed}s" -ForegroundColor White

    if (Test-Path "$DesktopDir\release\win-unpacked\OhMyAgent.exe") {
        $exeSize = [math]::Round((Get-Item "$DesktopDir\release\win-unpacked\OhMyAgent.exe").Length / 1MB, 1)
        Write-Host "  Portable: release\win-unpacked\  (EXE: ${exeSize} MB)" -ForegroundColor White
    }

    $setupExe = Get-ChildItem "$DesktopDir\release\*Setup*.exe" -Name -ErrorAction SilentlyContinue
    if ($setupExe) {
        $setupSize = [math]::Round((Get-Item "$DesktopDir\release\$setupExe").Length / 1MB, 1)
        Write-Host "  Installer: release\$setupExe  (${setupSize} MB)" -ForegroundColor White
    }

    Write-Host ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "========================================" -ForegroundColor Magenta
Write-Host " OhMyAgent Desktop Builder" -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta
Write-Host "  Portable : $Portable" -ForegroundColor Gray
Write-Host "  Installer: $Installer" -ForegroundColor Gray
Write-Host "  Clean    : $Clean" -ForegroundColor Gray
Write-Host "  Sync     : $(-not $NoSync)" -ForegroundColor Gray
Write-Host ""

Check-Prerequisites

if ($CheckOnly) {
    Write-Host ""
    Write-OK "All checks passed. Ready to build."
    exit 0
}

Invoke-KillStaleProcesses

# ── Sync ──
if (-not $NoSync) {
    Invoke-SyncCode
} else {
    Write-Step "Skipping WSL code sync (-NoSync)"
}

if ($SyncOnly) {
    Write-Host ""
    Write-OK "Sync complete. Exiting (-SyncOnly)."
    exit 0
}

if ($Clean) {
    Invoke-Clean
}

if (-not $SkipRootBuild) {
    Invoke-RootBuild
} else {
    Write-Step "Skipping root project build (-SkipRootBuild)"
    $bootstrap = "$RootDir\dist\src\app\bootstrap.js"
    if (-not (Test-Path $bootstrap)) {
        Write-Warn "$bootstrap not found - server-dist will be incomplete!"
    }
}

if (-not $SkipWebUI) {
    Invoke-WebUIBuild
} else {
    Write-Step "Skipping WebUI build (-SkipWebUI)"
    if (-not (Test-Path "$RootDir\ui\dist")) {
        Write-Warn "ui/dist/ not found - webui-dist will be missing!"
    }
}

Invoke-BundleDeps
Invoke-DesktopBuild

# Generate icons (must run after root node_modules is available, before packaging)
Write-Step "Generating icons"
$iconResult = Invoke-Cmd "node scripts/generate-icons.cjs" $DesktopDir
if (-not $iconResult.Success) {
    Write-Warn "Icon generation had warnings (non-fatal)"
}
Write-Info $iconResult.Output
if ($Portable) {
    Invoke-Package "portable"
}
if ($Installer) {
    Invoke-Package "installer"
}

Write-Summary
