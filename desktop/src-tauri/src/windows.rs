//! Window family: splash, main WebUI window (declared in tauri.conf.json),
//! gateway chooser, updater dialogs, and the error window. Theme chrome
//! reactions live here too.

use std::sync::Arc;

use tauri::webview::PageLoadEvent;
use tauri::WebviewUrl;
use tauri::{AppHandle, Manager, WebviewWindowBuilder};

use crate::config::{config_path, DesktopConfig, ShellConfig};
use crate::sidecar::SidecarState;

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
/// initialization_script. Hidden until the gateway is healthy; the window is
/// *created lazily* once the sidecar answers /api/health (reveal_main_window)
/// so the WebView's first navigation never hits a not-yet-listening server
/// (an early load would leave the webview stuck on the ERR_CONNECTION_REFUSED
/// error page).
///
/// Note: uses the native system title bar for now — the Electron shell's
/// frameless + titleBarOverlay look was a cosmetic optimization that Tauri
/// only supports for config-declared windows; revisit with a self-drawn
/// caption (WebUI drag region + compat window buttons) in a later iteration.
pub fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let compat_js = include_str!("../../sidecar/src/compat.js");
    let port = ShellConfig::load(app).server_port;
    let url = WebviewUrl::External(
        format!("http://127.0.0.1:{port}/webui/?electron=1")
            .parse::<tauri::Url>()
            .expect("static url"),
    );
    WebviewWindowBuilder::new(app, MAIN_LABEL, url)
        .title("OhMyAgent")
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .visible(false)
        .background_color(tauri::window::Color::from((10, 10, 10)))
        .icon(window_icon())?
        .initialization_script(compat_js)
        .build()?;
    Ok(())
}

/// 32×32 window icon — the Windows title bar (16px at 100% DPI, 32px at 200%)
/// downscales this far better than the 512px app icon. macOS ignores it (no
/// title-bar icon there); the Dock uses the packaged .icns.
fn window_icon() -> tauri::image::Image<'static> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/icon-32.png"))
        .expect("icon-32.png embedded")
}

/// Splash shown while the sidecar boots. Same look as the Electron splash.
///
/// Created hidden and shown on page-load-Finished: a visible window before the
/// webview paints shows the default white background for a frame (the
/// transparent layer does not apply until the HTML renders), which reads as a
/// white flash on startup.
pub fn create_splash(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window(SPLASH_LABEL).is_some() {
        return Ok(());
    }
    // Same look as the Electron splash (desktop/src/main.ts:createSplashHtml):
    // indigo gradient, frosted logo tile with spinner, rounded corners.
    let html = r#"<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    height:100vh;display:flex;flex-direction:column;align-items:center;
    justify-content:center;padding-top:18px;
    background:linear-gradient(135deg,#6366f1,#4f46e5);
    color:#fff;user-select:none;-webkit-user-select:none;
    border-radius:12px;overflow:hidden;
  }
  .logo{width:52px;height:52px;margin-bottom:20px;background:rgba(255,255,255,.15);border-radius:14px;display:flex;align-items:center;justify-content:center}
  .spin-o{width:28px;height:28px;border:3.5px solid rgba(255,255,255,.2);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite}
  .text{font-size:17px;font-weight:600;letter-spacing:1px;text-align:center;padding:0 24px;opacity:.9}
  @keyframes spin{to{transform:rotate(360deg)}}
</style></head><body>
  <div class="logo"><div class="spin-o"></div></div>
  <div class="text">OhMyAgent 启动中…</div>
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
        .visible(false)
        .on_page_load(|win, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = win.show();
            }
        })
        .build()?;
    Ok(())
}

/// The compat layer is injected on every window built in code (the gateway
/// chooser's own HTML uses window.electronAPI).
fn compat_script() -> &'static str {
    include_str!("../../sidecar/src/compat.js")
}

/// Reveal the main window once the sidecar answers /api/health. The window is
/// created lazily on first reveal (never at shell setup — see
/// create_main_window) so the first navigation lands on a live server.
///
/// Creating a window requires the main thread; the show/focus half is
/// thread-safe and runs inline for the already-created case (restart flows).
pub fn reveal_main_window(app: &AppHandle) {
    if app.get_webview_window(MAIN_LABEL).is_none() {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Err(e) = create_main_window(&app2) {
                log::error!("windows: create_main_window failed: {e}");
                return;
            }
            show_main_window(&app2);
        });
        return;
    }
    show_main_window(app);
}

/// Show + maximize + focus the main window, apply the current theme chrome
/// (DWM caption colors, background — needed on the freshly created window
/// since setup's apply_theme ran before it existed), then close the splash.
fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN_LABEL) {
        let cfg = DesktopConfig::load(&config_path(app));
        let _ = apply_theme(app, &cfg.theme);
        let _ = win.show();
        let _ = win.maximize();
        let _ = win.set_focus();
        // Splash's job is done.
        close_splash(app);
    }
}

pub fn close_splash(app: &AppHandle) {
    if let Some(splash) = app.get_webview_window(SPLASH_LABEL) {
        let _ = splash.close();
    }
}

/// Reload the main window so the WebUI re-reads the gateway config — the
/// chooser's "save" path (Electron relaunched the app there; the sidecar stays
/// alive here, so a navigation is the equivalent). Creates + reveals the
/// window when it does not exist yet (first run: chooser before reveal).
pub fn reload_main_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window(MAIN_LABEL) else {
        reveal_main_window(app);
        return;
    };
    let port = ShellConfig::load(app).server_port;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let url = format!("http://127.0.0.1:{port}/webui/?electron=1&_ts={ts}");
    let _ = win.navigate(url.parse().expect("webui url"));
    let _ = win.show();
    let _ = win.set_focus();
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

/// Extra state for the chooser page: an error banner (remote pre-flight
/// failure) and prefilled URL/token. Carried as query params on the window
/// URL; the sidecar's control API route reads them back.
pub struct ChooserOptions<'a> {
    pub error: Option<&'a str>,
    pub initial_url: Option<&'a str>,
    pub initial_token: Option<&'a str>,
}

/// Gateway chooser (first run / remote failure). The window loads the HTML
/// straight from the sidecar control API (`/_desktop/gateway-chooser`) so the
/// page origin is http://127.0.0.1:{control_port} — data: URLs have an opaque
/// origin that the remote-domain ACL rejects, which would break the chooser's
/// window.electronAPI invokes (save / close / quit).
pub fn show_chooser_window(
    app: &AppHandle,
    base_url: &str,
    token: &str,
    width: u32,
    height: u32,
    opts: ChooserOptions<'_>,
) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(CHOOSER_LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let mut url = format!("{base_url}/_desktop/gateway-chooser?token={token}");
    if let Some(e) = opts.error {
        url.push_str(&format!("&err={}", url_escape(e)));
    }
    if let Some(u) = opts.initial_url {
        url.push_str(&format!("&url={}", url_escape(u)));
    }
    if let Some(t) = opts.initial_token {
        url.push_str(&format!("&rt={}", url_escape(t)));
    }
    WebviewWindowBuilder::new(
        app,
        CHOOSER_LABEL,
        WebviewUrl::External(url.parse().expect("chooser url")),
    )
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
/// local mode, no remote URL), show the chooser window loading the sidecar
/// control API page. Called once the gateway is healthy.
pub async fn maybe_show_chooser(app: AppHandle) {
    use crate::config::{config_path, DesktopConfig};

    let cfg = DesktopConfig::load(&config_path(&app));
    if cfg.first_run_done || cfg.is_remote() {
        return;
    }
    if app.get_webview_window(CHOOSER_LABEL).is_some() {
        return; // already showing
    }

    let state = app.state::<Arc<SidecarState>>();
    let port = state.sidecar_api_port.load(std::sync::atomic::Ordering::SeqCst);
    if port == 0 {
        return; // control API not up yet
    }
    let base_url = format!("http://127.0.0.1:{port}");
    let token = state.ctl_token.clone();

    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = show_chooser_window(
            &app2,
            &base_url,
            &token,
            560,
            620,
            ChooserOptions {
                error: None,
                initial_url: None,
                initial_token: None,
            },
        );
    });
}

/// Updater dialogs pushed by the sidecar via POST /show-window.
/// `kind` selects the window label; an existing window is only shown again
/// (content updates come from the HTML's own polling of the control API).
///
/// The window loads http://127.0.0.1:{control_port}/_desktop/pages/updater/{kind}
/// (HTML cached by the sidecar's control server) instead of an embedded
/// data: URL — see show_chooser_window for why data: URLs can't invoke.
pub fn show_dialog_window(
    app: &AppHandle,
    kind: &str,
    width: u32,
    height: u32,
    dark: bool,
) -> tauri::Result<()> {
    // Distinct labels per kind: a window is only *shown* if its label already
    // exists, so sharing one label (spinner + result) would freeze the dialog
    // on the first HTML forever.
    let label = match kind {
        "progress" => PROGRESS_LABEL,
        "spinner" => "updater-spinner",
        _ => "updater-dialog",
    };
    log::info!("windows: show_dialog_window kind={kind} → label={label}");
    // A result window replaces the transient spinner.
    if label != "updater-spinner" {
        if let Some(spin) = app.get_webview_window("updater-spinner") {
            let _ = spin.close();
        }
    }
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let state = app.state::<Arc<SidecarState>>();
    let port = state.sidecar_api_port.load(std::sync::atomic::Ordering::SeqCst);
    let token = state.ctl_token.clone();
    let url = format!(
        "http://127.0.0.1:{port}/_desktop/pages/updater/{kind}?token={token}"
    );
    WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::External(url.parse().expect("updater page url")),
    )
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

/// Apply the configured theme to the main window chrome: window background
/// (prevents white flash while the page paints) and, on Windows, the native
/// title-bar colors (DWM) so dark mode blends with the UI's dark background
/// instead of staying on the OS light caption.
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
        #[cfg(windows)]
        set_caption_theme(&win, dark);
    }
    Ok(())
}

/// Windows 11 (22000+): paint the native title bar to match the UI theme —
/// dark mode gets the UI's `#0a0a0a` background + white text; light mode
/// restores the system default caption colors. Windows 10 ignores the
/// DWMWA_CAPTION_COLOR/TEXT_COLOR attributes (returns an error we swallow);
/// DWMWA_USE_IMMERSIVE_DARK_MODE still works there so the caption at least
/// follows the OS dark theme.
#[cfg(windows)]
fn set_caption_theme(win: &tauri::WebviewWindow, dark: bool) {
    use std::mem::size_of;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
        DWMWA_USE_IMMERSIVE_DARK_MODE,
    };
    use windows_sys::Win32::Graphics::Gdi::{GetSysColor, COLOR_CAPTIONTEXT};

    // COLOR_CAPTION (1) is not exported by windows-sys 0.59; it is a stable
    // system-color index (GetSysColor takes SYS_COLOR_INDEX = i32).
    const COLOR_CAPTION: i32 = 1;

    let Ok(hwnd) = win.hwnd() else {
        return;
    };
    let hwnd = hwnd.0;
    unsafe {
        // COLORREF layout is 0x00BBGGRR.
        let bg: u32 = if dark {
            0x000A_0A0A
        } else {
            GetSysColor(COLOR_CAPTION)
        };
        let fg: u32 = if dark {
            0x00FF_FFFF
        } else {
            GetSysColor(COLOR_CAPTIONTEXT)
        };
        let dark_mode: i32 = i32::from(dark);
        // All three calls are best-effort; failures (e.g. Win10 attributes)
        // leave the system default in place.
        // windows-sys exports the attributes as i32; the DWM API wants u32.
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
            &dark_mode as *const i32 as *const _,
            size_of::<i32>() as u32,
        );
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_CAPTION_COLOR as u32,
            &bg as *const u32 as *const _,
            size_of::<u32>() as u32,
        );
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_TEXT_COLOR as u32,
            &fg as *const u32 as *const _,
            size_of::<u32>() as u32,
        );
    }
}

/// OS-level dark preference: Windows reads AppsUseLightTheme from the
/// Personalize registry key (0 → dark); other platforms default to false.
#[cfg(windows)]
fn system_dark() -> bool {
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD,
    };

    let key: Vec<u16> = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let name: Vec<u16> = "AppsUseLightTheme"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut value: u32 = 0;
    let mut size: u32 = size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            &mut value as *mut u32 as *mut _,
            &mut size,
        )
    };
    status == 0 && value == 0
}

#[cfg(not(windows))]
fn system_dark() -> bool {
    false
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
