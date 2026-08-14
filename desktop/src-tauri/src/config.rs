//! Shell configuration + mirror of the sidecar-owned `desktop-config.json`.
//!
//! The sidecar is the primary writer of `desktop-config.json` (the file lives at
//! the same path electron-store used — `%APPDATA%/OhMyAgent/desktop-config.json` —
//! so existing user config carries over unchanged). The shell reads the file at
//! startup and polls mtime once per second to react to `theme` / `language` /
//! `closeToTray` changes without a push channel.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;
use tauri::{AppHandle, Manager};

/// Paths the shell passes to the sidecar. Must match the Electron userData layout
/// exactly (`app.getPath('userData')`) so app.db / config.yaml / downloads survive.
#[derive(Clone, Debug)]
pub struct ShellConfig {
    /// `%APPDATA%/OhMyAgent` on Windows, `~/Library/Application Support/OhMyAgent` on macOS.
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub config_file: PathBuf,
    pub log_dir: PathBuf,
    pub server_port: u16,
    /// Root of the bundled sidecar (prod: `<resources>/sidecar`, dev: `<repo>/desktop/.sidecar-deps`).
    pub resources_dir: PathBuf,
    pub app_version: String,
}

impl ShellConfig {
    pub fn load(app: &AppHandle) -> Self {
        // Electron userData == dirs::data_dir()/OhMyAgent on both Windows and macOS.
        let data_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("OhMyAgent");
        let resources_dir = app
            .path()
            .resource_dir()
            .unwrap_or_default()
            .join("sidecar");
        let version = app.package_info().version.to_string();
        let server_port = std::env::var("OHMYAGENT_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(9191);

        ShellConfig {
            data_dir: data_dir.clone(),
            db_path: data_dir.join("data").join("app.db"),
            config_file: data_dir.join("config.yaml"),
            log_dir: data_dir.join("logs"),
            server_port,
            resources_dir,
            app_version: version,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GatewayConfig {
    pub mode: String,
    pub remote_url: String,
    pub remote_token: String,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        GatewayConfig {
            mode: "local".into(),
            remote_url: String::new(),
            remote_token: String::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopConfig {
    pub close_to_tray: bool,
    pub auto_start: bool,
    /// "system" | "light" | "dark"
    pub theme: String,
    pub language: Option<String>,
    pub first_run_done: bool,
    pub gateway: GatewayConfig,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        DesktopConfig {
            close_to_tray: true,
            auto_start: false,
            theme: "system".into(),
            language: None,
            first_run_done: false,
            gateway: GatewayConfig::default(),
        }
    }
}

impl DesktopConfig {
    pub fn is_remote(&self) -> bool {
        self.gateway.mode == "remote"
    }

    /// Read + parse the file; falls back to defaults when missing/corrupt.
    pub fn load(path: &std::path::Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => DesktopConfig::default(),
        }
    }

    /// Atomic write (tmp + rename) so the sidecar's watcher never sees a partial file.
    pub fn save(&self, path: &std::path::Path) -> std::io::Result<()> {
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }
}

/// State held by the shell: current config mirror + the file's last mtime.
pub struct ConfigMirror {
    pub cfg: DesktopConfig,
    last_mtime: Option<SystemTime>,
}

impl ConfigMirror {
    pub fn new(path: &std::path::Path) -> Self {
        let cfg = DesktopConfig::load(path);
        let last_mtime = std::fs::metadata(path).ok().and_then(|m| m.modified().ok());
        ConfigMirror { cfg, last_mtime }
    }
}

/// True when `closeToTray` was requested in the mirror.
pub static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

/// Poll the config file every second; on change, update the mirror and react
/// (window chrome theme, tray rebuild, close-to-tray flag).
pub async fn poll_config_loop(app: AppHandle) {
    let path = ShellConfig::load(&app).data_dir.join("desktop-config.json");
    let mut mirror = ConfigMirror::new(&path);

    // Grant once at startup, not only on change: the config can already be in
    // remote mode when the shell launches (persisted by a previous session),
    // so the mtime-change branch below would never fire — the remote page's
    // invoke calls would stay rejected, the WebUI would silently fall back to
    // local mode (empty main view + "加载配置失败" in settings).
    if mirror.cfg.is_remote() && !mirror.cfg.gateway.remote_url.is_empty() {
        grant_remote_origin(&app, mirror.cfg.gateway.remote_url.trim_end_matches('/'));
    }

    loop {
        let mtime = std::fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok());
        if mtime != mirror.last_mtime {
            let new_cfg = DesktopConfig::load(&path);
            let changed = new_cfg.theme != mirror.cfg.theme
                || new_cfg.language != mirror.cfg.language
                || new_cfg.close_to_tray != mirror.cfg.close_to_tray
                || new_cfg.is_remote() != mirror.cfg.is_remote();
            mirror.cfg = new_cfg;
            mirror.last_mtime = mtime;

            CLOSE_TO_TRAY.store(
                mirror.cfg.close_to_tray,
                Ordering::SeqCst,
            );

            if changed {
                crate::tray::rebuild(&app, &mirror.cfg);
                let _ = crate::windows::apply_theme(&app, &mirror.cfg.theme);
            }
            // Remote mode: grant the configured gateway origin IPC access at
            // runtime (its origin is unknown at build time).
            if mirror.cfg.is_remote() && !mirror.cfg.gateway.remote_url.is_empty() {
                grant_remote_origin(&app, mirror.cfg.gateway.remote_url.trim_end_matches('/'));
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}

/// Locate the desktop config file from the shell data dir.
pub fn config_path(app: &AppHandle) -> PathBuf {
    ShellConfig::load(app).data_dir.join("desktop-config.json")
}

/// Granted remote-origin capability ids. The startup grant and the
/// config-change grant can carry the same id — re-adding a capability is an
/// error in tauri, so dedupe here.
static GRANTED_REMOTE_ORIGINS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Grant a remote origin IPC access at runtime (tauri 2: capabilities with a
/// `remote.urls` section — the v1 `dangerousRemoteDomainIpcAccess` field no
/// longer exists in the config schema).
///
/// The permissions MUST mirror capabilities/default.json: tauri checks each
/// command's `allow-*` permission individually, so a capability carrying only
/// `core:default` lets the remote page match the scope yet still rejects every
/// compat_* invoke (silently — the command never runs). The compat layer's
/// getCtl then fails and the WebUI silently falls back to local mode.
fn grant_remote_origin(app: &AppHandle, origin: &str) {
    use tauri::ipc::CapabilityBuilder;
    use tauri::Manager;

    // Keep in sync with capabilities/default.json.
    const PERMISSIONS: [&str; 26] = [
        "core:default",
        "dialog:default",
        "opener:default",
        "notification:default",
        "autostart:allow-enable",
        "autostart:allow-disable",
        "autostart:allow-is-enabled",
        "allow-compat-get-app-version",
        "allow-compat-get-platform",
        "allow-compat-get-server-status",
        "allow-compat-get-control-info",
        "allow-compat-quit-app",
        "allow-compat-restart-service",
        "allow-compat-window-minimize",
        "allow-compat-window-maximize",
        "allow-compat-window-is-maximized",
        "allow-compat-window-close",
        "allow-compat-toggle-devtools",
        "allow-compat-open-data-dir",
        "allow-compat-open-config-file",
        "allow-compat-get-auto-start",
        "allow-compat-set-auto-start",
        "allow-compat-save-file-from-url",
        "allow-compat-save-local-file",
        "allow-compat-open-gateway-chooser",
        "allow-compat-reload-main-window",
    ];

    let id = format!("remote-gateway-{}", simple_hash(origin));
    {
        let mut granted = GRANTED_REMOTE_ORIGINS.lock().unwrap();
        if granted.contains(&id) {
            return; // already granted this origin
        }
        let mut cap = CapabilityBuilder::new(id.clone())
            .remote(origin.to_string())
            .local(false)
            .windows(["main".to_string()]);
        for p in PERMISSIONS {
            cap = cap.permission(p);
        }
        if let Err(e) = app.add_capability(cap) {
            log::error!("grant_remote_origin: add_capability failed for {origin}: {e}");
            return;
        }
        granted.insert(id);
    }
    log::info!("grant_remote_origin: granted {origin} ({} permissions)", PERMISSIONS.len());
}

/// Deterministic short hash for capability identifiers (no external crate).
fn simple_hash(s: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    format!("{:x}", h.finish())
}
