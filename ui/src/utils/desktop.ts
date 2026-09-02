import { useEffect, useState } from 'react';
import { isElectron } from './env';

let cached: string | null | undefined;

/**
 * Desktop shell platform ("windows" | "macos" | "linux"), resolved once via
 * the compat IPC (`std::env::consts::OS`). Returns null in the browser or
 * before the IPC answers. The frameless caption differs per OS: macOS keeps
 * its native traffic lights, Windows/Linux draw custom window controls.
 */
export function useDesktopPlatform(): string | null {
  const [platform, setPlatform] = useState<string | null>(cached ?? null);
  useEffect(() => {
    if (!isElectron()) return;
    if (cached !== undefined) {
      setPlatform(cached);
      return;
    }
    let alive = true;
    window.electronAPI
      ?.getPlatform?.()
      .then((p) => {
        cached = p;
        if (alive) setPlatform(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return platform;
}
