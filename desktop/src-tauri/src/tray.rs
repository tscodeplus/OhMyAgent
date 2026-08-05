//! System tray: status label, show/hide, restart service, open data/log dirs,
//! auto-start & close-to-tray checkboxes, check updates, restart, quit.
//!
//! Menu rebuild triggers: config file change (config.rs poll), sidecar status
//! change (sidecar.rs holder/health loops). Tauri has no "menu about to open"
//! event, so state is only as fresh as the last rebuild — 1s config poll keeps
//! it close enough for checkboxes and the status label.

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::config::{config_path, DesktopConfig};
use crate::sidecar::{take_snapshot, SidecarState, StatusKind};

const ID_TOGGLE: &str = "toggle-window";
const ID_STATUS: &str = "status";
const ID_RESTART_SERVICE: &str = "restart-service";
const ID_OPEN_DATA: &str = "open-data-dir";
const ID_OPEN_LOGS: &str = "open-log-dir";
const ID_AUTO_START: &str = "auto-start";
const ID_CLOSE_TO_TRAY: &str = "close-to-tray";
const ID_CHECK_UPDATES: &str = "check-updates";
const ID_RESTART_APP: &str = "restart-app";
const ID_QUIT: &str = "quit";

/// Create the tray icon with its initial menu.
pub fn create_tray(app: &AppHandle, cfg: &DesktopConfig) -> tauri::Result<()> {
    let menu = build_menu(app, cfg)?;
    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("OhMyAgent")
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        });

    // Prefer a 16px tray icon; fall back to the app icon.
    if let Some(icon) = load_tray_icon(app) {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

fn load_tray_icon(app: &AppHandle) -> Option<tauri::image::Image<'static>> {
    // Use the bundled app icon (16px would be nicer but the app icon is fine).
    app.default_window_icon().cloned().map(|i| i.to_owned())
}

fn build_menu(app: &AppHandle, cfg: &DesktopConfig) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;

    let status = MenuItem::with_id(app, ID_STATUS, status_label(app, cfg), false, None::<&str>)?;
    menu.append(&status)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    let toggle = MenuItem::with_id(app, ID_TOGGLE, "显示 / 隐藏窗口", true, None::<&str>)?;
    menu.append(&toggle)?;

    let restart = MenuItem::with_id(
        app,
        ID_RESTART_SERVICE,
        "重启服务",
        !cfg.is_remote(),
        None::<&str>,
    )?;
    menu.append(&restart)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;

    let open_data = MenuItem::with_id(app, ID_OPEN_DATA, "打开数据目录", true, None::<&str>)?;
    menu.append(&open_data)?;
    let open_logs = MenuItem::with_id(app, ID_OPEN_LOGS, "打开日志目录", true, None::<&str>)?;
    menu.append(&open_logs)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;

    let auto_start = CheckMenuItem::with_id(
        app,
        ID_AUTO_START,
        "开机自启动",
        true,
        cfg.auto_start,
        None::<&str>,
    )?;
    menu.append(&auto_start)?;
    let close_to_tray = CheckMenuItem::with_id(
        app,
        ID_CLOSE_TO_TRAY,
        "关闭时最小化到托盘",
        true,
        cfg.close_to_tray,
        None::<&str>,
    )?;
    menu.append(&close_to_tray)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;

    let check = MenuItem::with_id(app, ID_CHECK_UPDATES, "检查更新", true, None::<&str>)?;
    menu.append(&check)?;
    let restart_app = MenuItem::with_id(app, ID_RESTART_APP, "重启应用", true, None::<&str>)?;
    menu.append(&restart_app)?;
    let quit = MenuItem::with_id(app, ID_QUIT, "退出", true, None::<&str>)?;
    menu.append(&quit)?;

    Ok(menu)
}

fn status_label(app: &AppHandle, cfg: &DesktopConfig) -> String {
    if cfg.is_remote() {
        return format!("远程网关: {}", cfg.gateway.remote_url);
    }
    // The tray is created before sidecar::init manages the state — degrade
    // gracefully instead of panicking on state().
    let Some(state) = app.try_state::<std::sync::Arc<SidecarState>>() else {
        return "服务启动中…".into();
    };
    let snapshot = take_snapshot(&state);
    match snapshot.kind {
        StatusKind::Running => format!("服务运行中 · 端口 {}", snapshot.port),
        StatusKind::Starting => "服务启动中…".into(),
        StatusKind::Stopping => "服务停止中…".into(),
        StatusKind::Error => format!("服务异常: {}", snapshot.error.as_deref().unwrap_or("未知错误")),
        StatusKind::Stopped => "服务已停止".into(),
    }
}

/// Rebuild the tray menu (new config or sidecar status).
pub fn rebuild(app: &AppHandle, cfg: &DesktopConfig) {
    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(menu) = build_menu(app, cfg) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        ID_TOGGLE => toggle_main_window(app),
        ID_RESTART_SERVICE => crate::sidecar::restart(app),
        ID_OPEN_DATA => {
            let data_dir = crate::config::ShellConfig::load(app).data_dir;
            open_path(app, &data_dir);
        }
        ID_OPEN_LOGS => {
            let log_dir = crate::config::ShellConfig::load(app).log_dir;
            open_path(app, &log_dir);
        }
        ID_AUTO_START => toggle_auto_start(app),
        ID_CLOSE_TO_TRAY => toggle_close_to_tray(app),
        ID_CHECK_UPDATES => check_updates(app),
        ID_RESTART_APP => restart_app(app),
        ID_QUIT => quit_app(app),
        _ => {}
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(crate::windows::MAIN_LABEL) {
        if let Ok(visible) = win.is_visible() {
            if visible {
                let _ = win.hide();
            } else {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
    }
}

fn open_path(app: &AppHandle, path: &std::path::Path) {
    if let Some(parent) = path.parent() {
        if parent.exists() {
            let _ = tauri_plugin_opener::OpenerExt::opener(app)
                .open_path(parent.to_string_lossy().to_string(), None::<&str>);
        }
    }
}

fn toggle_auto_start(app: &AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    let path = config_path(app);
    let mut cfg = DesktopConfig::load(&path);
    let autolaunch = app.autolaunch();
    match autolaunch.is_enabled() {
        Ok(enabled) => {
            cfg.auto_start = !enabled;
            if cfg.auto_start {
                let _ = autolaunch.enable();
            } else {
                let _ = autolaunch.disable();
            }
            let _ = cfg.save(&path);
            rebuild(app, &cfg);
        }
        Err(_) => {
            // Plugin unavailable (e.g. macOS without the right flags): flip the
            // config anyway so the checkbox stays truthful.
            cfg.auto_start = !cfg.auto_start;
            let _ = cfg.save(&path);
            rebuild(app, &cfg);
        }
    }
}

fn toggle_close_to_tray(app: &AppHandle) {
    let path = config_path(app);
    let mut cfg = DesktopConfig::load(&path);
    cfg.close_to_tray = !cfg.close_to_tray;
    crate::config::CLOSE_TO_TRAY.store(cfg.close_to_tray, std::sync::atomic::Ordering::SeqCst);
    let _ = cfg.save(&path);
    rebuild(app, &cfg);
}

/// Ask the sidecar for a tray-style update check (spinner window + dialogs).
fn check_updates(app: &AppHandle) {
    let state = app.state::<std::sync::Arc<SidecarState>>();
    let snapshot = take_snapshot(&state);
    if snapshot.kind == StatusKind::Stopped {
        return;
    }
    let port = state.sidecar_api_port;
    let token = state.ctl_token.clone();
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).build();
        if let Ok(client) = client {
            let url = format!("http://127.0.0.1:{port}/_desktop/updater/check");
            let _ = client
                .post(&url)
                .bearer_auth(&token)
                .json(&serde_json::json!({ "includeBeta": false, "fromTray": true }))
                .send()
                .await;
        }
    });
}

fn restart_app(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::sidecar::shutdown(&app).await;
        if let Ok(exe) = std::env::current_exe() {
            let _ = std::process::Command::new(exe).spawn();
        }
        app.exit(0);
    });
}

fn quit_app(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::sidecar::shutdown(&app).await;
        app.exit(0);
    });
}
