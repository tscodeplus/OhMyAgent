// electronAPI compat layer — injected into every WebviewWindow via Tauri's
// initialization_script. Mirrors the old Electron preload API surface
// (desktop/src/preload.ts) so ui/src stays untouched:
//   · native capabilities  → invoke('compat_*') Rust commands
//   · logic / network      → sidecar control API (fetch + SSE)
//
// Dev fallback: when the Rust-provided control info is unreachable, probe the
// fixed dev port 9291 (pnpm dev:sidecar). Remote-gateway pages get the same
// layer; everything still goes through 127.0.0.1 control endpoints.
(function () {
  if (window.__omaCompatInstalled) return;
  window.__omaCompatInstalled = true;

  const invoke = window.__TAURI_INTERNALS__.invoke;
  let ctlPromise = null; // { baseUrl, token } — in-flight probe, not a cache

  // The page loads before the sidecar's control API binds its port, so the
  // first probe legitimately fails. Never cache that failure: null must be
  // retried on the next call, or every later ctlFetch (check updates, config
  // save, bridge) would fail for the whole session — "无法连接 GitHub".
  async function getCtl() {
    if (ctlPromise) return ctlPromise;
    ctlPromise = (async () => {
      try {
        const info = await invoke('compat_get_control_info');
        if (await probe(info.base_url, info.token)) {
          return { baseUrl: info.base_url, token: info.token };
        }
      } catch (e) { /* fall through to dev probe */ }
      try {
        if (await probe('http://127.0.0.1:9291', 'dev')) {
          return { baseUrl: 'http://127.0.0.1:9291', token: 'dev' };
        }
      } catch (e) { /* no control api at all */ }
      return null;
    })();
    const result = await ctlPromise;
    if (!result) ctlPromise = null; // failure is transient — retry next call
    return result;
  }

  async function probe(baseUrl, token) {
    try {
      const r = await fetch(baseUrl + '/_desktop/ping', {
        headers: { Authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(2000),
      });
      return r.ok;
    } catch (e) {
      return false;
    }
  }

  async function ctlFetch(path, options) {
    options = options || {};
    const c = await getCtl();
    if (!c) throw new Error('control api unavailable');
    const headers = { Authorization: 'Bearer ' + c.token };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(c.baseUrl + path, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).error || msg; } catch (e) { /* keep statusText */ }
      throw new Error(msg);
    }
    if (r.status === 204) return null;
    const ct = r.headers.get('content-type') || '';
    return ct.includes('application/json') ? r.json() : r.text();
  }

  // ---- updater SSE events → callback dispatch ------------------------------
  const UPDATE_EVENTS = [
    'update-available',
    'update-not-available',
    'update-downloaded',
    'update-error',
    'update-download-progress',
  ];
  const listeners = {};
  UPDATE_EVENTS.forEach((t) => (listeners[t] = []));
  let sseStarted = false;

  function ensureSSE() {
    if (sseStarted) return;
    sseStarted = true;
    getCtl().then((c) => {
      if (!c) {
        // Control API not up yet (page loads before the sidecar binds).
        // Reset the flag so a later onUpdate* registration can retry —
        // otherwise update events would be lost for the whole session.
        sseStarted = false;
        return;
      }
      const es = new EventSource(
        c.baseUrl + '/_desktop/events?token=' + encodeURIComponent(c.token)
      );
      UPDATE_EVENTS.forEach((type) => {
        es.addEventListener(type, (e) => {
          let payload;
          try { payload = JSON.parse(e.data); } catch (err) { payload = e.data; }
          listeners[type].forEach((cb) => { try { cb(payload); } catch (err) {} });
        });
      });
      es.onerror = () => { /* EventSource auto-reconnects */ };
    });
  }

  function onUpdate(type, cb) {
    ensureSSE();
    if (listeners[type]) listeners[type].push(cb);
  }

  // ---- electronAPI surface -------------------------------------------------
  window.electronAPI = {
    // window control
    minimize: () => invoke('compat_window_minimize'),
    maximize: () => invoke('compat_window_maximize'),
    close: () => invoke('compat_window_close'),

    // server
    getServerStatus: () => invoke('compat_get_server_status'),
    restartService: () => invoke('compat_restart_service'),

    // desktop config (sidecar-owned JSON)
    getConfig: (key) => ctlFetch('/_desktop/config?key=' + encodeURIComponent(key)),
    setConfig: (key, value) => ctlFetch('/_desktop/config', {
      method: 'PUT',
      body: { key, value },
    }),
    openConfigFile: () => invoke('compat_open_config_file'),
    openDataDir: () => invoke('compat_open_data_dir'),

    // auto start
    getAutoStart: () => invoke('compat_get_auto_start'),
    setAutoStart: (enable) => invoke('compat_set_auto_start', { enable }),

    // updater
    checkForUpdates: (includeBeta) => ctlFetch('/_desktop/updater/check', {
      method: 'POST',
      body: { includeBeta: !!includeBeta },
    }),
    downloadUpdate: () => ctlFetch('/_desktop/updater/download', { method: 'POST' }),
    installUpdate: () => ctlFetch('/_desktop/updater/install', { method: 'POST' }),
    cancelDownload: () => ctlFetch('/_desktop/updater/cancel', { method: 'POST' }),
    onUpdateAvailable: (cb) => onUpdate('update-available', cb),
    onUpdateDownloaded: (cb) => onUpdate('update-downloaded', cb),
    onUpdateNotAvailable: (cb) => onUpdate('update-not-available', cb),
    onUpdateError: (cb) => onUpdate('update-error', cb),
    onUpdateDownloadProgress: (cb) => onUpdate('update-download-progress', cb),
    removeUpdateListeners: () => UPDATE_EVENTS.forEach((t) => (listeners[t] = [])),

    // gateway config
    getGatewayConfig: () => ctlFetch('/_desktop/gateway-config'),
    setGatewayConfig: (config) => ctlFetch('/_desktop/gateway-config', {
      method: 'PUT',
      body: config,
    }),
    resetGatewayConfig: () => ctlFetch('/_desktop/gateway-config', {
      method: 'PUT',
      body: { mode: 'local', remoteUrl: '', remoteToken: '' },
    }),

    // gateway chooser (remote-connection retry) — error shown in the chooser
    openGatewayChooser: (error) => invoke('compat_open_gateway_chooser', { error }),
    // after the chooser saves a new gateway config, reload the WebUI so it
    // re-reads mode/url/token (Electron relaunched the app there)
    reloadMainWindow: () => invoke('compat_reload_main_window'),

    // lifecycle
    quitApp: () => invoke('compat_quit_app'),

    // desktop bridge (remote mode)
    bridgeRegisterSession: (sessionId) => ctlFetch(
      '/_desktop/bridge/session/' + encodeURIComponent(sessionId),
      { method: 'POST' }
    ),
    bridgeUnregisterSession: (sessionId) => ctlFetch(
      '/_desktop/bridge/session/' + encodeURIComponent(sessionId),
      { method: 'DELETE' }
    ),
    getBridgeStatus: () => ctlFetch('/_desktop/bridge/status'),

    // files
    saveFileFromUrl: (url, filename) => invoke('compat_save_file_from_url', {
      url,
      filename,
    }),
    saveLocalFile: (filePath, fileName) => invoke('compat_save_local_file', {
      filePath,
      fileName,
    }),

    // language
    setDesktopLanguage: (lang) => ctlFetch('/_desktop/language', {
      method: 'PUT',
      body: { lang },
    }),

    // info
    getAppVersion: () => invoke('compat_get_app_version'),
    getPlatform: () => invoke('compat_get_platform'),
    getUserDataPath: () => ctlFetch('/_desktop/user-data-path').then((d) => d.path),
  };

  // ---- image hover-download (port of Electron main.ts setupImageHoverDownload)
  function installImageHover() {
    if (!document.body || window.__omaHoverInstalled) return;
    window.__omaHoverInstalled = true;
    const MIN_SIZE = 40;

    function filenameFromUrl(url) {
      try {
        const u = new URL(url, location.href);
        const q = u.searchParams.get('path');
        if (q) return q.split('/').pop() || 'download';
        const p = u.pathname.split('/').pop();
        return p && p.length > 1 ? p : 'download';
      } catch (e) {
        return 'download';
      }
    }

    function wrap(img) {
      if (img.dataset.omaHover === '1') return;
      img.dataset.omaHover = '1';
      const btn = document.createElement('button');
      btn.textContent = '下载';
      btn.type = 'button';
      btn.style.cssText =
        'position:absolute;right:6px;bottom:6px;display:none;padding:3px 10px;' +
        'border:none;border-radius:4px;background:rgba(0,0,0,.72);color:#fff;' +
        'font-size:12px;cursor:pointer;z-index:10;';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const url = img.currentSrc || img.src;
        window.electronAPI
          .saveFileFromUrl(url, filenameFromUrl(url))
          .catch(() => {});
      });
      const box = document.createElement('div');
      box.style.cssText = 'position:relative;display:inline-block;max-width:100%;';
      box.addEventListener('mouseenter', () => (btn.style.display = 'block'));
      box.addEventListener('mouseleave', () => (btn.style.display = 'none'));
      img.parentNode.insertBefore(box, img);
      box.appendChild(img);
      box.appendChild(btn);
    }

    function scan() {
      document.querySelectorAll('img').forEach((img) => {
        const w = img.naturalWidth || img.width;
        if (w < MIN_SIZE) return;
        wrap(img);
      });
    }

    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true });
    scan();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installImageHover);
  } else {
    installImageHover();
  }
})();
