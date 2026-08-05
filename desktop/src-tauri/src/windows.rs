//! Window family: splash, main WebUI window (declared in tauri.conf.json),
//! gateway chooser, updater dialogs, and the error window. Theme chrome
//! reactions live here too.

use tauri::WebviewUrl;
use tauri::{AppHandle, Manager, WebviewWindowBuilder};

pub const MAIN_LABEL: &str = "main";
pub const SPLASH_LABEL: &str = "splash";
pub const CHOOSER_LABEL: &str = "gateway-chooser";
pub const ERROR_LABEL: &str = "error";
pub const PROGRESS_LABEL: &str = "updater-progress";

fn data_url(html: &str) -> WebviewUrl {
    let encoded = url_escape(html);
    WebviewUrl::External(
        format!("data:text/html;charset=utf-8,{encoded}")
            .parse()
            .unwrap_or_else(|_| "about:blank".parse().unwrap()),
    )
}

/// Percent-encode everything except a small safe set (encodeURIComponent-ish).
fn url_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~'
            | b'*' | b'\'' | b'(' | b')' | b' ' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Main window — built in code (not tauri.conf.json) so the electronAPI compat
/// layer (compat.js) and the image hover-download injection can be attached via
/// initialization_script. Hidden until the gateway is healthy.
pub fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let compat_js = include_str!("../../sidecar/src/compat.js");
    let url = WebviewUrl::External(
        "http://127.0.0.1:9191/webui/?electron=1"
            .parse::<tauri::Url>()
            .expect("static url"),
    );
    let builder = WebviewWindowBuilder::new(app, MAIN_LABEL, url)
        .title("OhMyAgent")
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .decorations(false)
        .visible(false)
        .background_color(tauri::window::Color::from((10, 10, 10)))
        .initialization_script(compat_js);

    // Windows 11 title bar overlay (deep-color variant; the WebUI CSS handles
    // the visible theme, this only affects the native caption area).
    #[cfg(target_os = "windows")]
    {
        let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay);
        builder.build()?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        builder.build()?;
    }
    Ok(())
}

/// Splash shown while the sidecar boots. Same look as the Electron splash.
pub fn create_splash(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window(SPLASH_LABEL).is_some() {
        return Ok(());
    }
    let html = r#"<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
       background:linear-gradient(135deg,#0a0a0a,#1a1a2e);overflow:hidden;font-family:system-ui}
  .spinner{width:36px;height:36px;border:3px solid rgba(255,255,255,.15);border-top-color:#4f8cff;
       border-radius:50%;animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  p{color:#9aa0b5;font-size:13px;margin-top:14px}
</style></head><body>
<div style="text-align:center"><div class="spinner"></div><p>OhMyAgent 启动中…</p></div>
</body></html>"#;
    WebviewWindowBuilder::new(app, SPLASH_LABEL, data_url(html))
        .title("OhMyAgent")
        .inner_size(340.0, 240.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .build()?;
    Ok(())
}

/// The compat layer is injected on every window built in code (the gateway
/// chooser's own HTML uses window.electronAPI).
fn compat_script() -> &'static str {
    include_str!("../../sidecar/src/compat.js")
}

/// Main window is declared in tauri.conf.json (hidden until the gateway is
/// healthy). Reveal it once the sidecar answers /api/health.
pub fn reveal_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN_LABEL) {
        let _ = win.show();
        let _ = win.maximize();
        let _ = win.set_focus();
        // Splash's job is done.
        if let Some(splash) = app.get_webview_window(SPLASH_LABEL) {
            let _ = splash.close();
        }
    }
}

/// Frameless error window with a message and a dismiss button.
pub fn show_error_window(app: &AppHandle, message: &str) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(ERROR_LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let html = format!(
        r#"<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body{{margin:0;padding:28px;font-family:system-ui;background:#14141f;color:#e6e6f0}}
  h3{{margin:0 0 10px;font-size:15px;color:#ff7b7b}}
  p{{font-size:13px;line-height:1.6;color:#b8bccb}}
  button{{margin-top:18px;padding:7px 22px;border:none;border-radius:6px;background:#4f8cff;
       color:#fff;font-size:13px;cursor:pointer}}
</style></head><body>
<h3>服务异常</h3><p>{msg}</p>
<button onclick="window.close()">确定</button>
</body></html>"#,
        msg = escape_html(message)
    );
    WebviewWindowBuilder::new(app, ERROR_LABEL, data_url(&html))
        .title("OhMyAgent")
        .inner_size(360.0, 240.0)
        .resizable(false)
        .decorations(false)
        .center()
        .build()?;
    Ok(())
}

/// Gateway chooser (first run / remote failure). HTML comes from the sidecar
/// (`/_desktop/gateway-chooser`) so it can use the server i18n.
pub fn show_chooser_window(
    app: &AppHandle,
    html: &str,
    width: u32,
    height: u32,
) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(CHOOSER_LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, CHOOSER_LABEL, data_url(html))
        .title("OhMyAgent")
        .inner_size(width as f64, height as f64)
        .resizable(false)
        .decorations(false)
        .center()
        .initialization_script(compat_script())
        .build()?;
    Ok(())
}

/// First-run flow: when no gateway is configured yet (firstRunDone == false,
/// local mode, no remote URL), fetch the chooser HTML from the sidecar control
/// API and show the chooser window. Called once the gateway is healthy.
pub async fn maybe_show_chooser(app: AppHandle) {
    use crate::config::{config_path, DesktopConfig};
    use crate::sidecar::SidecarState;
    use std::sync::Arc;

    let cfg = DesktopConfig::load(&config_path(&app));
    if cfg.first_run_done || cfg.is_remote() {
        return;
    }
    if app.get_webview_window(CHOOSER_LABEL).is_some() {
        return; // already showing
    }

    let state = app.state::<Arc<SidecarState>>();
    let port = state.sidecar_api_port;
    let token = state.ctl_token.clone();

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    let url = format!("http://127.0.0.1:{port}/_desktop/gateway-chooser");
    let html = match client.get(&url).bearer_auth(&token).send().await {
        Ok(r) if r.status().is_success() => match r.text().await {
            Ok(t) => t,
            Err(_) => return,
        },
        _ => return,
    };

    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = show_chooser_window(&app2, &html, 560, 620);
    });
}

/// Updater dialogs pushed by the sidecar via POST /show-window.
/// `kind` selects the window label; an existing window is only shown again
/// (content updates come from the HTML's own polling of the control API).
pub fn show_dialog_window(
    app: &AppHandle,
    kind: &str,
    html: &str,
    width: u32,
    height: u32,
    dark: bool,
) -> tauri::Result<()> {
    let label = match kind {
        "progress" => PROGRESS_LABEL,
        _ => "updater-dialog",
    };
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, label, data_url(html))
        .title("OhMyAgent 更新")
        .inner_size(width as f64, height as f64)
        .resizable(false)
        .decorations(false)
        .background_color(tauri::window::Color::from((20, 20, 31)))
        .center()
        .initialization_script(compat_script())
        .build()?;
    let _ = dark;
    Ok(())
}

/// Apply the configured theme to the main window chrome (background color
/// prevents white flash; the page's own CSS handles the visible theme).
pub fn apply_theme(app: &AppHandle, theme: &str) -> tauri::Result<()> {
    let dark = match theme {
        "light" => false,
        "dark" => true,
        _ => system_dark(),
    };
    let color = if dark {
        tauri::window::Color::from((10, 10, 10))
    } else {
        tauri::window::Color::from((255, 255, 255))
    };
    if let Some(win) = app.get_webview_window(MAIN_LABEL) {
        win.set_background_color(Some(color))?;
    }
    Ok(())
}

fn system_dark() -> bool {
    // Best effort: follow the OS-level dark preference where exposed.
    // WebView2 page CSS handles the real theme; this only sets the native
    // window background used before the page paints.
    false
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
