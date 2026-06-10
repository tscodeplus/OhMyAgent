import fs from 'node:fs';
import path from 'node:path';
import { OffloadStore } from './offload-store.js';

export interface OffloadHygieneConfig {
  /** 卸载文件保留天数。默认 7。 */
  retentionDays: number;
  /** 最小检查间隔 ms。默认 24 小时。 */
  checkIntervalMs: number;
  /** Memory key 用于存储最后检查时间戳。 */
  lastCheckKey: string;
}

export interface OffloadHygieneReport {
  deletedSessions: number;
  freedBytes: number;
  durationMs: number;
  error?: string;
}

export class OffloadHygiene {
  constructor(
    private offloadStore: OffloadStore,
    private config: Partial<OffloadHygieneConfig> = {},
  ) {}

  private get resolvedConfig(): Required<OffloadHygieneConfig> {
    return {
      retentionDays: this.config.retentionDays ?? 7,
      checkIntervalMs: this.config.checkIntervalMs ?? 24 * 60 * 60 * 1000,
      lastCheckKey: this.config.lastCheckKey ?? '__offload_hygiene_last_check__',
    };
  }

  /**
   * Execute cleanup unconditionally.
   *
   * 1. List expired sessions from OffloadStore
   * 2. Calculate disk usage for each before deletion
   * 3. Delete expired sessions
   * 4. Return report with stats
   *
   * Errors for individual session deletions are collected and reported
   * via the `error` field without aborting the entire cleanup.
   */
  clean(): OffloadHygieneReport {
    const startMs = Date.now();
    const config = this.resolvedConfig;

    try {
      const expiredSessions = this.offloadStore.listExpiredSessions(config.retentionDays);
      let deletedSessions = 0;
      let freedBytes = 0;
      let error: string | undefined;

      for (const sessionKey of expiredSessions) {
        try {
          // Calculate directory size before deletion
          const sessionDir = this.offloadStore.getSessionDirPath(sessionKey);
          let sessionSize = 0;
          if (fs.existsSync(sessionDir)) {
            sessionSize = this._calculateDirSize(sessionDir);
          }
          this.offloadStore.deleteSession(sessionKey);
          deletedSessions++;
          freedBytes += sessionSize;
        } catch (e) {
          error = error ? `${error}; ${String(e)}` : String(e);
        }
      }

      return {
        deletedSessions,
        freedBytes,
        durationMs: Date.now() - startMs,
        error,
      };
    } catch (e) {
      return {
        deletedSessions: 0,
        freedBytes: 0,
        durationMs: Date.now() - startMs,
        error: String(e),
      };
    }
  }

  /**
   * Recursively calculate the total size (in bytes) of a directory.
   */
  private _calculateDirSize(dirPath: string): number {
    let total = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += this._calculateDirSize(fullPath);
      } else if (entry.isFile()) {
        total += fs.statSync(fullPath).size;
      }
    }
    return total;
  }
}
