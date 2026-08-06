//! File-backed logger: mirrors every `log::` record to
//! `<userData>/logs/shell.log` so shell-side state machine transitions
//! (sidecar lifecycle, tray, control-server pushes, compat commands) are
//! observable from disk. GUI apps have no stderr, so without this the Rust
//! side was a black box for field debugging.
//!
//! Local time on Windows (HH:MM:SS.mmm); epoch millis elsewhere.

use std::io::Write;
use std::sync::Mutex;

static LOGGER: FileLogger = FileLogger {
    file: Mutex::new(None),
};

struct FileLogger {
    file: Mutex<Option<std::fs::File>>,
}

impl log::Log for FileLogger {
    fn enabled(&self, _metadata: &log::Metadata) -> bool {
        true
    }

    fn log(&self, record: &log::Record) {
        if let Ok(mut guard) = self.file.lock() {
            if let Some(f) = guard.as_mut() {
                let _ = writeln!(
                    f,
                    "[{}] {}: {}",
                    now_hms(),
                    record.level(),
                    record.args()
                );
            }
        }
    }

    fn flush(&self) {
        if let Ok(mut guard) = self.file.lock() {
            if let Some(f) = guard.as_mut() {
                let _ = f.flush();
            }
        }
    }
}

/// Install the file logger. The log path is resolved lazily on the first
/// record, so it can be called before the config is loaded.
pub fn init(log_path: &std::path::Path) -> Result<(), String> {
    let parent = log_path
        .parent()
        .ok_or("log path has no parent")?
        .to_path_buf();
    std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|e| e.to_string())?;
    let mut guard = LOGGER
        .file
        .lock()
        .map_err(|_| "logger lock poisoned".to_string())?;
    *guard = Some(file);
    drop(guard);
    log::set_logger(&LOGGER).map_err(|e| e.to_string())?;
    log::set_max_level(log::LevelFilter::Info);
    log::info!("shell.log initialized at {log_path:?}");
    Ok(())
}

fn now_hms() -> String {
    #[cfg(windows)]
    {
        // windows-sys 0.59: GetLocalTime under System::SystemInformation,
        // SYSTEMTIME under Foundation.
        use windows_sys::Win32::Foundation::SYSTEMTIME;
        use windows_sys::Win32::System::SystemInformation::GetLocalTime;
        let mut st: SYSTEMTIME = unsafe { std::mem::zeroed() };
        unsafe { GetLocalTime(&mut st) };
        format!(
            "{:02}:{:02}:{:02}.{:03}",
            st.wHour, st.wMinute, st.wSecond, st.wMilliseconds
        )
    }
    #[cfg(not(windows))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis().to_string())
            .unwrap_or_else(|_| "0".to_string())
    }
}
