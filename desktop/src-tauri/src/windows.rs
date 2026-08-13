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

/// WebUI URL for the main window. In remote-gateway mode the page must load
/// from the *remote* server: ui's apiRequest uses relative paths, so the page
/// origin IS the API base. Loading the embedded server's WebUI while in remote
/// mode makes AuthContext validate the remote token against the local gateway
/// (/api/auth/verify → 401) → spurious "连接失败" page. `cache_bust` appends a
/// `_ts` query param so a navigate after config changes isn't served from the
/// webview cache.
pub fn webui_url(app: &AppHandle, cache_bust: bool) -> String {
    let cfg = DesktopConfig::load(&config_path(app));
    let base = if cfg.is_remote() && !cfg.gateway.remote_url.is_empty() {
        cfg.gateway.remote_url.trim_end_matches('/').to_string()
    } else {
        let port = ShellConfig::load(app).server_port;
        format!("http://127.0.0.1:{port}")
    };
    if cache_bust {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!("{base}/webui/?electron=1&_ts={ts}")
    } else {
        format!("{base}/webui/?electron=1")
    }
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
    let url = WebviewUrl::External(
        webui_url(app, false)
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

/// 64×64 window icon — the Windows title bar / taskbar renders at 16-48px
/// (32-96px at high DPI), and the 32px source this replaced got upscaled on
/// 125%/150% displays. macOS ignores it (no title-bar icon there); the Dock
/// uses the packaged .icns.
fn window_icon() -> tauri::image::Image<'static> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/icon-64.png"))
        .expect("icon-64.png embedded")
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
    // The page is a static resource (pages/splash.html) loaded over the App
    // URL — data: URLs are unreliable on WKWebView (charset detection, and
    // plain-text rendering of the payload — wry dropped native data: URL
    // support in 0.37). The label is localized in-page from
    // navigator.language.
    WebviewWindowBuilder::new(
        app,
        SPLASH_LABEL,
        WebviewUrl::App("pages/splash.html".into()),
    )
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
    // Fallback reveal: on_page_load's Finished event rides WebView2's
    // NavigationCompleted, which is not reliable for data: URLs in a hidden
    // window — if it never fires, the splash would stay invisible forever.
    // Reveal after a short grace period instead (idempotent if the page-load
    // path already showed it; a no-op if the splash was already closed as the
    // main window appeared).
    {
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            if let Some(splash) = app2.get_webview_window(SPLASH_LABEL) {
                let _ = splash.show();
            }
        });
    }
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
///
/// An existing window may sit on a stale WebUI URL — e.g. the user switched
/// local ↔ remote gateway and restarted the service, but the window kept
/// loading the embedded server's WebUI. Re-navigate when the target URL
/// differs so the page origin follows the active gateway (compare without
/// the cache-busting `_ts`).
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
    let target = webui_url(app, true);
    if let Some(win) = app.get_webview_window(MAIN_LABEL) {
        let current = win
            .url()
            .map(|u| u.to_string())
            .unwrap_or_default()
            .split('?')
            .next()
            .unwrap_or_default()
            .to_string();
        let target_base = target.split('?').next().unwrap_or_default().to_string();
        if current != target_base {
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(win) = app2.get_webview_window(MAIN_LABEL) {
                    if let Err(e) = win.navigate(target.parse().expect("webui url")) {
                        log::error!("windows: reveal_main_window navigate failed: {e}");
                    }
                }
            });
        }
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
        // Splash's job is done; a leftover error window (service died, then
        // recovered via the restart button) is dismissed too.
        close_splash(app);
        if let Some(err_win) = app.get_webview_window(ERROR_LABEL) {
            let _ = err_win.close();
        }
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
///
/// The chooser's save can land mid-service-restart, when the local server is
/// briefly down — navigating then would stick the main window on a white
/// connection-refused page. Wait for /api/health (bounded) before acting.
pub fn reload_main_window(app: &AppHandle) {
    let app2 = app.clone();
    let server_port = ShellConfig::load(&app2).server_port;
    tauri::async_runtime::spawn(async move {
        let Ok(client) = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()
        else {
            return;
        };
        // The embedded server answers this in both modes (it always runs);
        // remote-mode reloads additionally depend on pre-flight already having
        // passed (reveal_main_window) — navigate only to a known-healthy target.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let ok = client
                .get(format!("http://127.0.0.1:{server_port}/api/health"))
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false);
            if ok || std::time::Instant::now() > deadline {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
        let app3 = app2.clone();
        let url = webui_url(&app3, true);
        // Remote mode: pre-flight the configured gateway before navigating, so
        // a wrong URL/token saved in the chooser surfaces the chooser again
        // (with its error banner) instead of a dead connection-refused page
        // with no recovery path — mirror of Electron's relaunch-then-prefight.
        let cfg = DesktopConfig::load(&config_path(&app3));
        if cfg.is_remote() && !cfg.gateway.remote_url.is_empty() {
            let remote_url = cfg.gateway.remote_url.clone();
            let remote_token = cfg.gateway.remote_token.clone();
            match crate::sidecar::check_remote_health(&remote_url, &remote_token).await {
                crate::sidecar::RemoteHealth::Ok => {}
                bad => {
                    let key = match bad {
                        crate::sidecar::RemoteHealth::Unreachable => "gatewayUnreachable",
                        _ => "serverOnlineTokenInvalid",
                    };
                    log::warn!("windows: reload pre-flight {key} ({remote_url})");
                    crate::sidecar::show_remote_chooser(&app3, key);
                    return;
                }
            }
        }
        let _ = app2.run_on_main_thread(move || {
            if let Some(win) = app3.get_webview_window(MAIN_LABEL) {
                if let Err(e) = win.navigate(url.parse().expect("webui url")) {
                    log::error!("windows: reload_main_window navigate failed: {e}");
                }
                let _ = win.show();
                let _ = win.set_focus();
            } else {
                if let Err(e) = create_main_window(&app3) {
                    log::error!("windows: create_main_window failed: {e}");
                    return;
                }
                show_main_window(&app3);
            }
        });
    });
}

/// Frameless error window with a message, a restart button and a dismiss
/// button. The compat layer is injected so the buttons go through
/// `compat_window_close` / `compat_restart_service`: on a data: URL page
/// `window.close()` is a no-op (browsers only honor it for script-opened
/// windows), which left an unclosable window behind.
pub fn show_error_window(app: &AppHandle, message: &str) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(ERROR_LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let zh = crate::i18n::is_zh(app);
    let title = crate::i18n::tr("服务异常", "Service Error", zh);
    let restart_label = crate::i18n::tr("重启服务", "Restart Service", zh);
    let ok_label = crate::i18n::tr("确定", "OK", zh);
    // The page is a static resource (pages/error.html); the runtime message
    // and labels ride in via an initialization script as JSON (rendered with
    // textContent — no HTML injection surface). data: URLs are unreliable on
    // WKWebView, so the page loads over the App URL instead.
    let payload = serde_json::json!({
        "title": title,
        "msg": message,
        "restart": restart_label,
        "ok": ok_label,
    });
    let init = format!("{}\nwindow.__OMA_ERR__ = {};", compat_script(), payload);
    WebviewWindowBuilder::new(
        app,
        ERROR_LABEL,
        WebviewUrl::App("pages/error.html".into()),
    )
        .title("OhMyAgent")
        .inner_size(400.0, 250.0)
        .resizable(false)
        .decorations(false)
        .center()
        .initialization_script(init)
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
        log::info!("windows: show_chooser_window → existing window");
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    log::info!("windows: show_chooser_window creating (base {base_url})");
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

/// True when no gateway configuration exists yet — the first-run wizard must
/// appear instead of the main window (mirror of the Electron main.ts check:
/// `!firstRunDone && mode === 'local' && !remoteUrl` → showGatewayChooser).
pub fn is_first_run(app: &AppHandle) -> bool {
    use crate::config::{config_path, DesktopConfig};
    let cfg = DesktopConfig::load(&config_path(app));
    !cfg.first_run_done && !cfg.is_remote()
}

/// First-run flow: when no gateway is configured yet (firstRunDone == false,
/// local mode, no remote URL), show the chooser window loading the sidecar
/// control API page. Called once the gateway is healthy. The main window is
/// NOT shown on first run — the chooser's save triggers reloadMainWindow,
/// which creates it (Electron relaunched the whole app after saving; a
/// create+show is the equivalent), so the user only ever sees one window.
pub async fn maybe_show_chooser(app: AppHandle) {
    if !is_first_run(&app) {
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
        if let Err(e) = show_chooser_window(
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
        ) {
            log::error!("windows: maybe_show_chooser failed: {e}");
            return;
        }
        // With the main window deferred, the splash has no other consumer in
        // the first-run path — dismiss it once the wizard is on screen.
        close_splash(&app2);
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
    let zh = crate::i18n::is_zh(app);
    WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::External(url.parse().expect("updater page url")),
    )
    .title(crate::i18n::tr("OhMyAgent 更新", "OhMyAgent Update", zh))
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
        // macOS: 'system' must NOT pin the window appearance. Pinning forced
        // the WKWebView's prefers-color-scheme to that pinned value (in the
        // old code "system" resolved to Light on macOS, so a dark OS showed
        // a light WebUI and matchMedia never tracked the OS). Passing None
        // sets NSAppearance to nil → the WebView follows the OS appearance
        // and its prefers-color-scheme updates live. Explicit light/dark
        // still pin the appearance so the title bar matches the choice.
        #[cfg(target_os = "macos")]
        {
            let forced = match theme {
                "light" => Some(tauri::Theme::Light),
                "dark" => Some(tauri::Theme::Dark),
                _ => None,
            };
            win.set_theme(forced)?;
        }
        // Other non-Windows platforms (Linux): pin the computed theme;
        // set_theme is a no-op there and the background color above is what
        // matters.
        #[cfg(all(not(windows), not(target_os = "macos")))]
        win.set_theme(Some(if dark {
            tauri::Theme::Dark
        } else {
            tauri::Theme::Light
        }))?;
    }
    Ok(())
}

/// Windows 11 (22000+): paint the native title bar to match the UI theme —
/// dark mode gets the UI's `#0a0a0a` background + white text; light mode gets
/// the default Win11 light caption (fixed #F0F0F0 + black text — not
/// GetSysColor: with "accent color on title bars" enabled the system color is
/// the user's accent, which can be dark, and was observed leaving the caption
/// black-on-black). Windows 10 ignores the DWMWA_CAPTION_COLOR/TEXT_COLOR
/// attributes (returns an error we swallow); DWMWA_USE_IMMERSIVE_DARK_MODE
/// still works there so the caption at least follows the OS dark theme.
#[cfg(windows)]
fn set_caption_theme(win: &tauri::WebviewWindow, dark: bool) {
    use std::mem::size_of;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
        DWMWA_USE_IMMERSIVE_DARK_MODE,
    };

    let Ok(hwnd) = win.hwnd() else {
        return;
    };
    let hwnd = hwnd.0;
    unsafe {
        // COLORREF layout is 0x00BBGGRR.
        let bg: u32 = if dark {
            0x000A_0A0A
        } else {
            0x00F0_F0F0
        };
        let fg: u32 = if dark {
            0x00FF_FFFF
        } else {
            0x0000_0000
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

/// OS-level dark preference: macOS reads the global interface style
/// (`defaults read -g AppleInterfaceStyle` → "Dark" when the OS is in dark
/// mode; works without any TCC permission and tracks Auto appearance). Other
/// non-Windows platforms default to false.
#[cfg(target_os = "macos")]
fn system_dark() -> bool {
    std::process::Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .trim()
                .eq_ignore_ascii_case("dark")
        })
        .unwrap_or(false)
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn system_dark() -> bool {
    false
}

