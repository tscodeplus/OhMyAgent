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

  it('click-element focuses textboxes via SetFocusPattern', () => {
    // Edit controls (role textbox) must be focusable — previously they
    // returned ELEMENT_NO_ACTION so agents could never click into an
    // address bar or editor.
    expect(script).toContain("textbox='FOC'");
    expect(script).toContain('[System.Windows.Automation.SetFocusPattern]::Pattern');
    expect(script).toContain("$ok=FTRY $el $sfp 'SetFocus'");
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
    expect(launch).not.toContain('SetForegroundWindow');
    expect(launch).not.toContain('AttachThreadInput');
    expect(launch).not.toContain('SW_MAXIMIZE');
    expect(launch).toContain('MainWindowHandle');
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
  });

  // The script runs via `powershell.exe -File`, so there is no 32KB cmdline
  // limit on its content; the cap is a safety margin for PS parsing speed.
  it('stays under the 20KB length budget', () => {
    expect(script.length).toBeLessThan(20_000);
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
