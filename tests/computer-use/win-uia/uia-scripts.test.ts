import { describe, expect, it } from 'vitest';
import {
  buildWinUiaServerScript,
  writeUiaServerScript,
  UIA_HANDSHAKE_MARKER,
  UIA_SERVER_SCRIPT_PATH,
} from '../../../src/computer-use/win-uia/win-uia-scripts.js';
import { winToWslPath } from '../../../src/computer-use/win-uia/uia-client.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('win-uia server script (PowerShell template)', () => {
  const script = buildWinUiaServerScript();

  it('is written in ASCII and contains the handshake marker', () => {
    expect(script).toMatch(/^[\x00-\x7F]*$/);
    expect(script).toContain(UIA_HANDSHAKE_MARKER);
  });

  it('loads UIA assemblies and patterns via Add-Type (no native deps)', () => {
    expect(script).toContain('UIAutomationClient');
    expect(script).toContain('InvokePattern');
    expect(script).toContain('ValuePattern');
    expect(script).toContain('ScrollPattern');
    expect(script).toContain('PrintWindow');
  });

  it('sets UTF-8 console encodings first (CJK-safe protocol)', () => {
    expect(script.indexOf('[Console]::OutputEncoding')).toBeLessThan(script.indexOf('CUAREADY'));
    expect(script).toContain('[System.Text.UTF8Encoding]::new($false)');
  });

  it('click-element/type-text branches (click-element..press-key) never inject input', () => {
    const start = script.indexOf("'click-element'");
    const end = script.indexOf("'press-key'");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const semantic = script.slice(start, end);
    expect(semantic).not.toContain('SetCursorPos');
    expect(semantic).not.toContain('mouse_event');
    expect(semantic).not.toContain('SendKeys');
    expect(semantic).not.toContain('Clipboard');
    expect(semantic).not.toContain('SendInput');
  });

  it('click-element focuses textboxes via AutomationElement.SetFocus()', () => {
    // Edit controls (role textbox) must be focusable — previously they
    // returned ELEMENT_NO_ACTION so agents could never click into an
    // address bar or editor. The SetFocusPattern class is absent on some
    // .NET Framework builds (observed on Win11 + PS 5.1), so we focus via
    // the AutomationElement.SetFocus() method, which exists everywhere.
    expect(script).toContain("textbox='FOC'");
    expect(script).toContain("$el.SetFocus()");
    expect(script).toContain("'FOC' { try { $el.SetFocus(); $r=$true } catch {}");
  });

  it('type-text sets the focused element, never the top-level window title', () => {
    // The SM() helper posts SendMessage(hwnd, 0x000C=WM_SETTEXT, ...).
    expect(script).toContain('SendMessage');
    expect(script).toContain('0x000C');
    const start = script.indexOf("'type-text'");
    const end = script.indexOf("'press-key'");
    const type = script.slice(start, end);
    expect(type).not.toContain('SendKeys');
    expect(type).not.toContain('Clipboard');
    // WM_SETTEXT to the top-level window only rewrites the title and reports
    // a false success — the fallback must target the focused element.
    expect(type).not.toContain('SM $S.Hwnd $text');
    expect(type).toContain('HasKeyboardFocus');
  });

  it('launch-app branch does not steal focus or maximize', () => {
    const start = script.indexOf("'launch-app'");
    const end = script.indexOf("'focus-app'");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const launch = script.slice(start, end);
    // RestoreFg's SetForegroundWindow lives in the shared preamble - the
    // branch itself must only reference it by name, never foreground.
    expect(launch).not.toContain('SetForegroundWindow');
    expect(launch).not.toContain('AttachThreadInput');
    expect(launch).not.toContain('SW_MAXIMIZE');
    expect(launch).toContain('MainWindowHandle');
    // Focus-free launch: start minimized (a minimized window cannot take the
    // foreground), then restore without activating; hand the foreground back
    // if an AppX host activated anyway.
    expect(launch).toContain('-WindowStyle Minimized');
    expect(launch).toContain('ShowWindow([IntPtr]$hwnd,4)');
    expect(launch).toContain('RestoreFg $prevFg $hwnd');
  });

  it('click-point uses the PostMessage chain — never SetCursorPos/mouse_event', () => {
    const start = script.indexOf("'click-point'");
    const end = script.indexOf("'quit'");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const click = script.slice(start, end);
    expect(click).not.toContain('SetCursorPos');
    expect(click).not.toContain('mouse_event');
    expect(click).toContain('PostClick $hwnd');
    expect(click).toContain('UipiBlocked');
    // Chain machinery lives in the shared preamble.
    expect(script).toContain('ChildWindowFromPointEx');
    expect(script).toContain('0x08000000'); // WS_EX_NOACTIVATE
    expect(script).toContain('0x0201'); // WM_LBUTTONDOWN
    expect(script).toContain('0x0203'); // WM_LBUTTONDBLCLK
  });

  it('UIA pattern calls are shielded from foreground-stealing hosts (EnableWindow bypass)', () => {
    expect(script).toContain('function Shield($h,$body)');
    expect(script).toContain('Chrome_WidgetWin_');
    expect(script).toContain('WinUIDesktopWin32WindowClass');
    expect(script).toContain('Shield $S.Hwnd');
    // UIPI integrity check prevents silent false-success against elevated
    // targets (PostMessage returns TRUE but the message is dropped).
    expect(script).toContain('GetIntegrityLevel');
    expect(script).toContain('UIPI_BLOCKED');
  });

  it('declares every extern used by GetIntegrityLevel (Add-Type compiles)', () => {
    // Real-machine trap: GetIntegrityLevel calls CloseHandle but the
    // [DllImport] declaration was missing, so Add-Type failed at server
    // startup with "当前上下文中不存在名称CloseHandle" and the whole
    // handshake timed out. PowerShell Parser::ParseFile can't catch this -
    // only the C# compiler can.
    expect(script).toContain('[DllImport("kernel32.dll")]public static extern bool CloseHandle(IntPtr h);');
    expect(script).toContain('extern IntPtr OpenProcess(uint a,bool i,uint p);');
    expect(script).toContain('extern bool OpenProcessToken(IntPtr h,uint a,out IntPtr t);');
    expect(script).toContain('extern bool GetTokenInformation(IntPtr t,uint c,byte[] b,uint n,out uint r);');
    // User-activity guard + focus-free launch (same Add-Type trap: a missing
    // [DllImport] compiles fine until Add-Type runs on the real machine).
    expect(script).toContain('public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }');
    expect(script).toContain('[DllImport("user32.dll")]public static extern bool GetLastInputInfo(ref LASTINPUTINFO li);');
    expect(script).toContain('[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int c);');
  });

  it('WaitHwnd never assigns a null MainWindowHandle (PS 5.1 AppX trap)', () => {
    // A process with no main window (the AppX activator that exits right
    // after Start-Process) reports MainWindowHandle as $null in PS 5.1.
    // Unconditional assignment made WaitHwnd return $null: `$null -eq $z`
    // was false, so the AppX poll was skipped and ShowWindow($null) threw
    // SERVER_ERROR on every launch-app of the Win11 notepad.
    expect(script).toContain('$h=$p.MainWindowHandle; if ($h) { $hwnd=$h }');
    expect(script).toContain('$h=$p.MainWindowHandle; if ($h) { $hwnd=[int64]$h }');
    expect(script).toContain('[IntPtr]$hwnd,4');
  });

  it('provides the user-activity guard and foreground-restore helpers', () => {
    // Frequency, not recency: a wireless mouse's idle poke (~1 per 2s)
    // resets GetLastInputInfo with no human at the keys, so the guard counts
    // distinct events over a 1s window and rejects only at >2/s.
    expect(script).toContain('function InputEventsIn');
    // LASTINPUTINFO nests in the Add-Type class: PS 5.1 has no [X+Y] type
    // literal, so New-Object must use the 'CuaNative+...' string form and
    // cbSize is fixed at 8 (two uint). The old top-level reference threw
    // "找不到类型 [LASTINPUTINFO]" at runtime and the guard never worked.
    expect(script).toContain("New-Object 'CuaNative+LASTINPUTINFO'; $li.cbSize=8");
    expect(script).toContain('(InputEventsIn 1000) -gt 2');
    expect(script).toContain('function RestoreFg($prev,$tgt)');
    expect(script).toContain('$N::GetForegroundWindow() -ne $tgt');
    // PostClick reuses the helper for its own foreground restore.
    expect(script).toContain('RestoreFg $prevFg $root');
  });

  it('focus-app and press-key SendKeys fallback may foreground the target', () => {
    const start = script.indexOf("'focus-app'");
    const end = script.indexOf("'close-app'");
    const focus = script.slice(start, end);
    expect(focus).toContain('SetForegroundWindow');
    // press-key's SendKeys fallback (for apps whose UIA elements have no
    // native hwnd, e.g. Chrome/Edge) foregrounds the target first, guarded
    // by a foreground check so keys never land in a wrong window.
    const pkStart = script.indexOf("'press-key'");
    const pkEnd = script.indexOf("'scroll'");
    const pressKey = script.slice(pkStart, pkEnd);
    expect(pressKey).toContain('SendKeys');
    expect(pressKey).toContain('SetForegroundWindow');
    expect(pressKey).toContain('Could not foreground target window');
    // The SendKeys fallback refuses while the user is actively typing and
    // hands the foreground back once the key has been delivered.
    expect(pressKey).toContain("'USER_ACTIVE'");
    expect(pressKey).toContain('RestoreFg $prevFg $hwnd');
    expect(pressKey).toContain('Start-Sleep -m 200');
  });

  // The script runs via `powershell.exe -File`, so there is no 32KB cmdline
  // limit on its content; the cap is a safety margin for PS parsing speed.
  // Raised from 20KB when the foreground-steal shield + PostMessage click
  // chain (+~5KB of helpers) landed.
  it('stays under the 30KB length budget', () => {
    expect(script.length).toBeLessThan(30_000);
  });

  it('guards against Rect.Empty bounds (Width/Height = -Infinity would throw [int])', () => {
    // Real-machine trap: some elements report an empty BoundingRectangle;
    // [int](-Infinity) throws "Value was either too large or too small".
    expect(script).toContain('IsEmpty');
    const walk = script.slice(script.indexOf('function Walk'), script.indexOf('while ($true)'));
    expect(walk).toContain('$bx=0;$by=0;$bw=0;$bh=0');
    // The [int] conversion may only happen behind the IsEmpty guard.
    expect(walk.indexOf('IsEmpty')).toBeLessThan(walk.indexOf('[int]$rect.Width'));
  });

  it('uses a blocking ReadLine main loop, not a Peek() poll', () => {
    // WSL interop trap: [Console]::In.Peek() false-EOFs (returns -1) once the
    // pipe has been read empty, so a Peek() poll silently stops consuming
    // commands after the first one. The loop must block on ReadLine and exit
    // only on a real EOF; idle self-exit is driven client-side.
    expect(script).toContain('$C::In.ReadLine()');
    expect(script).toContain('if ($null -eq $line) { break }');
    expect(script).not.toContain('$C::In.Peek()');
    expect(script).not.toContain("'EXIT'");
    expect(script).not.toContain('600000');
  });
});

describe('writeUiaServerScript', () => {
  it('writes UTF-8 with BOM so PS 5.1 parses it as UTF-8', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uia-script-'));
    const target = join(dir, 'win-uia-server.ps1');
    try {
      writeUiaServerScript(target);
      const bytes = readFileSync(target);
      // BOM = EF BB BF
      expect(bytes[0]).toBe(0xef);
      expect(bytes[1]).toBe(0xbb);
      expect(bytes[2]).toBe(0xbf);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('winToWslPath', () => {
  it('converts C:\\ paths to /mnt/c/ for WSL callers', () => {
    expect(winToWslPath('C:\\Windows\\Temp\\ohmyagent\\win-uia-server.ps1'))
      .toBe('/mnt/c/Windows/Temp/ohmyagent/win-uia-server.ps1');
    expect(winToWslPath(UIA_SERVER_SCRIPT_PATH)).toMatch(/^\/mnt\/c\//);
  });

  it('passes non-Windows paths through unchanged', () => {
    expect(winToWslPath('/tmp/x.ps1')).toBe('/tmp/x.ps1');
  });
});
