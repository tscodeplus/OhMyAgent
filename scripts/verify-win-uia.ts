// scripts/verify-win-uia.ts
//
// End-to-end verification of the Windows UIA computer-use scripts against a
// real Windows desktop (run from WSL via powershell.exe interop, or directly
// on Windows).
//
// Usage: pnpm verify:win-uia    (or: pnpm exec tsx scripts/verify-win-uia.ts)
//
// Spawns the resident UIA server exactly like uia-client.ts does, then drives
// the original bug scenarios through the real protocol:
//   A. Notepad: launch -> find editor -> click -> type Chinese text ->
//      read back the ValuePattern value (proves input landed, no false
//      success) -> press Enter -> read back again (a newline was inserted,
//      IME-proof).
//   C. Chrome: launch -> find address bar -> click -> type URL -> Enter ->
//      screenshots saved under C:\Windows\Temp\oma-verify-*.png.
//
// Notes:
//   - Close existing Notepad/Chrome windows first for a clean run (launch-app
//     reuses a running instance).
//   - PrintWindow captures of Win11 AppX Notepad can come out blank; the
//     ValuePattern readback is the authoritative check for input.
//   - Chrome's Enter uses the SendKeys fallback, which requires bringing the
//     window to the foreground. Windows' foreground lock refuses that while
//     the screen is locked (LockApp owns the foreground) or the desktop is
//     otherwise in use, so C6 can fail with "Could not foreground target
//     window". Unlock the screen (or click once on the desktop) and re-run.
//     The failure is the safety guard working, not a bug: keys must never
//     land in the wrong window. The non-intrusive paths (Notepad scenario)
//     work even while locked - only real-key injection needs the foreground.
//   - Exits 0 when all steps pass, 1 otherwise.

import { buildWinUiaServerScript, UIA_HANDSHAKE_MARKER, UIA_SERVER_SCRIPT_PATH } from '../src/computer-use/win-uia/win-uia-scripts.js';
import { winToWslPath } from '../src/computer-use/win-uia/uia-client.js';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SHOT_DIR = winToWslPath('C:\\Windows\\Temp');
const READVAL_PS1_WIN = 'C:\\Windows\\Temp\\ohmyagent\\oma-readval.ps1';

let failures = 0;
function check(step: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${detail ? ' - ' + detail : ''}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------
// UIA server harness
// ---------------------------------------------------------------------------

interface Server {
  child: ReturnType<typeof spawn>;
  req(cmd: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  stop(): void;
}

async function startServer(): Promise<Server> {
  const script = buildWinUiaServerScript();
  const wslPath = winToWslPath(UIA_SERVER_SCRIPT_PATH);
  mkdirSync(dirname(wslPath), { recursive: true });
  writeFileSync(wslPath, '\uFEFF' + script, 'utf8');
  console.log(`[script] wrote ${wslPath} (${script.length} chars)`);

  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', UIA_SERVER_SCRIPT_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
  let outBuf = '';
  let nextId = 1;
  const pending = new Map<number, (m: any) => void>();
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));

  child.stdout.on('data', (chunk: Buffer) => {
    outBuf += chunk.toString('utf8');
    let nl: number;
    while ((nl = outBuf.indexOf('\n')) !== -1) {
      const line = outBuf.slice(0, nl).replace(/\r$/, '').trim();
      outBuf = outBuf.slice(nl + 1);
      if (!line) continue;
      if (line.startsWith(UIA_HANDSHAKE_MARKER)) { resolveReady(); continue; }
      try {
        const msg = JSON.parse(line);
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p(msg); }
      } catch { console.log('[non-json]', line.slice(0, 200)); }
    }
  });
  child.stderr.on('data', (c: Buffer) => console.log('[stderr]', c.toString('utf8').slice(0, 300)));

  const server: Server = {
    child,
    req(cmd: string, payload: Record<string, unknown> = {}, timeoutMs = 25000) {
      return new Promise((resolve) => {
        const id = nextId++;
        const t = setTimeout(() => { pending.delete(id); resolve({ timedOut: true, cmd }); }, timeoutMs);
        pending.set(id, (m) => { clearTimeout(t); resolve(m); });
        child.stdin.write(JSON.stringify({ id, cmd, ...payload }) + '\n');
      });
    },
    stop() { child.kill(); },
  };

  let t: NodeJS.Timeout | undefined;
  await Promise.race([
    ready,
    new Promise((r) => (t = setTimeout(() => { console.log('FAIL handshake timeout'); r(undefined); }, 30000))),
  ]);
  if (t) clearTimeout(t); // ready won the race - don't let the timer fire mid-scenario
  return server;
}

// Read the first non-empty ValuePattern value of a window via a standalone PS
// process (base64 so embedded newlines cannot break the parse).
function readValue(hwnd: number): { ok: boolean; value: string } {
  const ps = `
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference='SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${hwnd})
$els=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
foreach($e in $els){ try { $vp=$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $v=$vp.Current.Value; if($null -ne $v -and $v -ne ''){ $b=[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($v)); [Console]::Out.WriteLine('VB64=' + $b); break } } catch {} }
`;
  const wsl = winToWslPath(READVAL_PS1_WIN);
  mkdirSync(dirname(wsl), { recursive: true });
  writeFileSync(wsl, '\uFEFF' + ps, 'utf8');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', READVAL_PS1_WIN], { encoding: 'utf8', timeout: 20000 });
    const m = out.match(/VB64=([A-Za-z0-9+/=]+)/);
    if (!m) return { ok: false, value: '(no ValuePattern value found)' };
    return { ok: true, value: Buffer.from(m[1], 'base64').toString('utf8') };
  } catch (e) {
    return { ok: false, value: String(e) };
  }
}

async function saveScreenshot(server: Server, label: string, hwnd: number, fileName: string) {
  const r = await server.req('screenshot', { hwnd });
  if (r.ok && r.result?.screenshot) {
    const out = `${SHOT_DIR}/${fileName}`;
    writeFileSync(out, Buffer.from(r.result.screenshot, 'base64'));
    console.log(`[shot] ${label} -> ${out}`);
  } else {
    console.log(`[shot] ${label} unavailable (${JSON.stringify(r.error ?? r)})`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioNotepad(server: Server): Promise<void> {
  console.log('\n=== A. Notepad: type Chinese text + Enter ===');
  const la = await server.req('launch-app', { name: 'notepad' });
  const hwnd: number = la.result?.hwnd ?? 0;
  check('A1 launch-app notepad', la.ok === true && hwnd !== 0, JSON.stringify(la.result ?? la.error));

  const st = await server.req('get-app-state', { hwnd });
  const els: any[] = st.result?.elements ?? [];
  const target = els.find((e) => e.role === 'textbox')
    ?? els.find((e) => e.role === 'document' && (e.actions ?? []).includes('Value'));
  check('A2 editor element found (textbox or document+Value)', !!target,
    target ? `${target.role}:${target.elementId}:${target.label}` : `none of ${els.length} elements`);

  const cl = await server.req('click-element', { elementId: target.elementId });
  check('A3 click-element (SetFocus)', cl.ok === true, JSON.stringify(cl.error ?? cl.result));

  const ty = await server.req('type-text', { elementId: target.elementId, text: '今天天气不错' });
  check('A4 type-text Chinese (ValuePattern.SetValue)', ty.ok === true, JSON.stringify(ty.error ?? ty.result));

  const v1 = readValue(hwnd);
  check('A5 readback shows the typed text (no false success)', v1.ok && v1.value.includes('今天天气不错'),
    v1.ok ? JSON.stringify(v1.value) : v1.value);

  const pk = await server.req('press-key', { hwnd, key: 'Enter' });
  check('A6 press-key Enter', pk.ok === true, JSON.stringify(pk.error ?? pk.result));

  const v2 = readValue(hwnd);
  check('A7 readback has a line break (IME-proof Enter)', v2.ok && /[\r\n]/.test(v2.value),
    v2.ok ? JSON.stringify(v2.value) : v2.value);

  await saveScreenshot(server, 'notepad', hwnd, 'oma-verify-notepad.png');
}

async function scenarioChrome(server: Server): Promise<void> {
  console.log('\n=== C. Chrome: address bar -> www.sohu.com -> Enter ===');
  const la = await server.req('launch-app', { name: 'chrome' });
  const hwnd: number = la.result?.hwnd ?? 0;
  check('C1 launch-app chrome', la.ok === true && hwnd !== 0, JSON.stringify(la.result ?? la.error));
  await sleep(2000);

  const st = await server.req('get-app-state', { hwnd });
  const els: any[] = st.result?.elements ?? [];
  const boxes = els.filter((e) => e.role === 'textbox');
  const addr = boxes.find((e) => /address|地址|search|搜索/i.test(e.label ?? '')) ?? boxes[0];
  check('C2 address bar found', !!addr,
    addr ? `${addr.elementId}:${addr.label}` : `no textbox in ${els.length} elements`);

  const cl = await server.req('click-element', { elementId: addr.elementId });
  check('C3 click-element address bar', cl.ok === true, JSON.stringify(cl.error ?? cl.result));

  const ty = await server.req('type-text', { elementId: addr.elementId, text: 'www.sohu.com' });
  check('C4 type-text URL', ty.ok === true, JSON.stringify(ty.error ?? ty.result));

  const v = readValue(hwnd);
  check('C5 readback address bar contains URL', v.ok && v.value.includes('sohu'),
    v.ok ? JSON.stringify(v.value) : v.value);

  const pk = await server.req('press-key', { hwnd, key: 'Enter' });
  check('C6 press-key Enter (SendKeys fallback)', pk.ok === true, JSON.stringify(pk.error ?? pk.result));

  await sleep(6000);
  await saveScreenshot(server, 'chrome after navigation', hwnd, 'oma-verify-chrome.png');
  console.log('   NOTE: open the saved screenshot to confirm the page really navigated to sohu.com');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const server = await startServer();
  try {
    await scenarioNotepad(server);
    await scenarioChrome(server);
  } finally {
    server.stop();
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (exit ${failures === 0 ? 0 : 1})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
