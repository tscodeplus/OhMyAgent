# ============================================================================
# OhMyAgent Desktop Build Script
# ============================================================================
# Automates: WSL sync → root TS build → WebUI build → dep flattening → packaging
#
# Usage (Windows PowerShell, run from desktop/ directory):
#   .\scripts\build.ps1                  # Build portable + NSIS installer (default)
#   .\scripts\build.ps1 -Portable        # Build portable only (win-unpacked)
#   .\scripts\build.ps1 -Nsis            # Build NSIS installer only
#   .\scripts\build.ps1 -Clean           # Clean before building
#   .\scripts\build.ps1 -SkipClean       # Override -Clean: keep src-tauri/target
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
    [switch]$Nsis,
    [switch]$Clean,
    [switch]$SkipClean,
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

# Use npmmirror for the bundled Node runtime download (fetch-node.cjs default;
# GitHub often unreachable from China). Override via NODE_MIRROR.
$env:NODE_MIRROR = "https://npmmirror.com/mirrors/node"

# Default: build all targets (portable + NSIS)
# -Portable: only portable
# -Nsis: only NSIS
if (-not $Portable -and -not $Nsis) {
    $Portable = $true
    $Nsis = $true
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

    # Rust toolchain (Tauri)
    try {
        $rustVer = rustc --version 2>&1 | Out-String
        Write-OK "Rust $($rustVer.Trim())"
    } catch {
        $errors += "rustc not found. Install via https://rustup.rs (MSVC toolchain required)"
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
        "$DesktopDir\.sidecar-deps",
        "$DesktopDir\src-tauri\target",
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

    Write-Info "Source: $WslSourcePath"
    Write-Info "Target: $WinTargetPath (WSL: $wslTarget)"

    # Use git ls-files (respects .gitignore) to build the file list, then rsync.
    # All exclusions are now in .gitignore — no manual exclude list to maintain.
    # .git directory is intentionally excluded (not needed for desktop builds).
    $rsyncCmd = "cd '$WslSourcePath' && git ls-files -z --cached --others --exclude-standard | rsync -av --delete --files-from=- --from0 --exclude='.git' ./ '$wslTarget'"
    Write-Info "Running: wsl bash -c 'git ls-files ... | rsync --files-from ...'"

    $prevEA = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $proc = Start-Process -FilePath "wsl.exe" -ArgumentList "bash", "-c", $rsyncCmd -NoNewWindow -Wait -PassThru -RedirectStandardOutput "$env:TEMP\ohmyagent-rsync-stdout.txt" -RedirectStandardError "$env:TEMP\ohmyagent-rsync-stderr.txt"
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

    # Install dependencies first — new deps may have been added since last sync
    Write-Info "Installing dependencies..."
    $installR = Invoke-Cmd "pnpm install --frozen-lockfile" $RootDir
    if (-not $installR.Success) {
        Write-Warn "pnpm install had issues (possibly non-fatal)"
    }

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

    $nmPath = "$DesktopDir\.sidecar-deps\node_modules"
    if (Test-Path $nmPath) {
        $count = (Get-ChildItem $nmPath).Count
        if ($count -gt 10) {
            Write-OK "$count packages staged in .sidecar-deps/node_modules/"
        } else {
            Write-Fail "Only $count packages staged — expected 300+. bundle-deps likely failed."
            Write-Host $r.Output
            throw "bundle-deps produced too few packages"
        }
    } else {
        Write-Fail "bundle-deps failed — .sidecar-deps/node_modules/ not created"
        Write-Host $r.Output
        throw "bundle-deps failed"
    }
}

# ---------------------------------------------------------------------------
# Sidecar TypeScript build
# ---------------------------------------------------------------------------

function Invoke-SidecarBuild {
    Write-Step "Building sidecar TypeScript"

    $r = Invoke-Cmd "npm run build:sidecar" $DesktopDir

    if (-not $r.Success) {
        Write-Fail "Sidecar TypeScript build failed"
        Write-Host $r.Output
        throw "Sidecar tsc failed"
    }

    Write-OK "Sidecar compiled to .sidecar-deps\root"
}

# ---------------------------------------------------------------------------
# Version consistency check (root / desktop / tauri.conf.json)
# ---------------------------------------------------------------------------

function Invoke-VersionCheck {
    Write-Step "Checking version consistency"
    $rootVer = (Get-Content "$RootDir\package.json" | ConvertFrom-Json).version
    $desktopVer = (Get-Content "$DesktopDir\package.json" | ConvertFrom-Json).version
    $tauriVer = (Get-Content "$DesktopDir\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
    if ($rootVer -ne $desktopVer -or $rootVer -ne $tauriVer) {
        Write-Fail "Version mismatch: root=$rootVer desktop=$desktopVer tauri.conf=$tauriVer"
        throw "Version mismatch — keep package.json / desktop/package.json / tauri.conf.json in sync"
    }
    Write-OK "Versions consistent: $rootVer"
}

# ---------------------------------------------------------------------------
# Bundled Node runtime download
# ---------------------------------------------------------------------------

function Invoke-NodeRuntime {
    Write-Step "Fetching bundled Node runtime (desktop/.node-version)"

    $r = Invoke-Cmd "node scripts/fetch-node.cjs" $DesktopDir
    if (-not $r.Success) {
        Write-Fail "Node runtime download failed"
        Write-Host $r.Output
        throw "fetch-node failed"
    }
    Write-OK $r.Output
}

# ---------------------------------------------------------------------------
# Tauri build (NSIS installer + exe in src-tauri/target/release)
# ---------------------------------------------------------------------------

function Invoke-TauriBuild {
    Write-Step "Building Tauri app (NSIS)"

    $r = Invoke-Cmd "npx tauri build --bundles nsis" $DesktopDir

    if (-not $r.Success) {
        Write-Fail "tauri build failed"
        Write-Host $r.Output
        throw "tauri build failed"
    }

    # tauri v2 has no artifact-name config — the NSIS file comes out as
    # OhMyAgent_<v>_x64-setup.exe. Rename to the Electron-era
    # OhMyAgent-Setup-<v>.exe so the updater's latest.yml URL keeps working
    # (same rename as the desktop-windows CI workflow).
    $setup = Get-ChildItem "$DesktopDir\src-tauri\target\release\bundle\nsis\OhMyAgent_*_x64-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($setup) {
        $version = (Get-Content "$DesktopDir\package.json" | ConvertFrom-Json).version
        # Rename-Item never overwrites an existing target, even with -Force —
        # drop a stale installer from a previous build first, else the standard
        # OhMyAgent-Setup-<v>.exe name silently stays an old artifact.
        $target = "OhMyAgent-Setup-$version.exe"
        Remove-Item "$DesktopDir\src-tauri\target\release\bundle\nsis\$target" -Force -ErrorAction SilentlyContinue
        Rename-Item -Force $setup.FullName $target
        Write-OK "Renamed installer to OhMyAgent-Setup-$version.exe"
    }

    Write-OK "Tauri build complete"
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

    $exe = "$DesktopDir\src-tauri\target\release\ohmyagent-desktop.exe"
    if (Test-Path $exe) {
        $exeSize = [math]::Round((Get-Item $exe).Length / 1MB, 1)
        Write-Host "  EXE (portable): src-tauri\target\release\ohmyagent-desktop.exe  (${exeSize} MB)" -ForegroundColor White
    }

    $setupExe = Get-ChildItem "$DesktopDir\src-tauri\target\release\bundle\nsis\*.exe" -Name -ErrorAction SilentlyContinue | Sort-Object | Select-Object -Last 1
    if ($setupExe) {
        $setupSize = [math]::Round((Get-Item "$DesktopDir\src-tauri\target\release\bundle\nsis\$setupExe").Length / 1MB, 1)
        Write-Host "  NSIS:     src-tauri\target\release\bundle\nsis\$setupExe  (${setupSize} MB)" -ForegroundColor White
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
Write-Host "  NSIS     : $Nsis" -ForegroundColor Gray
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
    if ($SkipClean) {
        Write-Step "Skipping clean (-SkipClean)"
    } else {
        Invoke-Clean
    }
}

if (-not $SkipRootBuild) {
    Invoke-RootBuild
} else {
    Write-Step "Skipping root project build (-SkipRootBuild)"
    $bootstrap = "$RootDir\dist\src\app\bootstrap.js"
    if (-not (Test-Path $bootstrap)) {
        Write-Warn "$bootstrap not found - server-dist will be incomplete!"
    }
    # Ensure dist/package.json exists so Node.js treats .js files as ESM.
    $distPkgJson = "$RootDir\dist\package.json"
    if (-not (Test-Path $distPkgJson)) {
        Set-Content -Path $distPkgJson -Value '{ "type": "module" }'
        Write-OK "Created dist/package.json (type: module for ESM resolution)"
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

Invoke-VersionCheck
Invoke-BundleDeps
Invoke-SidecarBuild
Invoke-NodeRuntime

if ($Portable -or $Nsis) {
    Invoke-TauriBuild
} else {
    Write-Step "No bundle targets selected — nothing to build"
}

Write-Summary
