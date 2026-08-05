// Gateway chooser HTML — ported from desktop/src/main.ts:createGatewayChooserHtml.
// Rendered by the sidecar so it can use the server's i18n; window.close() is
// replaced by window.electronAPI.close() (WebView2 only allows script-closing
// its own child windows, so we go through the compat layer).

import type { DesktopConfig } from './config.js';

export interface ChooserOptions {
  error?: string;
  initialUrl?: string;
  initialToken?: string;
}

export function renderChooser(
  cfg: DesktopConfig,
  opts: ChooserOptions = {},
): string {
  const lang = cfg.language ?? 'zh-CN';
  const t = (zh: string, en: string): string => (lang === 'zh-CN' ? zh : en);

  const errorHtml = opts.error
    ? `<div class="error">${escapeHtml(opts.error)}</div>`
    : '';
  const initialUrl = opts.initialUrl ?? cfg.gateway.remoteUrl;
  const initialToken = opts.initialToken ?? cfg.gateway.remoteToken;

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<style>
  body { margin:0; padding:26px 28px; font-family: system-ui, -apple-system, sans-serif;
         background:#14141f; color:#e6e6f0; }
  h2 { margin:0 0 6px; font-size:17px; }
  p  { margin:0 0 18px; font-size:13px; color:#9aa0b5; line-height:1.6; }
  label { display:block; font-size:12px; color:#b8bccb; margin:12px 0 4px; }
  input { width:100%; box-sizing:border-box; padding:9px 11px; border-radius:6px;
          border:1px solid #2c2c3a; background:#0e0e16; color:#e6e6f0; font-size:13px; }
  .row { display:flex; gap:10px; margin-top:18px; }
  button { flex:1; padding:9px 0; border:none; border-radius:6px; font-size:13px;
           cursor:pointer; }
  #save { background:#4f8cff; color:#fff; }
  #cancel { background:#26263a; color:#b8bccb; }
  .error { background:#3a1d24; border:1px solid #6b2b38; color:#ff9c9c;
           padding:9px 12px; border-radius:6px; font-size:12px; margin:14px 0 0; }
  .status { font-size:12px; color:#7fd08c; margin-top:10px; min-height:16px; }
</style>
</head>
<body>
  <h2>${t('连接网关', 'Connect Gateway')}</h2>
  <p>${t(
    '选择本地模式将在此电脑上运行内置服务；远程模式连接已在其他设备运行的 OhMyAgent。',
    'Local mode runs the built-in service on this computer; remote mode connects to an OhMyAgent instance running elsewhere.',
  )}</p>
  ${errorHtml}
  <label><input type="radio" name="mode" value="local" id="modeLocal" checked> ${t('本地模式', 'Local mode')}</label>
  <label><input type="radio" name="mode" value="remote" id="modeRemote"> ${t('远程模式', 'Remote mode')}</label>

  <div id="remoteFields" style="display:none">
    <label>${t('远程网关地址', 'Remote gateway URL')}</label>
    <input id="remoteUrl" placeholder="http://192.168.1.100:9191" value="${escapeAttr(initialUrl)}">
    <label>${t('访问令牌（可选）', 'Access token (optional)')}</label>
    <input id="remoteToken" placeholder="${t('留空则无需鉴权', 'leave empty if no auth')}" value="${escapeAttr(initialToken)}">
    <div class="status" id="status"></div>
  </div>

  <div class="row">
    <button id="save">${t('保存', 'Save')}</button>
    <button id="cancel">${t('取消', 'Cancel')}</button>
  </div>

<script>
  const modeLocal = document.getElementById('modeLocal');
  const modeRemote = document.getElementById('modeRemote');
  const remoteFields = document.getElementById('remoteFields');
  const status = document.getElementById('status');
  const api = window.electronAPI;

  function syncMode() {
    remoteFields.style.display = modeRemote.checked ? 'block' : 'none';
  }
  modeLocal.addEventListener('change', syncMode);
  modeRemote.addEventListener('change', syncMode);
  syncMode();

  async function testConnection(url) {
    if (!url) return true;
    status.textContent = '${t('测试连接中…', 'Testing connection…')}';
    try {
      const r = await fetch(url.replace(/\\/$/, '') + '/api/health', { timeout: 8000 });
      return r.ok;
    } catch {
      return false;
    }
  }

  document.getElementById('save').addEventListener('click', async () => {
    const config = { mode: modeRemote.checked ? 'remote' : 'local' };
    if (modeRemote.checked) {
      const url = document.getElementById('remoteUrl').value.trim();
      if (!url) { status.textContent = '${t('请输入远程网关地址', 'Please enter the remote URL')}'; return; }
      if (!(await testConnection(url))) {
        status.textContent = '${t('无法连接该地址，请检查后重试', 'Cannot reach that URL, please check')}';
        return;
      }
      config.remoteUrl = url;
      config.remoteToken = document.getElementById('remoteToken').value.trim();
    }
    await api.setGatewayConfig(config);
    await api.setConfig('firstRunDone', true);
    window.electronAPI.close();
  });

  document.getElementById('cancel').addEventListener('click', () => {
    window.electronAPI.close();
  });
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
