// src/computer-use/win-uia/win-uia-scripts.ts
//
// Protocol constants and PowerShell template generation for the resident
// Windows UIA (UI Automation) helper process.
//
// The helper is a long-lived powershell.exe process that reads one JSON
// command per line on stdin and writes one JSON response per line on stdout.
// It loads UIAutomationClient.dll / UIAutomationTypes.dll (bundled with
// Windows 10+) via Add-Type, so no C# toolchain or npm native dependency is
// needed. All interaction is control-level (InvokePattern / ValuePattern /
// ScrollPattern) — the user's mouse, keyboard, focus and clipboard are never
// touched. launch-app starts minimized and restores without activating;
// press-key's SendKeys fallback foregrounds only at low input activity
// (frequency-based guard; an idle wireless poke is filtered out) and returns
// the foreground. Explicit exceptions: `click-point`, `focus-app`.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/** Marker the server prints on stdout once ready; the client sends no
 *  commands before seeing it (avoids the encoding-setup/first-read race). */
export const UIA_HANDSHAKE_MARKER = 'CUAREADY 1';

/** Element ID prefix: `win-{hwnd}:{gen}:{index}`. */
export const UIA_ELEMENT_ID_PREFIX = 'win-';

/** Absolute path where the generated .ps1 is materialized at runtime. */
export const UIA_SERVER_SCRIPT_PATH = 'C:\\Windows\\Temp\\ohmyagent\\win-uia-server.ps1';

/** Default request timeout (ms). get-app-state uses a shorter one. */
export const UIA_COMMAND_TIMEOUT_MS = 30_000;
export const UIA_GET_STATE_TIMEOUT_MS = 15_000;

/**
 * launch-app budget: the server waits WaitHwnd 20s + AppX cold-start poll
 * 10s = 30s worst case, so the client must not cut it off with the default
 * 30s timeout (observed: killing the server mid-launch and failing the app
 * open on a slow notepad cold start).
 */
export const UIA_LAUNCH_TIMEOUT_MS = 60_000;

/** Idle (no commands) after which the server exits on its own. */
export const UIA_IDLE_EXIT_MS = 10 * 60 * 1000;

/** Element cache cap inside the server. */
export const UIA_MAX_ELEMENTS = 300;
/** Tree walk depth cap inside the server. */
export const UIA_MAX_DEPTH = 20;

// ---------------------------------------------------------------------------
// PowerShell server script template
// ---------------------------------------------------------------------------

/**
 * Generate the resident UIA server .ps1 body.
 *
 * Encoding rules (PS 5.1 traps):
 *   - Script body must stay pure ASCII; any literal must be escaped.
 *   - First lines set [Console]::OutputEncoding / InputEncoding to UTF-8
 *     without BOM (default OEM code page is GBK on Chinese systems).
 *   - All protocol output must go through [Console]::Out.WriteLine() —
 *     never plain Write-Output (pipeline re-encodes to the OEM page).
 * The materialized file must be written as UTF-8 **with BOM** so PS 5.1
 * parses it as UTF-8 (BOM-less UTF-8 is read as ANSI by default).
 *
 * Length is budgeted under ~30k chars (the resident script runs via
 * `powershell.exe -File`, so the 32KB cmdline limit does not apply to it).
 */
export function buildWinUiaServerScript(): string {
  return String.raw`
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;using System.Text;
public struct CuaRect { public int L; public int T; public int R; public int B; }
public struct CuaPoint { public int X; public int Y; }
public class CuaNative {
[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder t,int c);
[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out CuaRect r);
[DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr h,IntPtr hdc,uint f);
[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,[MarshalAs(UnmanagedType.LPWStr)]string l);
[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
[DllImport("kernel32.dll")]public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")]public static extern bool AttachThreadInput(uint a,uint b,bool f);
[DllImport("user32.dll")]public static extern bool EnumWindows(EnumWindowsProc cb,IntPtr l);
[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);
public delegate bool EnumWindowsProc(IntPtr h,IntPtr l);
public static IntPtr FirstWindow(IntPtr pid){IntPtr f=IntPtr.Zero;long best=0;EnumWindows(delegate(IntPtr h,IntPtr l){uint p;GetWindowThreadProcessId(h,out p);if(p==(uint)(int)pid&&IsWindowVisible(h)){CuaRect r=new CuaRect();GetWindowRect(h,out r);long a=(long)(r.R-r.L)*(r.B-r.T);if(a>best){best=a;f=h;}}return true;},IntPtr.Zero);return f;}
[DllImport("user32.dll")]public static extern bool EnableWindow(IntPtr h,bool e);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetClassName(IntPtr h,StringBuilder c,int n);
[DllImport("user32.dll")]public static extern IntPtr GetAncestor(IntPtr h,uint f);
[DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")]public static extern int GetWindowLongPtr(IntPtr h,int i);
[DllImport("user32.dll",EntryPoint="SetWindowLongPtrW")]public static extern int SetWindowLongPtr(IntPtr h,int i,int v);
[DllImport("user32.dll",EntryPoint="GetClassLongPtrW")]public static extern int GetClassLongPtr(IntPtr h,int i);
[DllImport("user32.dll")]public static extern IntPtr ChildWindowFromPointEx(IntPtr h,CuaPoint p,uint f);
[DllImport("user32.dll")]public static extern bool ClientToScreen(IntPtr h,ref CuaPoint p);
[DllImport("user32.dll")]public static extern bool ScreenToClient(IntPtr h,ref CuaPoint p);
[DllImport("user32.dll")]public static extern bool IsChild(IntPtr p,IntPtr c);
[DllImport("kernel32.dll")]public static extern IntPtr OpenProcess(uint a,bool i,uint p);
[DllImport("kernel32.dll")]public static extern bool CloseHandle(IntPtr h);
[DllImport("advapi32.dll")]public static extern bool OpenProcessToken(IntPtr h,uint a,out IntPtr t);
[DllImport("advapi32.dll")]public static extern bool GetTokenInformation(IntPtr t,uint c,byte[] b,uint n,out uint r);
public static int GetIntegrityLevel(int pid){IntPtr h=OpenProcess(0x1000,false,(uint)pid);if(h==IntPtr.Zero){return 0;}IntPtr t;if(!OpenProcessToken(h,0x0008,out t)){CloseHandle(h);return 0;}byte[] b=new byte[64];uint n=0;bool ok=GetTokenInformation(t,25,b,(uint)b.Length,out n);CloseHandle(t);CloseHandle(h);if(!ok||n<12){return 0;}int c=b[1];if(c<1){return 0;}int off=8+(c-1)*4;if(off+4>b.Length){return 0;}return System.BitConverter.ToInt32(b,off);}
public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
[DllImport("user32.dll")]public static extern bool GetLastInputInfo(ref LASTINPUTINFO li);
[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int c);
}'
$z=[IntPtr]::Zero
$N=[CuaNative]
$C=[Console]
$pi=[System.Windows.Automation.InvokePattern]::Pattern
$psi=[System.Windows.Automation.SelectionItemPattern]::Pattern
$pt=[System.Windows.Automation.TogglePattern]::Pattern
$pe=[System.Windows.Automation.ExpandCollapsePattern]::Pattern
$ps=[System.Windows.Automation.ScrollPattern]::Pattern
$pr=[System.Windows.Automation.RangeValuePattern]::Pattern
$pv=[System.Windows.Automation.ValuePattern]::Pattern
# SetFocusPattern/LegacyIAccessiblePattern classes are absent on some .NET
# Framework builds (observed on Win11 + PS 5.1) - focus via the
# AutomationElement.SetFocus() method, which exists everywhere.
$pl=$null; try { $pl=[System.Windows.Automation.LegacyIAccessiblePattern]::Pattern } catch {}
$si=[System.Windows.Automation.ScrollAmount]::SmallIncrement
$sd=[System.Windows.Automation.ScrollAmount]::SmallDecrement
$sn=[System.Windows.Automation.ScrollAmount]::NoAmount
$tw=[System.Windows.Automation.TreeWalker]::RawViewWalker
function FH($h) { [System.Windows.Automation.AutomationElement]::FromHandle($h) }
$png=[System.Drawing.Imaging.ImageFormat]::Png
$rx='\.exe$'
$cm=@{button='INV';hyperlink='INV';textbox='FOC';listitem='SEL';dataitem='SEL';tabitem='SEL';radiobutton='SEL';checkbox='TOG';combobox='EXP';treeitem='EXP';slider='RNG';scrollbar='RNG';document='FOC'}
function OJ($o) { $C::Out.WriteLine(($o|ConvertTo-Json -Compress -Depth 5)) }
function OE($id,$code,$msg) { OJ @{id=$id;ok=$false;error=@{code=$code;message=$msg}} }
function OK($id,$r) { OJ @{id=$id;ok=$true;result=$r} }
function Ttl($h) { $sb=[System.Text.StringBuilder]::new(512); $N::GetWindowText($h,$sb,512) > $null; $sb.ToString() }
function Rct($h) { $r=New-Object CuaRect; $N::GetWindowRect($h,[ref]$r) > $null; @{x=[int]$r.L;y=[int]$r.T;width=[int]($r.R-$r.L);height=[int]($r.B-$r.T)} }
function Dsp { $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; @{width=[int]$b.Width;height=[int]$b.Height} }
function Gr($b) { [System.Drawing.Graphics]::FromImage($b) }
function SM($h,$t) { $N::SendMessage($h,0x000C,$z,$t) -ne $z }
function HW($h) { if ($h -and [int64]$h -ne 0) { return [IntPtr][int64]$h }; $z }
function FTRY($el,$pat,$m) { try { $x=$el.GetCurrentPattern($pat); $x.$m(); $true } catch { $false } }
function ClassName($h) { $sb=[System.Text.StringBuilder]::new(256); $n=$N::GetClassName($h,$sb,256); if ($n -gt 0) { $sb.ToString() } else { '' } }
function SelfActHost($h) {
  if ([int64]$h -eq 0) { return $false }
  $c=ClassName $h
  switch ($c) {
    'ApplicationFrameWindow' { return $true }
    'WinUIDesktopWin32WindowClass' { return $true }
    'Windows.UI.Core.CoreWindow' { return $true }
    'Microsoft.UI.Content.DesktopChildSiteBridge' { return $true }
  }
  if ($c.StartsWith('Chrome_WidgetWin_') -or $c.StartsWith('CefBrowser')) { return $true }
  $pt=0; $N::GetWindowThreadProcessId($h,[ref]$pt) > $null
  if ($pt -ne 0) {
    $pn=(Get-Process -Id $pt -EA SilentlyContinue).ProcessName
    if ($pn) { $l=$pn.ToLowerInvariant(); if ($l -in @('notepad','calculatorapp','calc','applicationframehost','photos','systemsettings')) { return $true } }
  }
  return $false
}
# Foreground-steal bypass: UWP/XAML/WinUI and Chromium/Electron hosts call
# SetForegroundWindow(self) while handling UIA pattern calls. Disabling the
# top-level window for the duration suppresses the steal (UIA delivery uses
# the kernel accessibility channel, not the input queue EnableWindow gates).
function Shield($h,$body) {
  if (-not (SelfActHost $h)) { return (& $body) }
  $root=$N::GetAncestor($h,2); if ([int64]$root -eq 0) { $root=$h }
  $N::EnableWindow($root,$false) > $null
  try { return (& $body) } finally { $N::EnableWindow($root,$true) > $null }
}
# UIPI: PostMessage/SendMessage of input-class messages from a lower-
# integrity process to a higher-integrity window is silently dropped while
# the call still returns TRUE. Detect it before posting.
function UipiBlocked($h) {
  if ([int64]$h -eq 0) { return $false }
  $pt=0; $N::GetWindowThreadProcessId($h,[ref]$pt) > $null
  if ($pt -eq 0) { return $false }
  $m=[CuaNative]::GetIntegrityLevel([int]$PID); $t=[CuaNative]::GetIntegrityLevel([int]$pt)
  return ($m -gt 0 -and $t -gt $m)
}
# Count input events over $ms - a wireless idle poke (~1 per 2s) resets
# recency with no human at the keys; frequency, not recency, decides.
function InputEventsIn($ms) {
  # LASTINPUTINFO nests in the Add-Type class; PS 5.1 needs the 'CuaNative+...' string form and cbSize fixed at 8 (two uint).
  $li=New-Object 'CuaNative+LASTINPUTINFO'; $li.cbSize=8
  $N::GetLastInputInfo([ref]$li); $last=$li.dwTime; $n=0
  $sw=[Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $ms) {
    Start-Sleep -m 50
    $N::GetLastInputInfo([ref]$li)
    if ($li.dwTime -ne $last) { $n++; $last=$li.dwTime }
  }
  return $n
}
# Return the foreground to the window that held it before an agent-initiated
# activation. Only restores when the current foreground is exactly the window
# we activated - a third window means the user/OS switched, never yank it.
function RestoreFg($prev,$tgt) {
  if ([int64]$prev -eq 0 -or $prev -eq $tgt) { return }
  if ($N::GetForegroundWindow() -ne $tgt) { return }
  $fgPid=0; $fgTid=$N::GetWindowThreadProcessId($prev,[ref]$fgPid); $myTid=$N::GetCurrentThreadId()
  if ($fgTid -ne 0) { $N::AttachThreadInput($myTid,$fgTid,$true) > $null; $N::SetForegroundWindow($prev) > $null; $N::AttachThreadInput($myTid,$fgTid,$false) > $null }
}
# Background coordinate click via PostMessage: walk to the deepest child at
# the point (so the top-level frame does not activate itself), hold
# WS_EX_NOACTIVATE on the root for the burst, then restore the previous
# foreground window if the target stole it anyway.
function PostClick($hwnd,$x,$y,$count) {
  $cur=$hwnd
  for ($i=0; $i -lt 16; $i++) {
    $p=New-Object CuaPoint; $p.X=[int]$x; $p.Y=[int]$y
    $N::ScreenToClient($cur,[ref]$p) > $null
    $child=$N::ChildWindowFromPointEx($cur,$p,7)
    if ([int64]$child -eq 0 -or $child -eq $cur) { break }
    if (-not $N::IsChild($hwnd,$child)) { break }
    $cur=$child
  }
  $p2=New-Object CuaPoint; $p2.X=[int]$x; $p2.Y=[int]$y
  $N::ScreenToClient($cur,[ref]$p2) > $null
  $root=$N::GetAncestor($hwnd,2); if ([int64]$root -eq 0) { $root=$hwnd }
  $exStyle=[int]$N::GetWindowLongPtr($root,-20)
  $noAct=0x08000000
  $armed=(($exStyle -band $noAct) -eq 0)
  if ($armed) { $N::SetWindowLongPtr($root,-20,($exStyle -bor $noAct)) > $null }
  $prevFg=$N::GetForegroundWindow()
  $lparam=[IntPtr][int64](((($p2.Y -band 0xffff) -shl 16) -bor ($p2.X -band 0xffff)))
  $dbl=((($N::GetClassLongPtr($cur,-26) -band 0x8) -ne 0))
  for ($i=0; $i -lt $count; $i++) {
    $down=0x0201; $up=0x0202
    if ($i -ge 1 -and $dbl) { $down=0x0203 }
    $N::PostMessage($cur,0x0200,[IntPtr]::Zero,$lparam) > $null
    $N::PostMessage($cur,$down,[IntPtr]1,$lparam) > $null
    Start-Sleep -m 30
    $N::PostMessage($cur,$up,[IntPtr]::Zero,$lparam) > $null
    Start-Sleep -m 30
  }
  if ($armed) { $N::SetWindowLongPtr($root,-20,$exStyle) > $null }
  RestoreFg $prevFg $root
  return $true
}
function GE($req) {
  if (-not $req.elementId) { return $null }
  if ($req.elementId -match '^win-(-?\d+):(\d+):\d+$') { if ([int64]$matches[2] -ne $S.Gen) { return $null } }
  $S.Cache[$req.elementId]
}
# PS 5.1 trap: MainWindowHandle is $null for a main-window-less process
# (AppX activator) - keep $z, else $null -eq $z is false, the AppX poll is
# skipped and ShowWindow($null) throws.
function WaitHwnd($p,$ms) { $sw=[System.Diagnostics.Stopwatch]::StartNew(); $hwnd=$z; while ($sw.ElapsedMilliseconds -lt $ms -and $hwnd -eq $z -and -not $p.HasExited) { Start-Sleep -m 200; $p.Refresh(); $h=$p.MainWindowHandle; if ($h) { $hwnd=$h } }; $hwnd }
function Shot($h) {
  $r=New-Object CuaRect; $N::GetWindowRect($h,[ref]$r) > $null
  $w=$r.R-$r.L; $hh=$r.B-$r.T
  if ($w -le 0 -or $hh -le 0) { return '' }
  $bmp=[System.Drawing.Bitmap]::new($w,$hh); $g=Gr $bmp
  $hdc=$g.GetHdc(); $ok=$N::PrintWindow($h,$hdc,2); $g.ReleaseHdc($hdc)
  if (-not $ok) { $g2=Gr $bmp; $g2.CopyFromScreen($r.L,$r.T,0,0,[System.Drawing.Size]::new($w,$hh)); $g2.Dispose() }
  $ms=[System.IO.MemoryStream]::new(); $bmp.Save($ms,$png)
  $b64=[Convert]::ToBase64String($ms.ToArray()); $ms.Dispose(); $g.Dispose(); $bmp.Dispose()
  $b64
}
function Role($el) {
  $pn=$el.Current.ControlType.ProgrammaticName
  if ($pn -match 'ControlType\.(.+)$') { $pn=$matches[1] }
  $rm=@{Edit='textbox';Button='button';CheckBox='checkbox';ComboBox='combobox';ListItem='listitem';DataItem='dataitem';TabItem='tabitem';RadioButton='radiobutton';TreeItem='treeitem';Slider='slider';ScrollBar='scrollbar';Hyperlink='hyperlink';Window='window';Text='text'}
  if ($rm.ContainsKey($pn)) { return $rm[$pn] }
  $pn.ToLowerInvariant()
}
function Acts($el) {
  $a=@()
  foreach ($p in $el.GetSupportedPatterns()) {
    $n=$p.ProgrammaticName
    foreach ($t in @('Invoke','SelectionItem','Toggle','ExpandCollapse','Scroll','RangeValue','Value')) { if ($n.Contains($t)) { $a+=$t; break } }
  }
  $a
}
function Vk($k) {
  $m=@{Enter=0x0D;Tab=0x09;Escape=0x1B;BackSpace=0x08;Delete=0x2E;Home=0x24;End=0x23;Page_Up=0x21;Page_Down=0x22;Up=0x26;Down=0x28;Left=0x25;Right=0x27;Space=0x20}
  if ($m.ContainsKey($k)) { return $m[$k] }
  if ($k -match '^F([1-9]|1[0-2])$') { return 0x70+[int]$matches[1]-1 }
  if ($k) { return [int][char][char]::ToUpper($k[0]) }
  return 0
}
function SK($k) {
  $m=@{Enter='{ENTER}';Tab='{TAB}';Escape='{ESC}';BackSpace='{BACKSPACE}';Delete='{DELETE}';Home='{HOME}';End='{END}';Page_Up='{PGUP}';Page_Down='{PGDN}';Up='{UP}';Down='{DOWN}';Left='{LEFT}';Right='{RIGHT}';Space='{SPACE}'}
  if ($m.ContainsKey($k)) { return $m[$k] }
  if ($k -match '^F([1-9]|1[0-2])$') { return ('{'+$k+'}') }
  if ($k -match '^[A-Za-z0-9]$') { return $k }
  return $null
}
function Walk($el,$depth,[ref]$idx) {
  if ($depth -gt $S.MaxD -or $S.N -ge $S.MaxE) { $S.Trunc=$true; return }
  $cu=$el.Current
  try { if ($cu.IsOffscreen) { return } } catch { return }
  # Rect.Empty has Width/Height = -Infinity; [int] conversion throws, so
  # always guard before converting bounds.
  $rect=$cu.BoundingRectangle
  $bx=0;$by=0;$bw=0;$bh=0
  if ($null -ne $rect -and -not $rect.IsEmpty) { $bx=[int]$rect.X;$by=[int]$rect.Y;$bw=[int]$rect.Width;$bh=[int]$rect.Height }
  $area=$bw*$bh
  $name=$cu.Name; $patterns=$el.GetSupportedPatterns()
  if (-not (-not $patterns -and -not $name -and $area -eq 0)) {
    $eid="win-$($S.Hwnd):$($S.Gen):$($idx.Value)"; $idx.Value++
    if ($S.Cache.Count -lt $S.MaxE) { $S.Cache[$eid]=$el }
    $label=$name
    if (-not $label) { try { $label=$el.GetCurrentPattern($pl).Current.Name } catch { $label='' } }
    $S.N++; $S.List += @{elementId=$eid;role=(Role $el);label=$label;bounds=@{x=$bx;y=$by;width=$bw;height=$bh};enabled=$cu.IsEnabled;focused=$cu.HasKeyboardFocus;sensitive=$cu.IsPassword;actions=@(Acts $el)}
  }
  $c=0
  foreach ($child in $el.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)) { if ($c -ge 20) { $S.Trunc=$true; break }; Walk $child ($depth+1) $idx; $c++; if ($S.N -ge $S.MaxE) { $S.Trunc=$true; break } }
}
$S=@{Cache=@{};Hwnd=$z;Gen=0;N=0;Trunc=$false;List=@();MaxD=20;MaxE=300}

$C::Out.WriteLine('${UIA_HANDSHAKE_MARKER}')

# Blocking-read main loop. WSL interop trap: [Console]::In.Peek() returns -1
# forever once the pipe has been read empty (a false EOF), so a polling loop
# silently stops consuming commands after the first one. ReadLine() blocks
# reliably and returns $null only on a real EOF (client exit), which exits
# the server. Idle self-exit is driven by the client (kill after
# UIA_IDLE_EXIT_MS without requests).
while ($true) {
$line=$C::In.ReadLine()
if ($null -eq $line) { break }
$req=$null; try { $req=$line | ConvertFrom-Json } catch { continue }
$id=$req.id
try {
switch ($req.cmd) {
'ping' { OK $id @{pong=$true} }
'get-app-state' {
$hwnd=HW $req.hwnd
if ($hwnd -eq $z) { $hwnd=$N::GetForegroundWindow() }
$S.Hwnd=$hwnd; $S.Gen++; $S.Cache=@{}; $S.N=0; $S.Trunc=$false; $S.List=@(); $S.MaxD=20; $S.MaxE=300
if ($req.depth) { $S.MaxD=$req.depth }; if ($req.maxElements) { $S.MaxE=$req.maxElements }
Walk (FH $hwnd) 0 ([ref]0)
OK $id @{hwnd=[int64]$hwnd;gen=$S.Gen;windowTitle=(Ttl $hwnd);windowRect=(Rct $hwnd);display=(Dsp);elements=$S.List;screenshot=(Shot $hwnd);truncated=$S.Trunc}
}
'click-element' {
$el=GE $req
if (-not $el) { OE $id 'ELEMENT_STALE_TREE' 'Stale element' }
else {
# UWP/XAML/WinUI and Chromium/Electron hosts self-foreground while
# handling UIA pattern calls (Invoke/Expand/Toggle/Select); the shield
# disables the top-level window for the duration so the user's foreground
# is never stolen.
$ok=Shield $S.Hwnd {
$r=$false
switch ($cm[(Role $el)]) {
'FOC' { try { $el.SetFocus(); $r=$true } catch {}; if (-not $r) { $r=FTRY $el $pl 'Select' } }
'INV' { $r=FTRY $el $pi 'Invoke'; if (-not $r) { $r=FTRY $el $pl 'DoDefaultAction' } }
'SEL' { $r=FTRY $el $psi 'Select'; if (-not $r) { $r=FTRY $el $pi 'Invoke' } }
'TOG' { $r=FTRY $el $pt 'Toggle' }
'EXP' { $r=FTRY $el $pe 'Expand'; if (-not $r) { $r=FTRY $el $pi 'Invoke' } }
'RNG' { try { $rv=$el.GetCurrentPattern($pr); $sc=$rv.Current.SmallChange; if ($sc -le 0) { $sc=1 }; $rv.SetValue($rv.Current.Value+$sc); $r=$true } catch {} }
'DD' { $r=FTRY $el $pl 'DoDefaultAction' }
}
$r
}
if ($ok) { OK $id @{clicked=$true} } else { OE $id 'ELEMENT_NO_ACTION' 'No action' }
}
}
'type-text' {
$text=$req.text; $el=GE $req
if (-not $el -and $req.elementId) { OE $id 'ELEMENT_STALE_TREE' 'Stale element' }
else {
$ok=Shield $S.Hwnd {
$r=$false
if ($el) {
try { $el.GetCurrentPattern($pv).SetValue($text); $r=$true } catch {}
if (-not $r) { try { $el.GetCurrentPattern($pl).SetValue($text); $r=$true } catch {} }
if (-not $r) { try { $w=$el.Current.NativeWindowHandle; if ($w -ne 0 -and -not (UipiBlocked $w)) { $r=SM $w $text } } catch {} }
} else {
# No elementId: set the window's focused element. Never fall back to
# WM_SETTEXT on the top-level window - that only rewrites the window
# title and reports a false success (agent says done, nothing typed).
$fe=$null
foreach ($e in $S.Cache.Values) { try { if ($e.Current.HasKeyboardFocus) { $fe=$e; break } } catch {} }
if ($fe) {
try { $fe.GetCurrentPattern($pv).SetValue($text); $r=$true } catch {}
if (-not $r) { try { $fe.GetCurrentPattern($pl).SetValue($text); $r=$true } catch {} }
if (-not $r) { try { $w=$fe.Current.NativeWindowHandle; if ($w -ne 0 -and -not (UipiBlocked $w)) { $r=SM $w $text } } catch {} }
}
}
$r
}
if ($ok) { OK $id @{typed=$true} } else { OE $id 'ELEMENT_NO_ACTION' 'No text target' }
}
}
'press-key' {
$hwnd=HW $req.hwnd
if ($hwnd -eq $z) { OE $id 'SERVER_ERROR' 'hwnd required' }
else {
$vk=Vk $req.key
if ($vk -eq 0) { OE $id 'SERVER_ERROR' "Unknown key: $($req.key)" }
else {
# Editable-document detection: Win11 Notepad focuses an inner Pane whose
# native window is a XAML child (a real handle, but PostMessage to it is
# silently ignored - false success). Walk the focused element's subtree
# for the document child and apply Enter/Tab/BackSpace via ValuePattern
# append instead: no keyboard, no IME, no window structure assumptions.
$fe=$null
foreach ($e in $S.Cache.Values) { try { if ($e.Current.HasKeyboardFocus) { $fe=$e; break } } catch {} }
$w=$z
if ($fe) { try { $w=$fe.Current.NativeWindowHandle } catch { $w=$z } }
$doc=$null
try {
$dc=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Document)
$doc=(FH $hwnd).FindFirst([System.Windows.Automation.TreeScope]::Subtree,$dc)
} catch {}
if ($null -ne $doc) {
$vpOk=Shield $hwnd {
$r=$false
try {
$vp2=$doc.GetCurrentPattern($pv)
$cur2=$vp2.Current.Value
if ($cur2 -ne $null) {
switch ($req.key) {
'Enter' { $vp2.SetValue($cur2 + [char]10); $r=$true }
'Tab' { $vp2.SetValue($cur2 + [char]9); $r=$true }
'BackSpace' { if ($cur2.Length -gt 0) { $vp2.SetValue($cur2.Substring(0,$cur2.Length-1)); $r=$true } }
}
}
} catch {}
$r
}
if ($vpOk) { OK $id @{key=$req.key} }
else {
# 2) Modern apps (Chrome/Edge - UIA elements have no native hwnd) or
#    keys without text semantics: foreground the target and inject a
#    real key (same trade-off as Linux xdotool).
$sk=SK $req.key
if (-not $sk) { OE $id 'SERVER_ERROR' "Unsupported key: $($req.key)" }
else {
# Real key injection needs the foreground - but only when the target is not
# already there. Refuse at >2 input events/s (userActiveMs 0 disables).
$prevFg=$N::GetForegroundWindow()
if ($prevFg -ne $hwnd) {
$th=$req.userActiveMs; if ($null -eq $th -or $th -lt 0) { $th=3000 }
if ($th -gt 0 -and (InputEventsIn 1000) -gt 2) { OE $id 'USER_ACTIVE' 'User is actively using the computer; retry later'; break }
}
$N::SetForegroundWindow($hwnd) > $null
$fg=$N::GetForegroundWindow()
if ($fg -ne $hwnd) {
$fgPid=0; $fgTid=$N::GetWindowThreadProcessId($fg,[ref]$fgPid); $myTid=$N::GetCurrentThreadId()
if ($fgTid -ne 0) { $N::AttachThreadInput($myTid,$fgTid,$true) > $null; $N::SetForegroundWindow($hwnd) > $null; $N::AttachThreadInput($myTid,$fgTid,$false) > $null }
}
$fg=$N::GetForegroundWindow()
if ($fg -ne $hwnd) { OE $id 'SERVER_ERROR' 'Could not foreground target window' }
else {
try { $wshell=New-Object -ComObject WScript.Shell; $wshell.SendKeys($sk) } catch { OE $id 'SERVER_ERROR' 'SendKeys failed'; break }
# SendKeys is async (SendInput enqueues and returns): let the key reach
# the target before handing the foreground back to the user's window.
Start-Sleep -m 200
RestoreFg $prevFg $hwnd
OK $id @{key=$req.key}
}
}
}
}
elseif ([int64]$w -ne 0 -and [int64]$w -ne [int64]$hwnd) {
# 1) Non-intrusive: PostMessage to the focused element's native window
#    (Win32 controls like legacy Notepad's edit) - works without
#    foreground. Skip when the element reports the top-level window's own
#    hwnd (UWP/XAML Islands like Win11 Notepad): posting to the top-level
#    window is a no-op there, so fall through to real key injection.
if (UipiBlocked $w) { OE $id 'UIPI_BLOCKED' 'Target window is elevated; input injection blocked by UIPI from this process' }
else {
$N::PostMessage($w,0x0100,[IntPtr]$vk,$z) > $null
$N::PostMessage($w,0x0101,[IntPtr]$vk,$z) > $null
OK $id @{key=$req.key}
}
}
else {
# 2) Modern apps (Chrome/Edge - UIA elements have no native hwnd) or
#    keys without text semantics: foreground the target and inject a
#    real key (same trade-off as Linux xdotool).
$sk=SK $req.key
if (-not $sk) { OE $id 'SERVER_ERROR' "Unsupported key: $($req.key)" }
else {
# Real key injection needs the foreground - but only when the target is not
# already there. Refuse at >2 input events/s (userActiveMs 0 disables).
$prevFg=$N::GetForegroundWindow()
if ($prevFg -ne $hwnd) {
$th=$req.userActiveMs; if ($null -eq $th -or $th -lt 0) { $th=3000 }
if ($th -gt 0 -and (InputEventsIn 1000) -gt 2) { OE $id 'USER_ACTIVE' 'User is actively using the computer; retry later'; break }
}
$N::SetForegroundWindow($hwnd) > $null
$fg=$N::GetForegroundWindow()
if ($fg -ne $hwnd) {
$fgPid=0; $fgTid=$N::GetWindowThreadProcessId($fg,[ref]$fgPid); $myTid=$N::GetCurrentThreadId()
if ($fgTid -ne 0) { $N::AttachThreadInput($myTid,$fgTid,$true) > $null; $N::SetForegroundWindow($hwnd) > $null; $N::AttachThreadInput($myTid,$fgTid,$false) > $null }
}
$fg=$N::GetForegroundWindow()
if ($fg -ne $hwnd) { OE $id 'SERVER_ERROR' 'Could not foreground target window' }
else {
try { $wshell=New-Object -ComObject WScript.Shell; $wshell.SendKeys($sk) } catch { OE $id 'SERVER_ERROR' 'SendKeys failed'; break }
# SendKeys is async (SendInput enqueues and returns): let the key reach
# the target before handing the foreground back to the user's window.
Start-Sleep -m 200
RestoreFg $prevFg $hwnd
OK $id @{key=$req.key}
}
}
}
}
}
}
'scroll' {
$el=GE $req
if ($req.elementId -and -not $el) { OE $id 'ELEMENT_STALE_TREE' 'Stale element' }
else {
if (-not $el) { $hwnd=$S.Hwnd; if ($hwnd -eq $z) { $hwnd=$N::GetForegroundWindow() }; try { $el=FH $hwnd } catch {} }
$sp=$null; $cur=$el
while ($null -ne $cur -and $null -eq $sp) { try { $sp=$cur.GetCurrentPattern($ps) } catch { $sp=$null }; if ($null -eq $sp) { $cur=$tw.GetParent($cur) } }
if (-not $sp) { OE $id 'ELEMENT_NO_ACTION' 'No scrollable' }
else {
$rep=$req.amount; if ($rep -lt 1) { $rep=1 }
for ($i=0; $i -lt $rep; $i++) {
switch ($req.direction) {
'up' { $sp.Scroll($sd,$sn) } 'left' { $sp.Scroll($sn,$sd) }
'right' { $sp.Scroll($sn,$si) } default { $sp.Scroll($si,$sn) }
}
}
OK $id @{scrolled=$true}
}
}
}
'screenshot' {
if ($req.hwnd -and [int64]$req.hwnd -ne 0) { OK $id @{screenshot=(Shot (HW $req.hwnd))} }
else {
$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp=[System.Drawing.Bitmap]::new($b.Width,$b.Height); $g=Gr $bmp; $g.CopyFromScreen($b.X,$b.Y,0,0,$b.Size)
$ms=[System.IO.MemoryStream]::new(); $bmp.Save($ms,$png); $b64=[Convert]::ToBase64String($ms.ToArray()); $ms.Dispose(); $g.Dispose(); $bmp.Dispose()
OK $id @{screenshot=$b64}
}
}
'get-foreground' {
$hwnd=$N::GetForegroundWindow()
OK $id @{hwnd=[int64]$hwnd;title=(Ttl $hwnd);windowRect=(Rct $hwnd)}
}
'list-apps' {
$lines=@(Get-Process | ? { $_.MainWindowTitle -ne '' } | % { "APP|$($_.ProcessName)|$($_.Id)|$($_.MainWindowHandle)|$($_.MainWindowTitle)" })
OK $id @{apps=$lines}
}
'launch-app' {
$name=$req.name
if ($name -notmatch '^[A-Za-z0-9._+-]+(?: [A-Za-z0-9._+-]+)*$') { OE $id 'SERVER_ERROR' 'Bad app name' }
else {
$appExe=$name; if ($appExe -notmatch $rx) { $appExe="$name.exe" }
# Visible instance: reuse it WITHOUT Start-Process - Start-Process on an
# already-running app activates its window and steals the foreground, so a
# visible instance is NEVER launched again.
# Win11 notepad is single-process/multi-window: MainWindowHandle is
# unreliable there (often 0 or an arbitrary window), and the OS
# background-preloads extra windowless notepad.exe processes. Iterate all
# processes and keep one that actually has a visible window (EnumWindows by
# PID). If NONE does - not even one - those are preloaded windowless
# instances (never "running apps"): launch a fresh one, or the caller gets
# hwnd=0 and reads the wrong (foreground) window forever.
$all=@(Get-Process -Name ($appExe -replace $rx,'') -EA SilentlyContinue)
$p=$null; $hwnd=$z
foreach ($pr in $all) { $h=$N::FirstWindow([IntPtr]$pr.Id); if ($h -ne $z) { $p=$pr; $hwnd=[int64]$h } }
if (-not $p) { $p=@($all | select -Last 1)[0]; if ($p) { $h=$p.MainWindowHandle; if ($h) { $hwnd=[int64]$h } } }
if ($hwnd -eq $z) {
# Fresh launch: start minimized so the new window can never become the
# foreground (a minimized window cannot take the foreground), then restore
# it to normal size without activating (SW_SHOWNOACTIVATE) once the handle
# is known. AppX hosts ignore the minimized startup state and activate
# anyway - RestoreFg hands the foreground back in that case.
$prevFg=$N::GetForegroundWindow()
$p=Start-Process $appExe -WindowStyle Minimized -PassThru
$hwnd=WaitHwnd $p 20000
if ($hwnd -eq $z) {
  # AppX: Start-Process returns an activator that exits; poll for the real window.
  $sw=[System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt 10000 -and $hwnd -eq $z) {
    Start-Sleep -m 500
    $fp=Get-Process -Name ($appExe -replace $rx,'') -EA SilentlyContinue | select -Last 1
    if ($fp) { $h=$N::FirstWindow([IntPtr]$fp.Id); if ($h -ne $z) { $hwnd=[int64]$h } }
  }
}
if ($hwnd -ne $z) {
  # SW_SHOWNOACTIVATE=4: restore from minimized without activating. Call
  # twice - the first ShowWindow on a window launched with
  # STARTF_USESHOWWINDOW is overridden by the startup show state.
  $N::ShowWindow([IntPtr]$hwnd,4) > $null
  $N::ShowWindow([IntPtr]$hwnd,4) > $null
  Start-Sleep -m 250
  RestoreFg $prevFg $hwnd
}
}
OK $id @{pid=$p.Id;hwnd=[int64]$hwnd}
}
}
'focus-app' {
$name=$req.name
if ($name -notmatch '^[A-Za-z0-9._+-]+(?: [A-Za-z0-9._+-]+)*$') { OE $id 'SERVER_ERROR' 'Bad app name' }
else {
$procs=@(Get-Process -Name ($name -replace $rx,'') -EA SilentlyContinue)
if ($procs.Count -eq 0) { OE $id 'TARGET_NOT_FOUND' "Not found: $name" }
else {
$p=$procs[0]; $hwnd=WaitHwnd $p 10000
if ($hwnd -ne $z) {
$N::SetForegroundWindow($hwnd) > $null
$fg=$N::GetForegroundWindow()
if ($fg -ne $hwnd) {
$fgPid=0; $fgTid=$N::GetWindowThreadProcessId($fg,[ref]$fgPid); $myTid=$N::GetCurrentThreadId()
if ($fgTid -ne 0) { $N::AttachThreadInput($myTid,$fgTid,$true) > $null; $N::SetForegroundWindow($hwnd) > $null; $N::AttachThreadInput($myTid,$fgTid,$false) > $null }
}
}
OK $id @{hwnd=[int64]$hwnd;title=(Ttl $hwnd)}
}
}
}
'close-app' {
$procName=$req.name -replace $rx,''
taskkill /f /im "$procName.exe" >$null 2>$null
OK $id @{closed=$true}
}
'click-point' {
if ($null -eq $req.x -or $null -eq $req.y) { OE $id 'SERVER_ERROR' 'x and y required' }
else {
$hwnd=HW $req.hwnd
if ($hwnd -eq $z) { $hwnd=$N::GetForegroundWindow() }
if ($hwnd -eq $z) { OE $id 'SERVER_ERROR' 'No target window for click-point' }
elseif (UipiBlocked $hwnd) { OE $id 'UIPI_BLOCKED' 'Target window is elevated; input injection blocked by UIPI from this process' }
else { PostClick $hwnd $req.x $req.y 1 > $null; OK $id @{clicked=$true} }
}
}
'double-click' {
if ($null -eq $req.x -or $null -eq $req.y) { OE $id 'SERVER_ERROR' 'x and y required' }
else {
$hwnd=HW $req.hwnd
if ($hwnd -eq $z) { $hwnd=$N::GetForegroundWindow() }
if ($hwnd -eq $z) { OE $id 'SERVER_ERROR' 'No target window for double-click' }
elseif (UipiBlocked $hwnd) { OE $id 'UIPI_BLOCKED' 'Target window is elevated; input injection blocked by UIPI from this process' }
else { PostClick $hwnd $req.x $req.y 2 > $null; OK $id @{clicked=$true} }
}
}
'quit' { OK $id @{bye=$true}; exit 0 }
default { OE $id 'UNKNOWN_COMMAND' "Unknown cmd: $($req.cmd)" }
}
} catch { OE $id 'SERVER_ERROR' $_.Exception.Message }
}
`.trim() + '\n';
}

/**
 * Materialize the server script as UTF-8 **with BOM**. PS 5.1 reads
 * BOM-less UTF-8 as the ANSI code page, which garbles non-ASCII content on
 * CJK systems; the BOM forces UTF-8 parsing.
 *
 * `filePath` must be writable by the current process — WSL callers should
 * pass the /mnt/... equivalent of the Windows path.
 */
export function writeUiaServerScript(
  filePath: string,
  script: string = buildWinUiaServerScript(),
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(script, 'utf8')]),
  );
}

// ---------------------------------------------------------------------------
// Stateless one-shot script (SSH win32 branch)
// ---------------------------------------------------------------------------
//
// The SSH win32 branch cannot keep a resident helper process on the remote
// host, so it reuses the same UIA template body in *stateless* form: every
// action spawns powershell.exe once (after a small file-materialization
// step), executes exactly ONE command and prints a single JSON line
// `{"ok":true,"result":...}` / `{"ok":false,"error":{"code","message"}}`
// before exiting. There is no handshake marker, no command loop and no
// element cache — elementIds (`win-{hwnd}:{gen}:{index}`) are resolved by
// re-walking the tree from the root element by DFS index (same semantics as
// the Linux AT-SPI path), returning ELEMENT_STALE_TREE when the index no
// longer resolves.
//
// Execution is two-stage (simple and reliable, chosen over a single
// `-EncodedCommand`):
//   1. `buildWinUiaOnceWriteCommands()` — materialize the (pure ASCII)
//      script at `$env:TEMP\ohmyagent\win-uia-once.ps1`. The body is
//      base64-encoded and written in chunks, because the remote OpenSSH
//      shell (cmd.exe) truncates command lines at ~8191 chars and a
//      `-EncodedCommand` base64 (UTF-16LE, 2x) of an 8-12KB script would
//      blow that limit.
//   2. `buildWinUiaOnceRunCommand()` — execute the file via `-File`.
// The fixed path makes repeated actions cheap (no discovery needed).

/** Commands supported by the one-shot script. */
export const WIN_UIA_ONCE_COMMANDS = [
  'get-app-state',
  'click-element',
  'type-text',
  'press-key',
  'scroll',
  'click-point',
  'double-click',
] as const;
export type WinUiaOnceCommand = (typeof WIN_UIA_ONCE_COMMANDS)[number];

/** Payload for a one-shot UIA command. */
export interface WinUiaOncePayload {
  /** Decimal window handle (may be negative on 64-bit); 0/absent = foreground window. */
  hwnd?: number | string;
  /** `win-{hwnd}:{gen}:{index}` element id (DFS index into the kept tree). */
  elementId?: string;
  /** Text to set on the target element (type-text). */
  text?: string;
  /** Key name for press-key (see the Vk() table). */
  key?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  /** 0 = never reject the SendKeys fallback; >0 enables the guard (it counts
   *  input events over a 1s window and rejects at >2/s - a human at the keys,
   *  not a wireless idle poke). */
  userActiveMs?: number;
  x?: number;
  y?: number;
  depth?: number;
  maxElements?: number;
  screenshot?: boolean;
}

/** Fixed path (PS expression, expanded on the remote host) of the one-shot script. */
export const UIA_ONCE_SCRIPT_PATH = '$env:TEMP\\ohmyagent\\win-uia-once.ps1';

/** Base64 chunk size per write command — leaves ample headroom under the
 *  cmd.exe ~8191-char command-line limit. */
const UIA_ONCE_WRITE_CHUNK = 6000;

/**
 * Stage-1 commands that materialize `script` on the remote Windows host at
 * `$env:TEMP\ohmyagent\win-uia-once.ps1`. The (pure ASCII) body is
 * base64-encoded so it survives the cmd.exe → powershell.exe boundary, and
 * written in chunks: the first command overwrites with a UTF-8 BOM, later
 * chunks append (the BOM stays in place). Each command line stays far below
 * the cmd.exe limit regardless of the script size.
 */
export function buildWinUiaOnceWriteCommands(script: string): string[] {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const commands: string[] = [];
  for (let i = 0; i < b64.length; i += UIA_ONCE_WRITE_CHUNK) {
    const chunk = b64.slice(i, i + UIA_ONCE_WRITE_CHUNK);
    if (i === 0) {
      commands.push(
        `powershell.exe -NoProfile -NonInteractive -Command "New-Item -ItemType Directory -Force (($env:TEMP)+'\\ohmyagent') | Out-Null; [System.IO.File]::WriteAllText(($env:TEMP)+'\\ohmyagent\\win-uia-once.ps1',[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${chunk}')),[System.Text.UTF8Encoding]::new($true))"`,
      );
    } else {
      commands.push(
        `powershell.exe -NoProfile -NonInteractive -Command "[System.IO.File]::AppendAllText(($env:TEMP)+'\\ohmyagent\\win-uia-once.ps1',[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${chunk}')))"`,
      );
    }
  }
  return commands;
}

/** Stage-2 command: run the materialized one-shot script and print its single JSON line. */
export function buildWinUiaOnceRunCommand(): string {
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& (($env:TEMP)+'\\ohmyagent\\win-uia-once.ps1')"`;
}

/**
 * Generate the stateless one-shot PowerShell script for a single UIA
 * command. Same encoding rules as the resident server template (pure ASCII,
 * UTF-8 console encodings, protocol output only via [Console]::Out).
 *
 * The payload is embedded as a hashtable literal — every value is
 * validated/sanitized by this function (numbers only for hwnd/coords,
 * base64 for text), so the script is injection-safe.
 */
export function buildWinUiaOnceScript(
  cmd: WinUiaOnceCommand,
  payload: WinUiaOncePayload = {},
): string {
  if (!(WIN_UIA_ONCE_COMMANDS as readonly string[]).includes(cmd)) {
    throw new Error(`Unsupported win-uia once command: '${cmd}'`);
  }
  const reqLiteral = buildOnceRequestLiteral(cmd, payload);
  return `${WIN_UIA_ONCE_CORE}
$MaxD=20; $MaxE=300
$R=${reqLiteral}
try {
switch ($R.cmd) {
${WIN_UIA_ONCE_BRANCHES[cmd]}
default { OE 'UNKNOWN_COMMAND' ("Unknown cmd: " + $R.cmd) }
}
} catch { OE 'SERVER_ERROR' $_.Exception.Message }
`;
}

/** Build the `$R=@{...}` payload literal (all values sanitized). */
function buildOnceRequestLiteral(cmd: WinUiaOnceCommand, payload: WinUiaOncePayload): string {
  const num = (name: string, value: unknown): string => {
    if (value === undefined) return `${name}=0`;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new Error(`Invalid win-uia once payload ${name}: '${String(value)}'`);
    }
    return `${name}=${n}`;
  };
  const word = (name: string, value: unknown, re: RegExp): string => {
    if (value === undefined) return `${name}=''`;
    const s = String(value);
    if (!re.test(s)) throw new Error(`Invalid win-uia once payload ${name}: '${s}'`);
    return `${name}='${s}'`;
  };
  const parts: string[] = [`cmd='${cmd}'`];
  const hwnd = payload.hwnd ?? 0;
  parts.push(num('hwnd', hwnd));
  if (payload.elementId !== undefined) {
    if (!/^win--?\d+:\d+:\d+$/.test(payload.elementId)) {
      throw new Error(`Invalid win-uia elementId: '${payload.elementId}'`);
    }
    parts.push(`elementId='${payload.elementId}'`);
  }
  if (payload.text !== undefined) {
    parts.push(`textB64='${Buffer.from(payload.text, 'utf8').toString('base64')}'`);
  }
  if (payload.key !== undefined) {
    parts.push(word('key', payload.key, /^[A-Za-z0-9_.]+$/));
  }
  if (payload.direction !== undefined) {
    if (!['up', 'down', 'left', 'right'].includes(payload.direction)) {
      throw new Error(`Invalid win-uia direction: '${payload.direction}'`);
    }
    parts.push(`direction='${payload.direction}'`);
  }
  if (payload.amount !== undefined) parts.push(num('amount', payload.amount));
  // Only emitted when explicitly provided - num() would force `=0` on
  // undefined and silently disable the user-activity guard.
  if (payload.userActiveMs !== undefined) parts.push(num('userActiveMs', payload.userActiveMs));
  if (payload.x !== undefined) parts.push(num('x', payload.x));
  if (payload.y !== undefined) parts.push(num('y', payload.y));
  if (payload.depth !== undefined) parts.push(num('depth', payload.depth));
  if (payload.maxElements !== undefined) parts.push(num('maxElements', payload.maxElements));
  parts.push(`screenshot=${payload.screenshot ? '$true' : '$false'}`);
  return `@{${parts.join(';')}}`;
}

// ---------------------------------------------------------------------------
// One-shot template body
// ---------------------------------------------------------------------------

/**
 * Common preamble + helpers for the one-shot script: console encodings,
 * Add-Type (UIA + native Win32), pattern variables, element walking /
 * DFS-index location and the small OJ/OE/OK protocol helpers. Mirrors the
 * resident server template's helpers (no handshake, no loop, no cache).
 */
const WIN_UIA_ONCE_CORE = String.raw`
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;using System.Text;
public struct CuaRect { public int L; public int T; public int R; public int B; }
public struct CuaPoint { public int X; public int Y; }
public class CuaNative {
[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder t,int c);
[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out CuaRect r);
[DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr h,IntPtr hdc,uint f);
[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,[MarshalAs(UnmanagedType.LPWStr)]string l);
[DllImport("user32.dll")]public static extern bool EnumWindows(EnumWindowsProc cb,IntPtr l);
[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("kernel32.dll")]public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")]public static extern bool AttachThreadInput(uint a,uint b,bool f);
[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);
public delegate bool EnumWindowsProc(IntPtr h,IntPtr l);
public static IntPtr FirstWindow(IntPtr pid){IntPtr f=IntPtr.Zero;long best=0;EnumWindows(delegate(IntPtr h,IntPtr l){uint p;GetWindowThreadProcessId(h,out p);if(p==(uint)(int)pid&&IsWindowVisible(h)){CuaRect r=new CuaRect();GetWindowRect(h,out r);long a=(long)(r.R-r.L)*(r.B-r.T);if(a>best){best=a;f=h;}}return true;},IntPtr.Zero);return f;}
[DllImport("user32.dll")]public static extern bool EnableWindow(IntPtr h,bool e);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetClassName(IntPtr h,StringBuilder c,int n);
[DllImport("user32.dll")]public static extern IntPtr GetAncestor(IntPtr h,uint f);
[DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")]public static extern int GetWindowLongPtr(IntPtr h,int i);
[DllImport("user32.dll",EntryPoint="SetWindowLongPtrW")]public static extern int SetWindowLongPtr(IntPtr h,int i,int v);
[DllImport("user32.dll",EntryPoint="GetClassLongPtrW")]public static extern int GetClassLongPtr(IntPtr h,int i);
[DllImport("user32.dll")]public static extern IntPtr ChildWindowFromPointEx(IntPtr h,CuaPoint p,uint f);
[DllImport("user32.dll")]public static extern bool ClientToScreen(IntPtr h,ref CuaPoint p);
[DllImport("user32.dll")]public static extern bool ScreenToClient(IntPtr h,ref CuaPoint p);
[DllImport("user32.dll")]public static extern bool IsChild(IntPtr p,IntPtr c);
[DllImport("kernel32.dll")]public static extern IntPtr OpenProcess(uint a,bool i,uint p);
[DllImport("kernel32.dll")]public static extern bool CloseHandle(IntPtr h);
[DllImport("advapi32.dll")]public static extern bool OpenProcessToken(IntPtr h,uint a,out IntPtr t);
[DllImport("advapi32.dll")]public static extern bool GetTokenInformation(IntPtr t,uint c,byte[] b,uint n,out uint r);
public static int GetIntegrityLevel(int pid){IntPtr h=OpenProcess(0x1000,false,(uint)pid);if(h==IntPtr.Zero){return 0;}IntPtr t;if(!OpenProcessToken(h,0x0008,out t)){CloseHandle(h);return 0;}byte[] b=new byte[64];uint n=0;bool ok=GetTokenInformation(t,25,b,(uint)b.Length,out n);CloseHandle(t);CloseHandle(h);if(!ok||n<12){return 0;}int c=b[1];if(c<1){return 0;}int off=8+(c-1)*4;if(off+4>b.Length){return 0;}return System.BitConverter.ToInt32(b,off);}
public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
[DllImport("user32.dll")]public static extern bool GetLastInputInfo(ref LASTINPUTINFO li);
[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int c);
}'
$z=[IntPtr]::Zero
$N=[CuaNative]
$C=[Console]
$pi=[System.Windows.Automation.InvokePattern]::Pattern
$psi=[System.Windows.Automation.SelectionItemPattern]::Pattern
$pt=[System.Windows.Automation.TogglePattern]::Pattern
$pe=[System.Windows.Automation.ExpandCollapsePattern]::Pattern
$ps=[System.Windows.Automation.ScrollPattern]::Pattern
$pr=[System.Windows.Automation.RangeValuePattern]::Pattern
$pv=[System.Windows.Automation.ValuePattern]::Pattern
# SetFocusPattern/LegacyIAccessiblePattern classes are absent on some .NET
# Framework builds (observed on Win11 + PS 5.1) - focus via the
# AutomationElement.SetFocus() method, which exists everywhere.
$pl=$null; try { $pl=[System.Windows.Automation.LegacyIAccessiblePattern]::Pattern } catch {}
$si=[System.Windows.Automation.ScrollAmount]::SmallIncrement
$sd=[System.Windows.Automation.ScrollAmount]::SmallDecrement
$sn=[System.Windows.Automation.ScrollAmount]::NoAmount
$tw=[System.Windows.Automation.TreeWalker]::RawViewWalker
function FH($h) { [System.Windows.Automation.AutomationElement]::FromHandle($h) }
$png=[System.Drawing.Imaging.ImageFormat]::Png
$cm=@{button='INV';hyperlink='INV';textbox='FOC';listitem='SEL';dataitem='SEL';tabitem='SEL';radiobutton='SEL';checkbox='TOG';combobox='EXP';treeitem='EXP';slider='RNG';scrollbar='RNG';document='FOC'}
function OJ($o) { $C::Out.WriteLine(($o|ConvertTo-Json -Compress -Depth 5)) }
function OE($code,$msg) { OJ @{ok=$false;error=@{code=$code;message=$msg}} }
function OK($r) { OJ @{ok=$true;result=$r} }
function Ttl($h) { $sb=[System.Text.StringBuilder]::new(512); $N::GetWindowText($h,$sb,512) > $null; $sb.ToString() }
function Rct($h) { $r=New-Object CuaRect; $N::GetWindowRect($h,[ref]$r) > $null; @{x=[int]$r.L;y=[int]$r.T;width=[int]($r.R-$r.L);height=[int]($r.B-$r.T)} }
function Dsp { $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; @{width=[int]$b.Width;height=[int]$b.Height} }
function Gr($b) { [System.Drawing.Graphics]::FromImage($b) }
function SM($h,$t) { $N::SendMessage($h,0x000C,$z,$t) -ne $z }
function HW($h) { if ($h -and [int64]$h -ne 0) { return [IntPtr][int64]$h }; $z }
function FTRY($el,$pat,$m) { try { $x=$el.GetCurrentPattern($pat); $x.$m(); $true } catch { $false } }
function ClassName($h) { $sb=[System.Text.StringBuilder]::new(256); $n=$N::GetClassName($h,$sb,256); if ($n -gt 0) { $sb.ToString() } else { '' } }
function SelfActHost($h) {
  if ([int64]$h -eq 0) { return $false }
  $c=ClassName $h
  switch ($c) {
    'ApplicationFrameWindow' { return $true }
    'WinUIDesktopWin32WindowClass' { return $true }
    'Windows.UI.Core.CoreWindow' { return $true }
    'Microsoft.UI.Content.DesktopChildSiteBridge' { return $true }
  }
  if ($c.StartsWith('Chrome_WidgetWin_') -or $c.StartsWith('CefBrowser')) { return $true }
  $pt=0; $N::GetWindowThreadProcessId($h,[ref]$pt) > $null
  if ($pt -ne 0) {
    $pn=(Get-Process -Id $pt -EA SilentlyContinue).ProcessName
    if ($pn) { $l=$pn.ToLowerInvariant(); if ($l -in @('notepad','calculatorapp','calc','applicationframehost','photos','systemsettings')) { return $true } }
  }
  return $false
}
# Foreground-steal bypass: UWP/XAML/WinUI and Chromium/Electron hosts call
# SetForegroundWindow(self) while handling UIA pattern calls. Disabling the
# top-level window for the duration suppresses the steal (UIA delivery uses
# the kernel accessibility channel, not the input queue EnableWindow gates).
function Shield($h,$body) {
  if (-not (SelfActHost $h)) { return (& $body) }
  $root=$N::GetAncestor($h,2); if ([int64]$root -eq 0) { $root=$h }
  $N::EnableWindow($root,$false) > $null
  try { return (& $body) } finally { $N::EnableWindow($root,$true) > $null }
}
# UIPI: PostMessage/SendMessage of input-class messages from a lower-
# integrity process to a higher-integrity window is silently dropped while
# the call still returns TRUE. Detect it before posting.
function UipiBlocked($h) {
  if ([int64]$h -eq 0) { return $false }
  $pt=0; $N::GetWindowThreadProcessId($h,[ref]$pt) > $null
  if ($pt -eq 0) { return $false }
  $m=[CuaNative]::GetIntegrityLevel([int]$PID); $t=[CuaNative]::GetIntegrityLevel([int]$pt)
  return ($m -gt 0 -and $t -gt $m)
}
# Count input events over $ms - a wireless idle poke (~1 per 2s) resets
# recency with no human at the keys; frequency, not recency, decides.
function InputEventsIn($ms) {
  # LASTINPUTINFO nests in the Add-Type class; PS 5.1 needs the 'CuaNative+...' string form and cbSize fixed at 8 (two uint).
  $li=New-Object 'CuaNative+LASTINPUTINFO'; $li.cbSize=8
  $N::GetLastInputInfo([ref]$li); $last=$li.dwTime; $n=0
  $sw=[Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $ms) {
    Start-Sleep -m 50
    $N::GetLastInputInfo([ref]$li)
    if ($li.dwTime -ne $last) { $n++; $last=$li.dwTime }
  }
  return $n
}
# Return the foreground to the window that held it before an agent-initiated
# activation. Only restores when the current foreground is exactly the window
# we activated - a third window means the user/OS switched, never yank it.
function RestoreFg($prev,$tgt) {
  if ([int64]$prev -eq 0 -or $prev -eq $tgt) { return }
  if ($N::GetForegroundWindow() -ne $tgt) { return }
  $fgPid=0; $fgTid=$N::GetWindowThreadProcessId($prev,[ref]$fgPid); $myTid=$N::GetCurrentThreadId()
  if ($fgTid -ne 0) { $N::AttachThreadInput($myTid,$fgTid,$true) > $null; $N::SetForegroundWindow($prev) > $null; $N::AttachThreadInput($myTid,$fgTid,$false) > $null }
}
# Background coordinate click via PostMessage: walk to the deepest child at
# the point (so the top-level frame does not activate itself), hold
# WS_EX_NOACTIVATE on the root for the burst, then restore the previous
# foreground window if the target stole it anyway.
function PostClick($hwnd,$x,$y,$count) {
  $cur=$hwnd
  for ($i=0; $i -lt 16; $i++) {
    $p=New-Object CuaPoint; $p.X=[int]$x; $p.Y=[int]$y
    $N::ScreenToClient($cur,[ref]$p) > $null
    $child=$N::ChildWindowFromPointEx($cur,$p,7)
    if ([int64]$child -eq 0 -or $child -eq $cur) { break }
    if (-not $N::IsChild($hwnd,$child)) { break }
    $cur=$child
  }
  $p2=New-Object CuaPoint; $p2.X=[int]$x; $p2.Y=[int]$y
  $N::ScreenToClient($cur,[ref]$p2) > $null
  $root=$N::GetAncestor($hwnd,2); if ([int64]$root -eq 0) { $root=$hwnd }
  $exStyle=[int]$N::GetWindowLongPtr($root,-20)
  $noAct=0x08000000
  $armed=(($exStyle -band $noAct) -eq 0)
  if ($armed) { $N::SetWindowLongPtr($root,-20,($exStyle -bor $noAct)) > $null }
  $prevFg=$N::GetForegroundWindow()
  $lparam=[IntPtr][int64](((($p2.Y -band 0xffff) -shl 16) -bor ($p2.X -band 0xffff)))
  $dbl=((($N::GetClassLongPtr($cur,-26) -band 0x8) -ne 0))
  for ($i=0; $i -lt $count; $i++) {
    $down=0x0201; $up=0x0202
    if ($i -ge 1 -and $dbl) { $down=0x0203 }
    $N::PostMessage($cur,0x0200,[IntPtr]::Zero,$lparam) > $null
    $N::PostMessage($cur,$down,[IntPtr]1,$lparam) > $null
    Start-Sleep -m 30
    $N::PostMessage($cur,$up,[IntPtr]::Zero,$lparam) > $null
    Start-Sleep -m 30
  }
  if ($armed) { $N::SetWindowLongPtr($root,-20,$exStyle) > $null }
  RestoreFg $prevFg $root
  return $true
}
function Shot($h) {
  $r=New-Object CuaRect; $N::GetWindowRect($h,[ref]$r) > $null
  $w=$r.R-$r.L; $hh=$r.B-$r.T
  if ($w -le 0 -or $hh -le 0) { return '' }
  $bmp=[System.Drawing.Bitmap]::new($w,$hh); $g=Gr $bmp
  $hdc=$g.GetHdc(); $ok=$N::PrintWindow($h,$hdc,2); $g.ReleaseHdc($hdc)
  if (-not $ok) { $g2=Gr $bmp; $g2.CopyFromScreen($r.L,$r.T,0,0,[System.Drawing.Size]::new($w,$hh)); $g2.Dispose() }
  $ms=[System.IO.MemoryStream]::new(); $bmp.Save($ms,$png)
  $b64=[Convert]::ToBase64String($ms.ToArray()); $ms.Dispose(); $g.Dispose(); $bmp.Dispose()
  $b64
}
function Role($el) {
  $pn=$el.Current.ControlType.ProgrammaticName
  if ($pn -match 'ControlType\.(.+)$') { $pn=$matches[1] }
  $rm=@{Edit='textbox';Button='button';CheckBox='checkbox';ComboBox='combobox';ListItem='listitem';DataItem='dataitem';TabItem='tabitem';RadioButton='radiobutton';TreeItem='treeitem';Slider='slider';ScrollBar='scrollbar';Hyperlink='hyperlink';Window='window';Text='text'}
  if ($rm.ContainsKey($pn)) { return $rm[$pn] }
  $pn.ToLowerInvariant()
}
function Acts($el) {
  $a=@()
  foreach ($p in $el.GetSupportedPatterns()) {
    $n=$p.ProgrammaticName
    foreach ($t in @('Invoke','SelectionItem','Toggle','ExpandCollapse','Scroll','RangeValue','Value')) { if ($n.Contains($t)) { $a+=$t; break } }
  }
  $a
}
function Vk($k) {
  $m=@{Enter=0x0D;Tab=0x09;Escape=0x1B;BackSpace=0x08;Delete=0x2E;Home=0x24;End=0x23;Page_Up=0x21;Page_Down=0x22;Up=0x26;Down=0x28;Left=0x25;Right=0x27;Space=0x20}
  if ($m.ContainsKey($k)) { return $m[$k] }
  if ($k -match '^F([1-9]|1[0-2])$') { return 0x70+[int]$matches[1]-1 }
  if ($k) { return [int][char][char]::ToUpper($k[0]) }
  return 0
}
function SK($k) {
  $m=@{Enter='{ENTER}';Tab='{TAB}';Escape='{ESC}';BackSpace='{BACKSPACE}';Delete='{DELETE}';Home='{HOME}';End='{END}';Page_Up='{PGUP}';Page_Down='{PGDN}';Up='{UP}';Down='{DOWN}';Left='{LEFT}';Right='{RIGHT}';Space='{SPACE}'}
  if ($m.ContainsKey($k)) { return $m[$k] }
  if ($k -match '^F([1-9]|1[0-2])$') { return ('{'+$k+'}') }
  if ($k -match '^[A-Za-z0-9]$') { return $k }
  return $null
}
function Walk($el,$depth,[ref]$n) {
  if ($n.Value -ge $MaxE) { $script:Trunc=$true; return }
  if ($depth -gt $MaxD) { return }
  $cu=$el.Current
  try { if ($cu.IsOffscreen) { return } } catch { return }
  # Rect.Empty has Width/Height = -Infinity; guard before [int] conversion.
  $rect=$cu.BoundingRectangle
  $bx=0;$by=0;$bw=0;$bh=0
  if ($null -ne $rect -and -not $rect.IsEmpty) { $bx=[int]$rect.X;$by=[int]$rect.Y;$bw=[int]$rect.Width;$bh=[int]$rect.Height }
  $area=$bw*$bh
  $name=$cu.Name; $patterns=$el.GetSupportedPatterns()
  if (-not (-not $patterns -and -not $name -and $area -eq 0)) {
    $eid="win-$($HWND):1:$($n.Value)"
    $label=$name
    if (-not $label) { try { $label=$el.GetCurrentPattern($pl).Current.Name } catch { $label='' } }
    $script:List += @{elementId=$eid;role=(Role $el);label=$label;bounds=@{x=$bx;y=$by;width=$bw;height=$bh};enabled=$cu.IsEnabled;focused=$cu.HasKeyboardFocus;sensitive=$cu.IsPassword;actions=@(Acts $el)}
    $n.Value++
  }
  $c=0
  foreach ($child in $el.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)) {
    if ($c -ge 20) { $script:Trunc=$true; return }
    Walk $child ($depth+1) $n
    if ($n.Value -ge $MaxE) { $script:Trunc=$true; return }
    $c++
  }
}
function ElByIdx($el,$depth,$want,[ref]$n) {
  if ($null -eq $el) { return $null }
  if ($depth -gt $MaxD) { return $null }
  $cu=$el.Current
  try { if ($cu.IsOffscreen) { return $null } } catch { return $null }
  # Rect.Empty has Width/Height = -Infinity; guard before [int] conversion.
  $rect=$cu.BoundingRectangle
  $area=0; if ($null -ne $rect -and -not $rect.IsEmpty) { $area=[int]$rect.Width*[int]$rect.Height }
  $name=$cu.Name; $patterns=$el.GetSupportedPatterns()
  if (-not (-not $patterns -and -not $name -and $area -eq 0)) {
    if ($n.Value -eq $want) { return $el }
    $n.Value++
  }
  $c=0
  foreach ($child in $el.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)) {
    if ($c -ge 20) { return $null }
    $r=ElByIdx $child ($depth+1) $want $n
    if ($null -ne $r) { return $r }
    $c++
  }
  return $null
}
function FocEl($root,$depth) {
  if ($null -eq $root -or $depth -gt 20) { return $null }
  try { if ($root.Current.HasKeyboardFocus) { return $root } } catch { return $null }
  $c=0
  foreach ($child in $root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)) {
    if ($c -ge 20) { return $null }
    $r=FocEl $child ($depth+1)
    if ($null -ne $r) { return $r }
    $c++
  }
  return $null
}
`;

/** One branch per command — emitted into the switch only for the requested
 *  cmd, so e.g. click-element scripts never contain the coordinate-injection
 *  code (keeps the no-intrusion static assertions meaningful). */
const WIN_UIA_ONCE_BRANCHES: Record<WinUiaOnceCommand, string> = {
  'get-app-state': `'get-app-state' {
  $HWND=HW $R.hwnd
  if ($HWND -eq $z) { $HWND=$N::GetForegroundWindow() }
  if ($HWND -eq $z) { OE 'SERVER_ERROR' 'No window to read'; break }
  $MaxD=20; $MaxE=300
  if ($R.depth) { $MaxD=$R.depth }; if ($R.maxElements) { $MaxE=$R.maxElements }
  $script:List=@(); $script:Trunc=$false
  Walk (FH $HWND) 0 ([ref]0)
  $shot=''
  if ($R.screenshot) { $shot=Shot $HWND }
  OK @{hwnd=[int64]$HWND;gen=1;windowTitle=(Ttl $HWND);windowRect=(Rct $HWND);display=(Dsp);elements=$script:List;screenshot=$shot;truncated=$script:Trunc}
}`,
  'click-element': `'click-element' {
  if (-not $R.elementId) { OE 'SERVER_ERROR' 'elementId required'; break }
  if ($R.elementId -notmatch '^win-(-?\\d+):\\d+:(\\d+)$') { OE 'ELEMENT_STALE_TREE' 'Invalid element id'; break }
  $el=ElByIdx (FH ([IntPtr][int64]$matches[1])) 0 ([int]$matches[2]) ([ref]0)
  if (-not $el) { OE 'ELEMENT_STALE_TREE' 'Stale element'; break }
  # EnableWindow shield around UIA pattern calls: XAML/Chromium hosts
  # self-foreground while handling them (see the resident template).
  $HWND=[IntPtr][int64]$matches[1]
  $ok=Shield $HWND {
  $r=$false
  switch ($cm[(Role $el)]) {
  'FOC' { try { $el.SetFocus(); $r=$true } catch {}; if (-not $r) { $r=FTRY $el $pl 'Select' } }
  'INV' { $r=FTRY $el $pi 'Invoke'; if (-not $r) { $r=FTRY $el $pl 'DoDefaultAction' } }
  'SEL' { $r=FTRY $el $psi 'Select'; if (-not $r) { $r=FTRY $el $pi 'Invoke' } }
  'TOG' { $r=FTRY $el $pt 'Toggle' }
  'EXP' { $r=FTRY $el $pe 'Expand'; if (-not $r) { $r=FTRY $el $pi 'Invoke' } }
  'RNG' { try { $rv=$el.GetCurrentPattern($pr); $sc=$rv.Current.SmallChange; if ($sc -le 0) { $sc=1 }; $rv.SetValue($rv.Current.Value+$sc); $r=$true } catch {} }
  'DD' { $r=FTRY $el $pl 'DoDefaultAction' }
  }
  $r
  }
  if ($ok) { OK @{clicked=$true} } else { OE 'ELEMENT_NO_ACTION' 'No action' }
}`,
  'type-text': `'type-text' {
  $text=''
  if ($R.textB64) { $text=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($R.textB64)) }
  $el=$null
  $HWND=$z
  if ($R.elementId) {
    if ($R.elementId -notmatch '^win-(-?\\d+):\\d+:(\\d+)$') { OE 'ELEMENT_STALE_TREE' 'Invalid element id'; break }
    $el=ElByIdx (FH ([IntPtr][int64]$matches[1])) 0 ([int]$matches[2]) ([ref]0)
    if (-not $el) { OE 'ELEMENT_STALE_TREE' 'Stale element'; break }
    $HWND=[IntPtr][int64]$matches[1]
  }
  $ok=$false
  if ($el) {
    $ok=Shield $HWND {
    $r=$false
    try { $el.GetCurrentPattern($pv).SetValue($text); $r=$true } catch {}
    if (-not $r) { try { $el.GetCurrentPattern($pl).SetValue($text); $r=$true } catch {} }
    if (-not $r) { try { $w=$el.Current.NativeWindowHandle; if ($w -ne 0 -and -not (UipiBlocked $w)) { $r=SM $w $text } } catch {} }
    $r
    }
  } else {
    # No elementId: set the window's focused element. Never fall back to
    # WM_SETTEXT on the top-level window - that only rewrites the window
    # title and reports a false success.
    $hwnd=HW $R.hwnd
    if ($hwnd -eq $z) { $hwnd=$N::GetForegroundWindow() }
    if ($hwnd -ne $z) {
      $ok=Shield $hwnd {
      $fe=FocEl (FH $hwnd) 0
      $r=$false
      if ($fe) {
        try { $fe.GetCurrentPattern($pv).SetValue($text); $r=$true } catch {}
        if (-not $r) { try { $fe.GetCurrentPattern($pl).SetValue($text); $r=$true } catch {} }
        if (-not $r) { try { $w=$fe.Current.NativeWindowHandle; if ($w -ne 0 -and -not (UipiBlocked $w)) { $r=SM $w $text } } catch {} }
      }
      $r
      }
    }
  }
  if ($ok) { OK @{typed=$true} } else { OE 'ELEMENT_NO_ACTION' 'No text target' }
}`,
  'press-key': `'press-key' {
  $hwnd=HW $R.hwnd
  if ($hwnd -eq $z) { $hwnd=$N::GetForegroundWindow() }
  if ($hwnd -eq $z) { OE 'SERVER_ERROR' 'hwnd required'; break }
  $vk=Vk $R.key
  if ($vk -eq 0) { OE 'SERVER_ERROR' ("Unknown key: " + $R.key); break }
  $fe=FocEl (FH $hwnd) 0
  $w=$z
  if ($fe) { try { $w=$fe.Current.NativeWindowHandle } catch { $w=$z } }
  # Editable-document detection: Win11 Notepad focuses an inner Pane whose
  # native window is a XAML child (a real handle, but PostMessage to it is
  # silently ignored - false success). Find the editor document anywhere in
  # the window tree (ControlType=Document) and apply Enter/Tab/BackSpace
  # via ValuePattern append instead: no keyboard, no IME. Window-wide
  # lookup, not focus-relative - SetFocus can land on the tab-strip Pane,
  # where a focus-subtree walk finds no document at all.
  $doc=$null
  try {
    $dc=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Document)
    $doc=(FH $hwnd).FindFirst([System.Windows.Automation.TreeScope]::Subtree,$dc)
  } catch {}
  if ($null -ne $doc) {
    $vpOk=Shield $hwnd {
    $r=$false
    try {
      $vp2=$doc.GetCurrentPattern($pv)
      $cur2=$vp2.Current.Value
      if ($cur2 -ne $null) {
        switch ($R.key) {
          'Enter' { $vp2.SetValue($cur2 + [char]10); $r=$true }
          'Tab' { $vp2.SetValue($cur2 + [char]9); $r=$true }
          'BackSpace' { if ($cur2.Length -gt 0) { $vp2.SetValue($cur2.Substring(0,$cur2.Length-1)); $r=$true } }
        }
      }
    } catch {}
    $r
    }
    if ($vpOk) { OK @{key=$R.key}; break }
    # append failed (document without ValuePattern): fall through to the
    # non-intrusive PostMessage path below.
  }
  # 1) Non-intrusive: PostMessage to the focused element's native window
  #    (Win32 controls like legacy Notepad's edit) - works without
  #    foreground. Skip when the element reports the top-level window's own
  #    hwnd (UWP/XAML Islands like Win11 Notepad): posting to the top-level
  #    window is a no-op there, so fall through to real key injection.
  if ($null -eq $doc -and [int64]$w -ne 0 -and [int64]$w -ne [int64]$hwnd) {
    if (UipiBlocked $w) { OE 'UIPI_BLOCKED' 'Target window is elevated; input injection blocked by UIPI from this process'; break }
    $N::PostMessage($w,0x0100,[IntPtr]$vk,$z) > $null
    $N::PostMessage($w,0x0101,[IntPtr]$vk,$z) > $null
    OK @{key=$R.key}
  } else {
    # 2) Modern apps (Chrome/Edge - UIA elements have no native hwnd) or
    #    keys without text semantics: foreground the target and inject a
    #    real key (same trade-off as Linux xdotool).
    $sk=SK $R.key
    if (-not $sk) { OE 'SERVER_ERROR' ("Unsupported key: " + $R.key); break }
    else {
      # Real key injection needs the foreground - but only when the target is
      # not already there. Refuse at >2 input events/s (human at the keys; an
      # idle wireless poke is filtered; userActiveMs 0 disables the guard).
      $prevFg=$N::GetForegroundWindow()
      if ($prevFg -ne $hwnd) {
        $th=$R.userActiveMs; if ($null -eq $th -or $th -lt 0) { $th=3000 }
        if ($th -gt 0 -and (InputEventsIn 1000) -gt 2) { OE 'USER_ACTIVE' 'User is actively using the computer; retry later'; break }
      }
      $N::SetForegroundWindow($hwnd) > $null
      $fg=$N::GetForegroundWindow()
      if ($fg -ne $hwnd) {
        $fgPid=0; $fgTid=$N::GetWindowThreadProcessId($fg,[ref]$fgPid); $myTid=$N::GetCurrentThreadId()
        if ($fgTid -ne 0) { $N::AttachThreadInput($myTid,$fgTid,$true) > $null; $N::SetForegroundWindow($hwnd) > $null; $N::AttachThreadInput($myTid,$fgTid,$false) > $null }
      }
      $fg=$N::GetForegroundWindow()
      if ($fg -ne $hwnd) { OE 'SERVER_ERROR' 'Could not foreground target window'; break }
      try { $wshell=New-Object -ComObject WScript.Shell; $wshell.SendKeys($sk) } catch { OE 'SERVER_ERROR' 'SendKeys failed'; break }
      # SendKeys is async (SendInput enqueues and returns): let the key reach
      # the target before handing the foreground back to the user's window.
      Start-Sleep -m 200
      RestoreFg $prevFg $hwnd
      OK @{key=$R.key}
    }
  }
}`,
  scroll: `'scroll' {
  $el=$null
  if ($R.elementId) {
    if ($R.elementId -notmatch '^win-(-?\\d+):\\d+:(\\d+)$') { OE 'ELEMENT_STALE_TREE' 'Invalid element id'; break }
    $el=ElByIdx (FH ([IntPtr][int64]$matches[1])) 0 ([int]$matches[2]) ([ref]0)
    if (-not $el) { OE 'ELEMENT_STALE_TREE' 'Stale element'; break }
  }
  if (-not $el) {
    $hwnd=HW $R.hwnd
    if ($hwnd -eq $z) { $hwnd=$N::GetForegroundWindow() }
    try { $el=FH $hwnd } catch { $el=$null }
  }
  $sp=$null; $cur=$el
  while ($null -ne $cur -and $null -eq $sp) { try { $sp=$cur.GetCurrentPattern($ps) } catch { $sp=$null }; if ($null -eq $sp) { $cur=$tw.GetParent($cur) } }
  if (-not $sp) { OE 'ELEMENT_NO_ACTION' 'No scrollable'; break }
  $rep=$R.amount; if (-not $rep -or $rep -lt 1) { $rep=1 }
  for ($i=0; $i -lt $rep; $i++) {
    switch ($R.direction) {
    'up' { $sp.Scroll($sd,$sn) } 'left' { $sp.Scroll($sn,$sd) }
    'right' { $sp.Scroll($sn,$si) } default { $sp.Scroll($si,$sn) }
    }
  }
  OK @{scrolled=$true}
}`,
  'click-point': `'click-point' {
  if ($null -eq $R.x -or $null -eq $R.y) { OE 'SERVER_ERROR' 'x and y required'; break }
  $hwnd=HW $R.hwnd
  if ($hwnd -eq $z) { $hwnd=$N::GetForegroundWindow() }
  if ($hwnd -eq $z) { OE 'SERVER_ERROR' 'No target window for click-point'; break }
  if (UipiBlocked $hwnd) { OE 'UIPI_BLOCKED' 'Target window is elevated; input injection blocked by UIPI from this process'; break }
  PostClick $hwnd $R.x $R.y 1 > $null
  OK @{clicked=$true}
}`,
  'double-click': `'double-click' {
  if ($null -eq $R.x -or $null -eq $R.y) { OE 'SERVER_ERROR' 'x and y required'; break }
  $hwnd=HW $R.hwnd
  if ($hwnd -eq $z) { $hwnd=$N::GetForegroundWindow() }
  if ($hwnd -eq $z) { OE 'SERVER_ERROR' 'No target window for double-click'; break }
  if (UipiBlocked $hwnd) { OE 'UIPI_BLOCKED' 'Target window is elevated; input injection blocked by UIPI from this process'; break }
  PostClick $hwnd $R.x $R.y 2 > $null
  OK @{clicked=$true}
}`,
};
