//! Minimal runtime i18n for shell-rendered UI (splash, error dialogs, tray
//! menu). The WebUI has its own i18n (ui/src/i18n); the shell mirrors the
//! language from desktop-config.json — a "zh" prefix selects Chinese, anything
//! else English, defaulting to Chinese (matching the gateway chooser's
//! `?? 'zh-CN'` fallback, gateway-chooser.ts).

use crate::config::{config_path, DesktopConfig};
use tauri::AppHandle;

/// Is the configured UI language Chinese?
pub fn is_zh_cfg(cfg: &DesktopConfig) -> bool {
    cfg.language
        .as_deref()
        .map(|l| l.starts_with("zh"))
        .unwrap_or(true)
}

/// Is the configured UI language Chinese? Convenience reading the mirror file
/// for call sites that do not already hold a `DesktopConfig`.
pub fn is_zh(app: &AppHandle) -> bool {
    is_zh_cfg(&DesktopConfig::load(&config_path(app)))
}

/// Pick the localized variant of a user-visible string.
pub fn tr(zh: &'static str, en: &'static str, zh_mode: bool) -> &'static str {
    if zh_mode {
        zh
    } else {
        en
    }
}
