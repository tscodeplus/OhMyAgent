// Shared PowerShell snippets for Windows desktop control.
// Used by both LocalWindowsProvider (WSL → powershell.exe) and
// SSHComputerUseProvider (SSH → Windows OpenSSH Server).

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

/** Wrap a PowerShell script for execution via powershell.exe (SSH or local). */
export function wrapPowerShell(script: string): string {
  const prepared = `$ProgressPreference = 'SilentlyContinue';\n${script}`;
  const encoded = Buffer.from(prepared, 'utf16le').toString('base64');
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}
