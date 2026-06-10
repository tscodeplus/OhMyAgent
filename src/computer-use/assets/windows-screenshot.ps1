# Windows Screenshot Script
# Called by LocalWindowsProvider via powershell.exe
# Outputs JSON with screenshot base64 and display info

param(
    [string]$OutputPath = "$env:TEMP\cua_screenshot.png"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$bounds = $screen.Bounds

# Capture screenshot
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size)
$bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()

# Convert to base64
$bytes = [System.IO.File]::ReadAllBytes($OutputPath)
$base64 = [System.Convert]::ToBase64String($bytes)

# Get active window info
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinAPI {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
"@

$hwnd = [WinAPI]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder(256)
[WinAPI]::GetWindowText($hwnd, $sb, 256) | Out-Null
$windowTitle = $sb.ToString()

$rect = New-Object RECT
[WinAPI]::GetWindowRect($hwnd, [ref]$rect) | Out-Null

# Get cursor position
$cursorPos = [System.Windows.Forms.Cursor]::Position

# Output JSON result
@{
    screenshotBase64 = $base64
    displayWidth = $bounds.Width
    displayHeight = $bounds.Height
    windowTitle = $windowTitle
    windowRect = @{ x = $rect.Left; y = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top }
    cursorX = $cursorPos.X
    cursorY = $cursorPos.Y
} | ConvertTo-Json -Compress
