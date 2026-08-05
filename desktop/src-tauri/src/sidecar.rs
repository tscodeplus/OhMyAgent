//! Sidecar supervision — spawn the bundled Node runtime running the gateway,
//! health-poll it, forward its output to `logs/sidecar.log`, and clean up on exit.
//!
//! Lifecycle (the main behavioral difference vs. Electron, where the server ran
//! in-process):
//!   · spawn:  `node.exe index.js` with cwd = server-dist (bootstrap resolves
//!             relative paths from process.cwd()), all OHMYAGENT_* env injected
//!   · health: poll GET /api/health every 500ms (8s request timeout); up to 60s
//!             to become healthy at startup; 5 consecutive failures while
//!             running → error state
//!   · exit:   graceful POST /_desktop/shutdown → wait 2s → taskkill /T /F
//!   · anti-orphan: the sidecar self-exits after 3 missed heartbeats to the
//!             shell's control service (Rust dying cannot leave it alive)
//!
//! Ownership model: the `Child` handle lives in a single "holder" task that
//! forwards stdout/stderr and reaps it; the shared state only stores the pid,
//! so shutdown/restart can kill by pid without contending on the handle.
//!
//! Dev mode (debug_assertions): the sidecar is started by `beforeDevCommand`
//! (`pnpm dev:sidecar`, tsx watch) so hot reload works; the shell only polls
//! health and never spawns/kills.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::{Notify, RwLock};
use tokio::time::{sleep, Duration};

use crate::config::{config_path, DesktopConfig, ShellConfig};

const POLL_INTERVAL: Duration = Duration::from_millis(500);
const HTTP_TIMEOUT: Duration = Duration::from_secs(8);
const STARTUP_WINDOW: Duration = Duration::from_secs(60);
const MAX_CONSECUTIVE_FAILURES: u32 = 5;
const GRACEFUL_EXIT_WAIT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum StatusKind {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error,
}

#[derive(Clone, Serialize, Debug)]
pub struct SidecarStatus {
    pub kind: StatusKind,
    pub port: u16,
    pub error: Option<String>,
}

/// Shared, thread-safe shell-side state about the sidecar process.
pub struct SidecarState {
    pub status: RwLock<SidecarStatus>,
    pub pid: RwLock<Option<u32>>,
    /// Fired once when shutdown is requested, so the holder task kills the tree.
    pub kill_notify: Notify,
    /// Port of the shell's control service (env to the sidecar as OMA_DESKTOP_CONTROL_PORT).
    pub ctl_port: u16,
    pub ctl_token: String,
    /// Port the sidecar's control API listens on (reserved here, env
    /// OMA_SIDECAR_CONTROL_PORT). Exposed to the compat layer via
    /// `compat_get_control_info`.
    pub sidecar_api_port: u16,
}

impl SidecarState {
    pub async fn snapshot(&self) -> SidecarStatus {
        self.status.read().await.clone()
    }

    pub async fn set_kind(&self, kind: StatusKind) {
        self.status.write().await.kind = kind;
    }

    pub async fn set_error(&self, error: String) {
        let mut s = self.status.write().await;
        s.kind = StatusKind::Error;
        s.error = Some(error);
    }
}

/// Synchronous snapshot for blocking contexts (tray menu events).
pub fn take_snapshot(state: &SidecarState) -> SidecarStatus {
    tauri::async_runtime::block_on(state.status.read()).clone()
}

/// Entry point: build state, start the control server, (spawn|probe) the
/// sidecar, then hand the process to a holder task and launch the health loop.
/// Returns once everything is scheduled; the health loop runs for the shell's
/// lifetime in its own task.
pub async fn init(app: &AppHandle) {
    let cfg = ShellConfig::load(app);
    let server_port = cfg.server_port;

    let ctl_token = uuid::Uuid::new_v4().to_string();
    let ctl_port = crate::ctl_server::start(app.clone(), ctl_token.clone());
    let sidecar_api_port = reserve_port();

    let state = Arc::new(SidecarState {
        status: RwLock::new(SidecarStatus {
            kind: StatusKind::Starting,
            port: server_port,
            error: None,
        }),
        pid: RwLock::new(None),
        kill_notify: Notify::new(),
        ctl_port,
        ctl_token,
        sidecar_api_port,
    });
    app.manage(state.clone());

    if cfg!(debug_assertions) {
        log::info!("sidecar: dev mode — beforeDevCommand sidecar expected on :{server_port}");
    } else {
        match spawn_sidecar(&cfg, &state) {
            Ok(child) => {
                let pid = child.id().unwrap_or(0);
                log::info!("sidecar: spawned node pid={pid}");
                *state.pid.write().await = Some(pid);
                spawn_holder(app.clone(), state.clone(), child);
            }
            Err(e) => {
                log::error!("sidecar: spawn failed: {e}");
                state.set_error(format!("无法启动后端服务: {e}")).await;
            }
        }
    }

    // Health loop + config mirror poll run for the whole shell lifetime.
    let app2 = app.clone();
    let state2 = state.clone();
    tauri::async_runtime::spawn(async move {
        health_loop(app2, state2, server_port).await;
    });
    tauri::async_runtime::spawn(crate::config::poll_config_loop(app.clone()));
}

/// Owner of the spawned Child: forwards stdout/stderr to sidecar.log, reaps the
/// process, kills the tree on shutdown, and flips state to error on surprise
/// death (unless a shutdown was requested).
fn spawn_holder(app: AppHandle, state: Arc<SidecarState>, mut child: tokio::process::Child) {
    let log_path = ShellConfig::load(&app).log_dir.join("sidecar.log");

    if let Some(stdout) = child.stdout.take() {
        let p = log_path.clone();
        tauri::async_runtime::spawn(async move {
            forward_output(stdout, p).await;
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let p = log_path.clone();
        tauri::async_runtime::spawn(async move {
            forward_output(stderr, p).await;
        });
    }

    let pid = child.id().unwrap_or(0);
    let app2 = app.clone();
    let state2 = state.clone();
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            status = child.wait() => {
                log::info!("sidecar: process exited ({status:?})");
                // Distinguish expected shutdown from crash.
                let kind = state2.snapshot().await.kind;
                if kind != StatusKind::Stopping {
                    state2.set_error("后端服务进程意外退出".into()).await;
                    let _ = crate::windows::show_error_window(
                        &app2,
                        "后端服务已停止运行。请通过托盘菜单「重启服务」重新启动。",
                    );
                } else {
                    state2.set_kind(StatusKind::Stopped).await;
                }
            }
            _ = state2.kill_notify.notified() => {
                log::info!("sidecar: kill requested (pid={pid}), killing process tree");
                let _ = kill_process_tree(pid);
                let _ = child.wait().await;
                state2.set_kind(StatusKind::Stopped).await;
            }
        }
        crate::tray::rebuild(&app2, &DesktopConfig::load(&config_path(&app2)));
    });
}

/// Windows: tauri's resource_dir() returns `\\?\`-prefixed (verbatim) paths
/// which Node cannot resolve (EISDIR on the drive letter). Strip the prefix
/// before handing paths to the sidecar.
fn strip_verbatim(p: &std::path::Path) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return std::path::PathBuf::from(rest);
        }
    }
    p.to_path_buf()
}

fn spawn_sidecar(
    cfg: &ShellConfig,
    state: &Arc<SidecarState>,
) -> std::io::Result<tokio::process::Child> {
    let sidecar_dir = strip_verbatim(&cfg.resources_dir);
    let node = if cfg!(windows) {
        sidecar_dir.join("node.exe")
    } else {
        sidecar_dir.join("node")
    };
    let server_dist = sidecar_dir.join("server-dist");
    let webui_dist = sidecar_dir.join("webui-dist");
    // All paths handed to the sidecar must be verbatim-free (Node chokes on
    // `\\?\` prefixes).
    let data_dir = strip_verbatim(&cfg.data_dir);
    let db_path = strip_verbatim(&cfg.db_path);
    let config_file = strip_verbatim(&cfg.config_file);
    let log_dir = strip_verbatim(&cfg.log_dir);
    let locale = os_locale();

    let mut cmd = tokio::process::Command::new(node);
    // Entry must be a *relative* path with cwd = the sidecar root: Node 24 on
    // Windows mishandles an absolute entry path when the cwd differs (EISDIR
    // on the drive letter). index.js itself chdirs to server-dist, which is
    // where bootstrap expects to run.
    cmd.arg("index.js")
        .current_dir(&sidecar_dir)
        .env("OHMYAGENT_HOME", &data_dir)
        .env("OHMYAGENT_PORT", cfg.server_port.to_string())
        .env("OHMYAGENT_BIND_ADDRESS", "127.0.0.1")
        .env("DATABASE_PATH", &db_path)
        .env("CONFIG_FILE", &config_file)
        .env("OHMYAGENT_LOG_DIR", &log_dir)
        // 保留原名：服务器 src/ 依赖 ELECTRON_RUN=1 关闭 token 鉴权（零改动）
        .env("ELECTRON_RUN", "1")
        .env("WEBUI_STATIC_ROOT", &webui_dist)
        .env("OMA_RESOURCES_DIR", sidecar_dir)
        .env("OMA_DESKTOP_CONTROL_PORT", state.ctl_port.to_string())
        .env("OMA_SIDECAR_CONTROL_PORT", state.sidecar_api_port.to_string())
        .env("OMA_CONTROL_TOKEN", &state.ctl_token)
        .env("OMA_APP_VERSION", &cfg.app_version)
        .env("OMA_OS_LOCALE", &locale)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd.spawn()
}

/// Best-effort OS locale, mirroring Electron's `app.getLocale()`.
#[cfg(windows)]
fn os_locale() -> String {
    use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;
    let mut buf = [0u16; 85]; // LOCALE_NAME_MAX_LENGTH
    unsafe {
        GetUserDefaultLocaleName(buf.as_mut_ptr(), 85);
    }
    let s = String::from_utf16_lossy(&buf);
    let s = s.trim_end_matches('\0');
    if s.to_ascii_lowercase().starts_with("zh") {
        "zh-CN".into()
    } else {
        "en".into()
    }
}

#[cfg(not(windows))]
fn os_locale() -> String {
    std::env::var("LANG")
        .or_else(|_| std::env::var("LC_ALL"))
        .unwrap_or_else(|_| "en".to_string())
}

async fn forward_output<R: AsyncRead + Unpin + Send + 'static>(
    stream: R,
    log_path: PathBuf,
) {
    let mut lines = BufReader::new(stream).lines();
    let mut sink = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        Ok(f) => Some(f),
        Err(_) => None,
    };
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(f) = &mut sink {
            use std::io::Write;
            let _ = writeln!(f, "{line}");
        }
    }
}

/// Endless health loop: drives the Starting → Running / Error state machine and
/// reveals the main window once the gateway answers.
async fn health_loop(app: AppHandle, state: Arc<SidecarState>, server_port: u16) {
    let client = match reqwest::Client::builder().timeout(HTTP_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            log::error!("sidecar: http client build failed: {e}");
            return;
        }
    };
    let url = format!("http://127.0.0.1:{server_port}/api/health");

    let started = std::time::Instant::now();
    let mut consecutive_failures: u32 = 0;

    loop {
        let healthy = client
            .get(&url)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        let snapshot = state.snapshot().await;

        match snapshot.kind {
            StatusKind::Starting => {
                if healthy {
                    consecutive_failures = 0;
                    state.set_kind(StatusKind::Running).await;
                    log::info!("sidecar: healthy after {:?}", started.elapsed());
                    crate::windows::reveal_main_window(&app);
                    crate::tray::rebuild(&app, &DesktopConfig::load(&config_path(&app)));
                    // First-run gateway chooser (no-op once configured).
                    let app2 = app.clone();
                    tauri::async_runtime::spawn(async move {
                        crate::windows::maybe_show_chooser(app2).await;
                    });
                } else if started.elapsed() > STARTUP_WINDOW {
                    let err = "后端服务启动超时（60 秒内未就绪）".to_string();
                    log::error!("sidecar: startup timeout");
                    state.set_error(err.clone()).await;
                    let _ = crate::windows::show_error_window(&app, &err);
                }
            }
            StatusKind::Running => {
                if !healthy {
                    consecutive_failures += 1;
                    if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                        let err = "后端服务健康检查连续失败，服务可能已停止".to_string();
                        log::error!("sidecar: {err}");
                        state.set_error(err.clone()).await;
                        let _ = crate::windows::show_error_window(&app, &err);
                    }
                } else {
                    consecutive_failures = 0;
                }
            }
            StatusKind::Stopping => {
                if !healthy {
                    state.set_kind(StatusKind::Stopped).await;
                    crate::tray::rebuild(&app, &DesktopConfig::load(&config_path(&app)));
                }
            }
            StatusKind::Error => {
                // Restart is initiated elsewhere (tray / compat command); the
                // loop picks up the new Starting state once respawn happens.
                if healthy {
                    // Got healthy again (e.g. sidecar restarted externally).
                    state.set_kind(StatusKind::Running).await;
                }
            }
            StatusKind::Stopped => {
                // Idle until someone flips us back to Starting.
            }
        }
        sleep(POLL_INTERVAL).await;
    }
}

/// Graceful shutdown: ask the sidecar to stop() itself, wait briefly, then
/// force-kill the process tree as a fallback.
pub async fn shutdown(app: &AppHandle) {
    let state = app.state::<Arc<SidecarState>>().clone();
    let snapshot = state.snapshot().await;
    if snapshot.kind == StatusKind::Stopped {
        return;
    }
    state.set_kind(StatusKind::Stopping).await;

    // 1. Graceful: POST /_desktop/shutdown with the control token.
    let client = reqwest::Client::builder().timeout(HTTP_TIMEOUT).build();
    if let Ok(client) = client {
        let url = format!("http://127.0.0.1:{}/_desktop/shutdown", state.ctl_port);
        let _ = client
            .post(&url)
            .bearer_auth(&state.ctl_token)
            .send()
            .await;
    }

    // 2. Give the process a moment; the holder task flips state to Stopped.
    let deadline = std::time::Instant::now() + GRACEFUL_EXIT_WAIT;
    loop {
        if state.snapshot().await.kind == StatusKind::Stopped {
            return;
        }
        if std::time::Instant::now() > deadline {
            break;
        }
        sleep(Duration::from_millis(200)).await;
    }

    // 3. Fallback: kill the whole tree.
    if let Some(pid) = *state.pid.read().await {
        log::warn!("sidecar: graceful exit timed out, taskkill /T /F pid={pid}");
        let _ = kill_process_tree(pid);
        state.kill_notify.notify_one();
    }
    // Holder task flips state to Stopped; wait briefly for that.
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        if state.snapshot().await.kind == StatusKind::Stopped {
            return;
        }
        sleep(Duration::from_millis(200)).await;
    }
}

/// Reserve an ephemeral port by binding and immediately dropping the listener.
/// The tiny race (another process grabbing it before the sidecar binds) is
/// acceptable for a local desktop app.
fn reserve_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(0)
}

/// Kill the sidecar process and its whole tree. Windows: `taskkill /T /F`;
/// other platforms: SIGKILL to the child (no process group is created).
#[cfg(windows)]
fn kill_process_tree(pid: u32) -> std::io::Result<()> {
    std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    Ok(())
}

#[cfg(not(windows))]
fn kill_process_tree(pid: u32) -> std::io::Result<()> {
    std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()?;
    Ok(())
}

/// (Re)start the sidecar after an error or a user-initiated "restart service".
pub fn restart(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Arc<SidecarState>>().clone();

        if cfg!(debug_assertions) {
            // Dev: the sidecar is external (tsx watch); relaunching the shell is
            // the closest equivalent to a service restart.
            let exe = std::env::current_exe();
            if let Ok(exe) = exe {
                let _ = std::process::Command::new(exe).spawn();
                app.exit(0);
            }
            return;
        }

        // Tear down the current process, then respawn.
        let _ = shutdown(&app).await;

        let cfg = ShellConfig::load(&app);
        match spawn_sidecar(&cfg, &state) {
            Ok(child) => {
                let pid = child.id().unwrap_or(0);
                log::info!("sidecar: respawned pid={pid}");
                *state.pid.write().await = Some(pid);
                spawn_holder(app.clone(), state.inner().clone(), child);
                *state.status.write().await = SidecarStatus {
                    kind: StatusKind::Starting,
                    port: cfg.server_port,
                    error: None,
                };
                crate::tray::rebuild(&app, &DesktopConfig::load(&config_path(&app)));
            }
            Err(e) => {
                log::error!("sidecar: respawn failed: {e}");
                state.set_error(format!("重新启动后端服务失败: {e}")).await;
            }
        }
    });
}
