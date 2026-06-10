// Shared PowerShell snippets for Windows desktop control.
// Used by both LocalWindowsProvider (WSL → powershell.exe) and
// SSHComputerUseProvider (SSH → Windows OpenSSH Server).

function psEscape(text: string): string {
  return text
    .replace(/`/g, '``')
    .replace(/"/g, '`"')
    .replace(/\$/g, '`$')
    .replace(/\(/g, '`(')
    .replace(/\)/g, '`)')
    .replace(/@/g, '`@')
    .replace(/\{/g, '`{')
    .replace(/\}/g, '`}')
    .replace(/\n/g, ' ')
    .replace(/\r/g, '');
}

function psSingleQuote(text: string): string {
  return text.replace(/'/g, "''");
}

/**
 * Escape text for SendKeys.SendWait — wraps special modifier characters in
 * braces so they are typed literally instead of interpreted as modifiers.
 *
 * SendKeys modifiers: + (Shift), ^ (Ctrl), % (Alt), ~ (Enter), () (grouping), {} (escaping).
 */
function psSendKeysEscape(text: string): string {
  return text
    .replace(/\{/g, '{{}')
    .replace(/\}/g, '{}}')
    .replace(/\+/g, '{+}')
    .replace(/\^/g, '{^}')
    .replace(/%/g, '{%}')
    .replace(/~/g, '{~}')
    .replace(/\(/g, '{(}')
    .replace(/\)/g, '{)}');
}

export function psListWindows(): string {
  return `
Add-Type -AssemblyName System.Windows.Forms
Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object {
  $hwnd = $_.MainWindowHandle
  $title = $_.MainWindowTitle
  $procName = $_.ProcessName
  $pid = $_.Id
  Write-Output "APP|$procName|$pid|$hwnd|$title"
}
`.trim();
}

export function psGetForegroundInfo(): string {
  return `
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class W32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumChildProc cb, IntPtr l);
  public delegate bool EnumChildProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder c, int n);
}
public struct RECT { public int L,T,R,B; }
"@
Add-Type -AssemblyName System.Windows.Forms
$fw = [W32]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder(512)
[W32]::GetWindowText($fw, $sb, 512) | Out-Null
$title = $sb.ToString()
$r = New-Object RECT
[W32]::GetWindowRect($fw, [ref]$r)
$cursor = [System.Windows.Forms.Cursor]::Position
$desktop = [W32]::GetDesktopWindow()

# Enumerate child windows as elements
$elements = @()
$idx = 0
$cb = {
  param($h, $l)
  $csb = New-Object System.Text.StringBuilder(256)
  [W32]::GetClassName($h, $csb, 256) | Out-Null
  $cls = $csb.ToString()
  $tsb = New-Object System.Text.StringBuilder(256)
  [W32]::GetWindowText($h, $tsb, 256) | Out-Null
  $ttl = $tsb.ToString()
  $cr = New-Object RECT
  [W32]::GetWindowRect($h, [ref]$cr) | Out-Null
  $w = $cr.R - $cr.L; $hgt = $cr.B - $cr.T
  if ($w -gt 0 -and $hgt -gt 0 -and ($ttl -ne '' -or $cls -ne '')) {
    $elements += @{
      elementId = "win-$idx"
      role = $(if ($cls -match 'Button|Edit|ComboBox|ListBox|Static|ScrollBar|Tab|Toolbar|Tree|MenuItem') { $cls } else { 'pane' })
      label = $(if ($ttl) { $ttl } else { $cls })
      bounds = @{ x = $cr.L; y = $cr.T; width = $w; height = $hgt }
      enabled = $true
    }
    $idx++
  }
  return $true
}
$enumDelegate = [W32+EnumChildProc]$cb
[W32]::EnumChildWindows($fw, $enumDelegate, [IntPtr]::Zero)

@{
  title = $title
  windowRect = @{ x = $r.L; y = $r.T; width = ($r.R - $r.L); height = ($r.B - $r.T) }
  desktopWidth = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
  desktopHeight = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height
  cursorX = $cursor.X; cursorY = $cursor.Y
  elementCount = $elements.Count
  elements = $elements
} | ConvertTo-Json -Compress -Depth 4
`.trim();
}

export function psTakeScreenshot(outputPath: string): string {
  const safe = outputPath.replace(/\\/g, '\\\\');
  return `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$s = [System.Windows.Forms.Screen]::PrimaryScreen
$b = $s.Bounds
$bm = New-Object System.Drawing.Bitmap($b.Width,$b.Height)
$g = [System.Drawing.Graphics]::FromImage($bm)
$g.CopyFromScreen($b.X,$b.Y,0,0,$b.Size)
$bm.Save('${safe}',[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bm.Dispose()
$bytes = [IO.File]::ReadAllBytes('${safe}')
Remove-Item '${safe}' -ErrorAction SilentlyContinue
Write-Output ([Convert]::ToBase64String($bytes))
`.trim();
}

export function psMouseClick(x: number, y: number): string {
  return `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class MI {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
[MI]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})
Start-Sleep -Milliseconds 30
[MI]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 30
[MI]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Write-Output 'ok'
`.trim();
}

export function psDoubleClick(x: number, y: number): string {
  return `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class MI2 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
[MI2]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})
Start-Sleep -Milliseconds 50
[MI2]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[MI2]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 200
[MI2]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[MI2]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Write-Output 'ok'
`.trim();
}

export function psSendKeys(text: string): string {
  return `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::SetText('${psSingleQuote(text)}')
Start-Sleep -Milliseconds 50
[System.Windows.Forms.SendKeys]::SendWait('^v')
Write-Output 'ok'
`.trim();
}

export function psPressKey(key: string): string {
  const keyMap: Record<string, string> = {
    'Enter': '{ENTER}', 'Return': '{ENTER}', 'Escape': '{ESC}', 'Esc': '{ESC}', 'Tab': '{TAB}',
    'BackSpace': '{BACKSPACE}', 'Backspace': '{BACKSPACE}', 'Delete': '{DELETE}',
    'Home': '{HOME}', 'End': '{END}',
    'Page_Up': '{PGUP}', 'Page_Down': '{PGDN}',
    'Up': '{UP}', 'Down': '{DOWN}', 'Left': '{LEFT}', 'Right': '{RIGHT}',
    'F1': '{F1}', 'F2': '{F2}', 'F3': '{F3}', 'F4': '{F4}',
    'F5': '{F5}', 'F6': '{F6}', 'F7': '{F7}', 'F8': '{F8}',
    'F9': '{F9}', 'F10': '{F10}', 'F11': '{F11}', 'F12': '{F12}',
    'Space': ' ', 'space': ' ', 'Control': '^', 'Ctrl': '^',
  };
  const sendKey = keyMap[key] || key;
  return `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${sendKey}')
Write-Output 'ok'
`.trim();
}

export function psScroll(direction: string, amount: number): string {
  const dir = direction === 'up' ? 0x0078 : direction === 'down' ? 0x0088 : 0;
  const repeats = Math.min(amount || 1, 20);
  return Array(repeats).fill(`
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr x);' -Name MS -Namespace W32
[W32.MS]::mouse_event(${dir}, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 20
`).join('\n') + "\nWrite-Output 'ok'";
}

export function psLaunchApp(appName: string): string {
  if (!/^[A-Za-z0-9._+-]+(?: [A-Za-z0-9._+-]+)*$/.test(appName)) {
    throw new Error(`Invalid application name: '${appName}'`);
  }
  // Ensure .exe extension for proper process resolution
  const appExe = appName.endsWith('.exe') ? appName : appName + '.exe';

  return `
$appExe = '${appExe}'
$procName = '${appExe.replace(/\.exe$/i, '')}'
Write-Output "CU_DEBUG|phase=launch_start|app=$appExe"

$p = Start-Process $appExe -PassThru -WindowStyle Normal
Write-Output "CU_DEBUG|phase=launch_proc|pid=$($p.Id)"

# Poll for MainWindowHandle (with timeout and exit check)
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$maxWaitMs = 20000
do {
  Start-Sleep -Milliseconds 300
  $p.Refresh()
  $hwnd = $p.MainWindowHandle
} while ($hwnd -eq [IntPtr]::Zero -and -not $p.HasExited -and $sw.ElapsedMilliseconds -lt $maxWaitMs)
$sw.Stop()
Write-Output "CU_DEBUG|phase=launch_hwnd|hwnd=$hwnd|pid=$($p.Id)|waitMs=$($sw.ElapsedMilliseconds)|hasExited=$($p.HasExited)"

if ($null -eq $hwnd -or $hwnd -eq [IntPtr]::Zero) {
  $fallback = Get-Process -Name $procName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
    Select-Object -First 1
  if ($fallback) {
    $hwnd = $fallback.MainWindowHandle
    Write-Output "CU_DEBUG|phase=launch_fallback_hwnd|hwnd=$hwnd|pid=$($fallback.Id)"
  }
}

if ($null -ne $hwnd -and $hwnd -ne [IntPtr]::Zero) {
  # ---- Win32 focus API definitions ----
  Add-Type -Name W32CU -Namespace Temp -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int dwProcessId);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
'@

  # Maximize window for freshly launched app (SW_MAXIMIZE=3)
  [Temp.W32CU]::ShowWindow($hwnd, 3) | Out-Null
  Start-Sleep -Milliseconds 150

  # Tech#1: AllowSetForegroundWindow(ASFW_ANY=-1) + SetForegroundWindow
  $allowOk = [Temp.W32CU]::AllowSetForegroundWindow(-1)
  $r1 = [Temp.W32CU]::SetForegroundWindow($hwnd)
  Write-Output "CU_DEBUG|tech=1_AllowSetFg|allowOk=$allowOk|setFgOk=$r1"

  # Tech#2: AttachThreadInput — attach to foreground thread (most reliable for WSL)
  if (-not $r1) {
    $fgWin = [Temp.W32CU]::GetForegroundWindow()
    if ($fgWin -ne [IntPtr]::Zero -and $fgWin -ne $hwnd) {
      $fgPid = 0
      $fgTid = [Temp.W32CU]::GetWindowThreadProcessId($fgWin, [ref]$fgPid)
      $myTid = [Temp.W32CU]::GetCurrentThreadId()
      if ($fgTid -ne 0) {
        [Temp.W32CU]::AttachThreadInput($myTid, $fgTid, $true) | Out-Null
        Start-Sleep -Milliseconds 50
        $r2 = [Temp.W32CU]::SetForegroundWindow($hwnd)
        [Temp.W32CU]::AttachThreadInput($myTid, $fgTid, $false) | Out-Null
        Write-Output "CU_DEBUG|tech=2_AttachThread|fgTid=$fgTid|fgPid=$fgPid|ok=$r2"
      } else { $r2 = $false; Write-Output "CU_DEBUG|tech=2_AttachThread|skipped=noFgTid" }
    } else { $r2 = $false; Write-Output "CU_DEBUG|tech=2_AttachThread|skipped=noFgWin|fgWin=$fgWin" }
  } else { $r2 = $false }

  # Tech#3: BringWindowToTop as visual-only fallback (no input focus, but visible)
  if (-not $r1 -and -not $r2) {
    [Temp.W32CU]::BringWindowToTop($hwnd) | Out-Null
    Write-Output "CU_DEBUG|tech=3_BringToTop_fallback"
  }

  $finalOk = $r1 -or $r2
  Write-Output "CU_DEBUG|phase=launch_done|hwnd=$hwnd|focusOk=$finalOk"
} else {
  Write-Output "CU_DEBUG|phase=launch_done|focusOk=false|reason=no_hwnd"
}

Write-Output 'ok'
`.trim();
}

/** Bring an already-running app to the foreground by process name. */
export function psFocusApp(appName: string): string {
  if (!/^[A-Za-z0-9._+-]+(?: [A-Za-z0-9._+-]+)*$/.test(appName)) {
    throw new Error(`Invalid application name: '${appName}'`);
  }
  const procName = appName.replace(/\.exe$/i, '');

  return `
$procName = '${procName}'
Write-Output "CU_DEBUG|phase=focus_start|proc=$procName"

$procs = @(Get-Process -Name $procName -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) {
  Write-Output "CU_DEBUG|phase=focus_error|reason=process_not_found|proc=$procName"
  Write-Error "Process not found: $procName"
  exit 1
}
$p = $procs[0]
Write-Output "CU_DEBUG|phase=focus_proc|pid=$($p.Id)|count=$($procs.Count)"

# Poll for MainWindowHandle
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$maxWaitMs = 10000
do {
  Start-Sleep -Milliseconds 200
  $p.Refresh()
  $hwnd = $p.MainWindowHandle
} while ($hwnd -eq [IntPtr]::Zero -and -not $p.HasExited -and $sw.ElapsedMilliseconds -lt $maxWaitMs)
$sw.Stop()
Write-Output "CU_DEBUG|phase=focus_hwnd|hwnd=$hwnd|pid=$($p.Id)|waitMs=$($sw.ElapsedMilliseconds)"

if ($hwnd -ne [IntPtr]::Zero) {
  # ---- Win32 focus API definitions ----
  Add-Type -Name W32CU -Namespace Temp -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int dwProcessId);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
'@

  # Restore window if minimized (SW_RESTORE=9)
  [Temp.W32CU]::ShowWindow($hwnd, 9) | Out-Null
  Start-Sleep -Milliseconds 150

  # Tech#1: AllowSetForegroundWindow(ASFW_ANY=-1) + SetForegroundWindow
  $allowOk = [Temp.W32CU]::AllowSetForegroundWindow(-1)
  $r1 = [Temp.W32CU]::SetForegroundWindow($hwnd)
  Write-Output "CU_DEBUG|tech=1_AllowSetFg|allowOk=$allowOk|setFgOk=$r1"

  # Tech#2: AttachThreadInput
  if (-not $r1) {
    $fgWin = [Temp.W32CU]::GetForegroundWindow()
    if ($fgWin -ne [IntPtr]::Zero -and $fgWin -ne $hwnd) {
      $fgPid = 0
      $fgTid = [Temp.W32CU]::GetWindowThreadProcessId($fgWin, [ref]$fgPid)
      $myTid = [Temp.W32CU]::GetCurrentThreadId()
      if ($fgTid -ne 0) {
        [Temp.W32CU]::AttachThreadInput($myTid, $fgTid, $true) | Out-Null
        Start-Sleep -Milliseconds 50
        $r2 = [Temp.W32CU]::SetForegroundWindow($hwnd)
        [Temp.W32CU]::AttachThreadInput($myTid, $fgTid, $false) | Out-Null
        Write-Output "CU_DEBUG|tech=2_AttachThread|fgTid=$fgTid|fgPid=$fgPid|ok=$r2"
      } else { $r2 = $false; Write-Output "CU_DEBUG|tech=2_AttachThread|skipped=noFgTid" }
    } else { $r2 = $false; Write-Output "CU_DEBUG|tech=2_AttachThread|skipped=noFgWin|fgWin=$fgWin" }
  } else { $r2 = $false }

  # Tech#3: BringWindowToTop visual fallback
  if (-not $r1 -and -not $r2) {
    [Temp.W32CU]::BringWindowToTop($hwnd) | Out-Null
    Write-Output "CU_DEBUG|tech=3_BringToTop_fallback"
  }

  $finalOk = $r1 -or $r2
  Write-Output "CU_DEBUG|phase=focus_done|hwnd=$hwnd|focusOk=$finalOk"
} else {
  Write-Output "CU_DEBUG|phase=focus_done|focusOk=false|reason=no_hwnd"
}

Write-Output 'ok'
`.trim();
}

/** Close/terminate an app by process name. */
export function psCloseApp(appName: string): string {
  if (!/^[A-Za-z0-9._+-]+(?: [A-Za-z0-9._+-]+)*$/.test(appName)) {
    throw new Error(`Invalid application name: '${appName}'`);
  }
  const procName = appName.replace(/\.exe$/i, '');
  return `taskkill /f /im '${procName}.exe' 2>&1; if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 128) { Write-Output 'ok' } else { Write-Error 'Failed to terminate ${procName}.exe' }`;
}

/** Wrap a PowerShell script for execution via powershell.exe (SSH or local). */
export function wrapPowerShell(script: string): string {
  const prepared = `$ProgressPreference = 'SilentlyContinue';\n${script}`;
  const encoded = Buffer.from(prepared, 'utf16le').toString('base64');
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}
