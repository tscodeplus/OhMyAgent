// Gateway chooser HTML — visual port of the original Electron
// desktop/src/main.ts:createGatewayChooserHtml (indigo gradient card UI).
// Rendered by the sidecar (window URL = control API /_desktop/gateway-chooser)
// so the page origin matches the remote-domain ACL and window.electronAPI
// invokes work; data: URLs get rejected by the ACL (opaque origin).

import type { DesktopConfig } from './config.js';

export interface ChooserOptions {
  error?: string;
  initialUrl?: string;
  initialToken?: string;
}

interface GatewayStrings {
  title: string;
  local: string;
  localDesc: string;
  remote: string;
  remoteDesc: string;
  urlPlaceholder: string;
  tokenPlaceholder: string;
  testBtn: string;
  saveBtn: string;
  testing: string;
  exitBtn: string;
  connected: string;
  serverOnlineTokenInvalid: string;
  gatewayUnreachable: string;
}

// Same strings as src/locales/{lang}/desktop.json → gateway (kept in sync).
const ZH: GatewayStrings = {
  title: '选择网关模式',
  local: '本地网关',
  localDesc: '在此电脑上运行嵌入式 OhMyAgent 服务',
  remote: '远程网关',
  remoteDesc: '连接到网络中另一台设备上运行的 OhMyAgent',
  urlPlaceholder: 'http://192.168.1.100:9191',
  tokenPlaceholder: '从远程网关.env文件或启动日志中获取令牌',
  testBtn: '测试连接',
  saveBtn: '保存并启动',
  testing: '测试中...',
  exitBtn: '退出',
  connected: '连接成功',
  serverOnlineTokenInvalid: '网关在线但令牌无效',
  gatewayUnreachable: '网关无法连接或不在线',
};

const EN: GatewayStrings = {
  title: 'Choose Gateway Mode',
  local: 'Local Gateway',
  localDesc: 'Run the embedded OhMyAgent server on this computer',
  remote: 'Remote Gateway',
  remoteDesc: 'Connect to an OhMyAgent instance on another device',
  urlPlaceholder: 'http://192.168.1.100:9191',
  tokenPlaceholder: 'Look up token from remote .env file or startup log',
  testBtn: 'Test Connection',
  saveBtn: 'Save & Start',
  testing: 'Testing...',
  exitBtn: 'Exit',
  connected: 'Connected',
  serverOnlineTokenInvalid: 'Server online but token invalid',
  gatewayUnreachable: 'Cannot connect to gateway',
};

export function renderChooser(
  cfg: DesktopConfig,
  opts: ChooserOptions = {},
): string {
  const lang = cfg.language ?? 'zh-CN';
  const t = lang === 'zh-CN' ? ZH : EN;
  const initialMode = cfg.gateway.mode ?? 'local';
  const initialUrl = opts.initialUrl ?? cfg.gateway.remoteUrl;
  const initialToken = opts.initialToken ?? cfg.gateway.remoteToken;
  // opts.error is either a known i18n key (from the shell's remote
  // pre-flight) or a free-form, already-translated message (from the WebUI
  // error page) — resolve keys against the local dictionary, pass others
  // through.
  const rawError = opts.error ?? '';
  const errorMessage =
    rawError in t ? t[rawError as keyof GatewayStrings] : rawError;

  // eslint-disable-next-line no-useless-escape
  const js = (s: string): string => s.replace(/'/g, "\\'");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    height:100vh;display:flex;flex-direction:column;align-items:center;
    justify-content:center;background:linear-gradient(135deg,#1e1b4b,#312e81);
    color:#e2e8f0;padding:32px;user-select:none;
  }
  .card{
    background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);
    border-radius:16px;padding:32px;max-width:520px;width:100%;
  }
  h1{font-size:20px;font-weight:700;margin-bottom:24px;text-align:center}
  .option{
    display:flex;align-items:flex-start;gap:12px;padding:16px;
    border:2px solid rgba(255,255,255,.1);border-radius:12px;margin-bottom:12px;
    cursor:pointer;transition:border-color .2s,background .2s;
  }
  .option:hover{background:rgba(255,255,255,.04)}
  .option.active{border-color:#818cf8;background:rgba(99,102,241,.15)}
  .radio{
    width:20px;height:20px;border-radius:50%;border:2px solid rgba(255,255,255,.3);
    display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;
  }
  .option.active .radio{border-color:#818cf8}
  .option.active .radio::after{
    content:'';width:10px;height:10px;border-radius:50%;background:#818cf8;
  }
  .opt-title{font-weight:600;font-size:15px;margin-bottom:2px}
  .opt-desc{font-size:13px;color:#94a3b8}
  .remote-config{display:none;margin-top:16px;flex-direction:column;gap:12px}
  .remote-config.show{display:flex}
  input{
    width:100%;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.15);
    background:rgba(255,255,255,.06);color:#e2e8f0;font-size:14px;outline:none;
    transition:border-color .2s;
  }
  input:focus{border-color:#818cf8}
  input::placeholder{color:#64748b}
  .actions{margin-top:20px;display:flex;gap:10px;justify-content:flex-end}
  button{
    padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600;
    cursor:pointer;border:none;transition:background .2s,opacity .2s;
  }
  button:disabled{opacity:.5;cursor:not-allowed}
  .btn-primary{background:#6366f1;color:#fff}
  .btn-primary:hover:not(:disabled){background:#5558e6}
  .btn-secondary{background:rgba(255,255,255,.08);color:#cbd5e1}
  .btn-secondary:hover:not(:disabled){background:rgba(255,255,255,.14)}
  .test-result{font-size:13px;margin-top:6px}
  .test-result.ok{color:#34d399}
  .test-result.err{color:#f87171}
  .error-banner{display:none;padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:13px;line-height:1.5}
  .error-banner.show{display:block}
  .error-banner.warn{background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.3);color:#fbbf24}
  .error-banner.err{background:rgba(248,113,113,.15);border:1px solid rgba(248,113,113,.3);color:#f87171}
  .pwd-wrap{position:relative;display:flex}
  .pwd-wrap input{flex:1;padding-right:40px}
  .pwd-toggle{position:absolute;right:2px;top:50%;transform:translateY(-50%);width:36px;height:36px;display:flex;align-items:center;justify-content:center;background:none;border:none;cursor:pointer;color:#64748b;font-size:16px;line-height:1;padding:0;border-radius:6px;transition:color .2s}
  .pwd-toggle:hover{color:#e2e8f0}
</style></head><body>
<div class="card">
  <h1>${t.title}</h1>
  <div id="error-banner" class="error-banner err"></div>
  <div id="opt-local" class="option active" onclick="selectMode('local')">
    <div class="radio"></div>
    <div>
      <div class="opt-title">${t.local}</div>
      <div class="opt-desc">${t.localDesc}</div>
    </div>
  </div>
  <div id="opt-remote" class="option" onclick="selectMode('remote')">
    <div class="radio"></div>
    <div>
      <div class="opt-title">${t.remote}</div>
      <div class="opt-desc">${t.remoteDesc}</div>
    </div>
  </div>
  <div id="remote-config" class="remote-config">
    <input id="remote-url" type="text" placeholder="${t.urlPlaceholder}">
    <div class="pwd-wrap">
      <input id="remote-token" type="password" placeholder="${t.tokenPlaceholder}">
      <button class="pwd-toggle" onclick="toggleTokenVisibility()" title="Show/hide token">
        <svg id="eye-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>
        <svg id="eye-off-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>
      </button>
    </div>
    <div style="display:flex;align-items:center;gap:12px">
      <button class="btn-secondary" onclick="testConnection()">${t.testBtn}</button>
      <span id="test-result" class="test-result"></span>
    </div>
  </div>
  <div class="actions">
    <button class="btn-secondary" onclick="window.electronAPI.quitApp()">${t.exitBtn}</button>
    <button class="btn-primary" id="btn-save" onclick="save()">${t.saveBtn}</button>
  </div>
</div>
<script>
  let mode = '${js(initialMode)}';
  (function() {
    if (mode === 'remote') {
      document.getElementById('opt-local').classList.remove('active');
      document.getElementById('opt-remote').classList.add('active');
      document.getElementById('remote-config').classList.add('show');
    }
    var urlEl = document.getElementById('remote-url');
    if ('${js(initialUrl)}') urlEl.value = '${js(initialUrl)}';
    var tokenEl = document.getElementById('remote-token');
    if ('${js(initialToken)}') tokenEl.value = '${js(initialToken)}';
    // Show error banner if there's an error message
    var errBanner = document.getElementById('error-banner');
    var errMsg = '${js(errorMessage).replace(/\\n/g, '<br>')}';
    if (errMsg) {
      errBanner.innerHTML = errMsg;
      errBanner.classList.add('show');
    }
  })();
  function toggleTokenVisibility() {
    var inp = document.getElementById('remote-token');
    var show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    document.getElementById('eye-icon').style.display = show ? 'none' : '';
    document.getElementById('eye-off-icon').style.display = show ? '' : 'none';
  }
  function selectMode(m) {
    mode = m;
    document.getElementById('opt-local').classList.toggle('active', m==='local');
    document.getElementById('opt-remote').classList.toggle('active', m==='remote');
    document.getElementById('remote-config').classList.toggle('show', m==='remote');
  }
  async function testConnection() {
    const rawUrl = document.getElementById('remote-url').value.replace(/\\/+$/,'');
    const token = document.getElementById('remote-token').value;
    const btn = event.target;
    const resultEl = document.getElementById('test-result');
    btn.disabled = true;
    btn.textContent = '${t.testing}';
    resultEl.textContent = '';
    resultEl.className = 'test-result';
    try {
      // Step 1: health check
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      var res = await fetch(rawUrl+'/api/health', {
        headers: token ? {Authorization:'Bearer '+token} : {},
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!res.ok) {
        resultEl.textContent = '${t.gatewayUnreachable}';
        resultEl.className = 'test-result err';
        return;
      }
      var v = '?';
      try { var d = await res.json(); v = d.version || '?'; } catch {}
      // Step 2: verify token (required for remote gateway)
      if (!token) {
        resultEl.textContent = '${t.serverOnlineTokenInvalid} (v'+v+')';
        resultEl.className = 'test-result err';
      } else {
        var ctrl2 = new AbortController();
        var t2 = setTimeout(function(){ ctrl2.abort(); }, 5000);
        try {
          var vres = await fetch(rawUrl+'/api/auth/verify', {
            headers: {Authorization:'Bearer '+token},
            signal: ctrl2.signal
          });
          clearTimeout(t2);
          if (vres.ok) {
            resultEl.textContent = '${t.connected} (v'+v+')';
            resultEl.className = 'test-result ok';
          } else {
            resultEl.textContent = '${t.serverOnlineTokenInvalid} (v'+v+')';
            resultEl.className = 'test-result err';
          }
        } catch(ve) {
          clearTimeout(t2);
          resultEl.textContent = '${t.serverOnlineTokenInvalid} (v'+v+')';
          resultEl.className = 'test-result err';
        }
      }
    } catch(e) {
      resultEl.textContent = '${t.gatewayUnreachable}';
      resultEl.className = 'test-result err';
    } finally {
      btn.disabled = false;
      btn.textContent = '${t.testBtn}';
    }
  }
  async function save() {
    const url = document.getElementById('remote-url').value.replace(/\\/+$/,'');
    const token = document.getElementById('remote-token').value;
    const btn = document.getElementById('btn-save');
    btn.disabled = true;
    try {
      await window.electronAPI.setGatewayConfig({ mode, remoteUrl: url, remoteToken: token });
      await window.electronAPI.setConfig('firstRunDone', true);
      // Make the main window pick up the new gateway config (Electron
      // relaunched the whole app here; a navigation is the equivalent).
      await window.electronAPI.reloadMainWindow();
    } catch (e) { console.error('save failed', e); }
    // Close through the compat layer: WebView2 only lets scripts close
    // their own child windows; the Rust command destroys the window cleanly.
    window.electronAPI.close();
  }
</script>
</body></html>`;
}
