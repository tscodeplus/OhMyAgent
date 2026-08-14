//! compat_* commands — the Rust side of the injected `window.electronAPI`
//! compat layer (compat.js). Anything needing native capability (dialogs,
//! window control, opener, autostart, process lifecycle) lives here; pure
//! logic/network (updater, config, bridge, language) is served by the sidecar's
//! control API and reached by the compat layer directly.

use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::config::{config_path, DesktopConfig, ShellConfig};
use crate::sidecar::{SidecarState, StatusKind};

// ---------------------------------------------------------------------------
// Info
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn compat_get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn compat_get_platform() -> String {
    std::env::consts::OS.to_string()
}

#[derive(serde::Serialize)]
pub struct ServerStatus {
    pub running: bool,
    pub port: u16,
}

#[tauri::command]
pub fn compat_get_server_status(app: AppHandle) -> ServerStatus {
    let state = app.state::<Arc<SidecarState>>();
    let snapshot = crate::sidecar::take_snapshot(&state);
    ServerStatus {
        running: matches!(snapshot.kind, StatusKind::Running | StatusKind::Starting),
        port: snapshot.port,
    }
}

/// Info the compat layer needs to reach the sidecar's control API.
#[derive(serde::Serialize)]
pub struct ControlInfo {
    pub base_url: String,
    pub token: String,
}

#[tauri::command]
pub fn compat_get_control_info(app: AppHandle) -> Result<ControlInfo, String> {
    let state = app.state::<Arc<SidecarState>>();
    let port = state.sidecar_api_port.load(std::sync::atomic::Ordering::SeqCst);
    log::info!("compat_get_control_info → :{port}");
    Ok(ControlInfo {
        base_url: format!("http://127.0.0.1:{port}"),
        token: state.ctl_token.clone(),
    })
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn compat_quit_app(app: AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::sidecar::shutdown(&app).await;
        app.exit(0);
    });
}

/// "Restart service": stop the sidecar and respawn it (dev: relaunch the shell).
///
/// Returns `{ok: true}` immediately — the shutdown+respawn runs in the
/// background and its failures surface via the error window / tray state.
/// The WebUI checks `result?.ok` (env.ts restartService signature), so an
/// empty response made every restart report "保存失败" even though it ran.
#[derive(serde::Serialize)]
pub struct RestartResult {
    pub ok: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub fn compat_restart_service(app: AppHandle) -> RestartResult {
    crate::sidecar::restart(&app);
    RestartResult {
        ok: true,
        error: None,
    }
}

// ---------------------------------------------------------------------------
// Gateway chooser (remote-connection retry) + main-window reload
// ---------------------------------------------------------------------------

/// Open the gateway chooser window prefilled with the current remote
/// URL/token. Invoked by the ConnectionErrorPage "重新配置网关" button so a
/// failed remote connection can be retried with corrected credentials without
/// restarting the app.
#[tauri::command]
pub fn compat_open_gateway_chooser(app: AppHandle, error: Option<String>) {
    let state = app.state::<Arc<SidecarState>>();
    let port = state.sidecar_api_port.load(std::sync::atomic::Ordering::SeqCst);
    if port == 0 {
        log::warn!("compat_open_gateway_chooser: control API not up yet");
        return;
    }
    let base_url = format!("http://127.0.0.1:{port}");
    let ctl_token = state.ctl_token.clone();
    let cfg = DesktopConfig::load(&config_path(&app));
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        // Right after a service restart the control API is briefly down (the
        // old sidecar is dead, the new one still binding); opening the
        // chooser now would leave it stuck on a white connection-refused
        // page. Probe /ping with a short retry before creating the window.
        let Ok(client) = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
        else {
            return;
        };
        let mut alive = false;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let ok = client
                .get(format!("{base_url}/_desktop/ping"))
                .bearer_auth(&ctl_token)
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false);
            if ok {
                alive = true;
                break;
            }
            if std::time::Instant::now() > deadline {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
        if !alive {
            log::warn!("compat_open_gateway_chooser: control API never became reachable — not opening chooser");
            return;
        }
        let app3 = app2.clone();
        let _ = app2.run_on_main_thread(move || {
            let opts = crate::windows::ChooserOptions {
                error: error.as_deref(),
                initial_url: Some(&cfg.gateway.remote_url),
                initial_token: Some(&cfg.gateway.remote_token),
            };
            let _ = crate::windows::show_chooser_window(
                &app3,
                &base_url,
                &ctl_token,
                560,
                620,
                opts,
            );
        });
    });
}

/// Reload the main window so the WebUI re-reads the gateway config — the
/// chooser's save path (Electron relaunched the whole app there).
#[tauri::command]
pub fn compat_reload_main_window(app: AppHandle) {
    crate::windows::reload_main_window(&app);
}

// ---------------------------------------------------------------------------
// Window control (also used by the gateway chooser's own HTML)
// ---------------------------------------------------------------------------

fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(crate::windows::MAIN_LABEL)
}

#[tauri::command]
pub fn compat_window_minimize(app: AppHandle) -> Result<(), String> {
    main_window(&app)
        .ok_or_else(|| "no main window".to_string())?
        .minimize()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn compat_window_maximize(app: AppHandle) -> Result<(), String> {
    let win = main_window(&app).ok_or_else(|| "no main window".to_string())?;
    // Toggle: the frameless caption's maximize button doubles as restore.
    if win.is_maximized().unwrap_or(false) {
        win.unmaximize().map_err(|e| e.to_string())?;
    } else {
        win.maximize().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Current maximized state, so the caption button can show maximize/restore.
#[tauri::command]
pub fn compat_window_is_maximized(app: AppHandle) -> Result<bool, String> {
    let win = main_window(&app).ok_or_else(|| "no main window".to_string())?;
    win.is_maximized().map_err(|e| e.to_string())
}

/// Close the *current* window (the one that invoked it — e.g. the chooser).
#[tauri::command]
pub fn compat_window_close(_app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn compat_toggle_devtools(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Paths / opener
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn compat_open_data_dir(app: AppHandle) -> Result<(), String> {
    // Real data (app.db, downloads, …) lives in `<userData>/data`.
    let dir = ShellConfig::load(&app).data_dir.join("data");
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn compat_open_config_file(app: AppHandle) -> Result<(), String> {
    let path = ShellConfig::load(&app).config_file;
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_path(path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Auto start
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn compat_get_auto_start(app: AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn compat_set_auto_start(app: AppHandle, enable: bool) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    if enable {
        autolaunch.enable().map_err(|e| e.to_string())?;
    } else {
        autolaunch.disable().map_err(|e| e.to_string())?;
    }
    // Keep the config file as the single source of truth for the tray checkbox.
    let path = config_path(&app);
    let mut cfg = DesktopConfig::load(&path);
    cfg.auto_start = enable;
    let _ = cfg.save(&path);
    Ok(())
}

// ---------------------------------------------------------------------------
// Save dialogs (port of main.ts save-file-from-url / save-local-file)
// ---------------------------------------------------------------------------

/// data: URL → decode; http(s) URL → resolve base then download; then a native
/// save dialog. Returns the chosen path (empty string when cancelled).
#[tauri::command]
pub fn compat_save_file_from_url(
    app: AppHandle,
    url: String,
    filename: String,
) -> Result<String, String> {
    let bytes: Vec<u8> = if let Some(rest) = url.strip_prefix("data:") {
        decode_data_url(rest).map_err(|e| e.to_string())?
    } else if url.starts_with("http://") || url.starts_with("https://") {
        download_bytes(&url).map_err(|e| e.to_string())?
    } else {
        // Relative URL — resolve against local gateway or the remote base.
        let cfg = DesktopConfig::load(&config_path(&app));
        let base = if cfg.is_remote() {
            cfg.gateway.remote_url.trim_end_matches('/').to_string()
        } else {
            let port = ShellConfig::load(&app).server_port;
            format!("http://127.0.0.1:{port}")
        };
        let full = format!("{base}/{url}", base = base, url = url.trim_start_matches('/'));
        download_bytes(&full).map_err(|e| e.to_string())?
    };

    let Some(path) = save_dialog(&app, &filename) else {
        return Ok(String::new()); // cancelled
    };
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Read a local file (validated) and offer a save-as dialog.
#[tauri::command]
pub fn compat_save_local_file(
    app: AppHandle,
    file_path: String,
    file_name: String,
) -> Result<String, String> {
    let src = std::path::PathBuf::from(&file_path);
    if !src.is_file() {
        let zh = crate::i18n::is_zh(&app);
        return Err(format!(
            "{}: {file_path}",
            crate::i18n::tr("文件不存在或不可读", "File does not exist or is unreadable", zh)
        ));
    }
    let Some(dst) = save_dialog(&app, &file_name) else {
        return Ok(String::new()); // cancelled
    };
    std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().to_string())
}

fn decode_data_url(rest: &str) -> Result<Vec<u8>, String> {
    // rest = "<media-type>;base64,<data>" or "<media-type>,<urlencoded>"
    let (meta, data) = rest.split_once(',').ok_or("invalid data URL")?;
    if meta.contains(";base64") {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        STANDARD.decode(data.trim()).map_err(|e| e.to_string())
    } else {
        // Percent-decoded text data.
        Ok(url_unescape(data).into_bytes())
    }
}

fn url_unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Ok(h), Ok(l)) = (
                hex_val(bytes[i + 1]),
                hex_val(bytes[i + 2]),
            ) {
                out.push((h << 4 | l) as char);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn hex_val(b: u8) -> Result<u8, ()> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        _ => Err(()),
    }
}

fn download_bytes(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    client
        .get(url)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .map(|b| b.to_vec())
        .map_err(|e| e.to_string())
}

/// Native save dialog; None when the user cancels.
fn save_dialog(app: &AppHandle, suggested_name: &str) -> Option<std::path::PathBuf> {
    let picked = app
        .dialog()
        .file()
        .set_file_name(suggested_name)
        .blocking_save_file();
    match picked {
        Some(FilePath::Path(p)) => Some(p),
        Some(FilePath::Url(u)) => Some(u.to_file_path().ok()?),
        None => None,
    }
}
