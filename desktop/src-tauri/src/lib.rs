// OhMyAgent Desktop — Tauri shell around the OhMyAgent Node gateway (sidecar).
//
// Shell responsibilities (mirroring the former Electron main process):
//   · spawn / supervise the Node sidecar (see sidecar.rs)
//   · windows: splash, main WebUI window, gateway chooser, updater dialogs (windows.rs)
//   · system tray (tray.rs)
//   · desktop-config.json mirror + theme/language/closeToTray reactions (config.rs)
//   · tiny_http control service receiving pushes from the sidecar (ctl_server.rs)
//   · compat_* commands exposed to the injected electronAPI compat layer (commands.rs)
//
// The `src/**` server and `ui/**` frontend are untouched; the WebUI page is served
// by the sidecar and loaded via http://127.0.0.1:9191/webui/?electron=1.

use tauri::Manager;

mod commands;
mod config;
mod ctl_server;
mod i18n;
mod log_file;
mod sidecar;
mod tray;
mod windows;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus the main window on second-instance launch.
            if let Some(win) = app.get_webview_window(windows::MAIN_LABEL) {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            commands::compat_get_app_version,
            commands::compat_get_platform,
            commands::compat_quit_app,
            commands::compat_restart_service,
            commands::compat_get_server_status,
            commands::compat_get_control_info,
            commands::compat_save_file_from_url,
            commands::compat_save_local_file,
            commands::compat_window_minimize,
            commands::compat_window_maximize,
            commands::compat_window_is_maximized,
            commands::compat_window_close,
            commands::compat_open_data_dir,
            commands::compat_open_config_file,
            commands::compat_get_auto_start,
            commands::compat_set_auto_start,
            commands::compat_toggle_devtools,
            commands::compat_open_gateway_chooser,
            commands::compat_reload_main_window,
        ])
        // Close-to-tray: intercept the main window's close request.
        .on_window_event(|window, event| {
            if window.label() == windows::MAIN_LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if config::CLOSE_TO_TRAY.load(std::sync::atomic::Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // File logger first: everything below (tray, sidecar, windows)
            // logs into <userData>/logs/shell.log — GUI apps have no stderr.
            let shell_log = config::ShellConfig::load(&handle).log_dir.join("shell.log");
            let _ = log_file::init(&shell_log);
            // Read the shell config mirror (userData/desktop-config.json).
            let cfg = config::DesktopConfig::load(&config::config_path(&handle));
            config::CLOSE_TO_TRAY.store(cfg.close_to_tray, std::sync::atomic::Ordering::SeqCst);
            let _ = windows::apply_theme(&handle, &cfg.theme);

            // Tray + splash first, then the sidecar supervision stack. The
            // main window is NOT created here — it is built lazily by
            // reveal_main_window once the sidecar answers /api/health, so its
            // first navigation never hits a not-yet-listening server.
            let _ = tray::create_tray(&handle, &cfg);
            let _ = windows::create_splash(&handle);

            tauri::async_runtime::spawn(async move {
                sidecar::init(&handle).await;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
