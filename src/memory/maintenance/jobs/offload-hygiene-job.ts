import type { MaintenanceJob, MaintenanceJobResult } from '../maintenance-job.js';
import fs from 'fs';
import path from 'path';

export function createOffloadHygieneJob(
  offloadDir: string,
  maxAgeDays: number = 30,
  intervalMs: number = 24 * 60 * 60 * 1000,
): MaintenanceJob {
  return {
    name: 'offload_hygiene',
    enabled: true,
    intervalMs,
    async run({ dryRun }): Promise<MaintenanceJobResult> {
      if (!fs.existsSync(offloadDir)) {
        return {
          name: 'offload_hygiene',
          status: 'success',
          dryRun,
          affectedRows: 0,
          durationMs: 0,
          details: { message: 'Offload directory does not exist' },
        };
      }

      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      let freedBytes = 0;
      let deletedCount = 0;

      try {
        const entries = fs.readdirSync(offloadDir);
        for (const entry of entries) {
          const fullPath = path.join(offloadDir, entry);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              // Check directory age
              if (stat.mtimeMs < cutoff) {
                const dirSize = getDirSize(fullPath);
                if (!dryRun) {
                  fs.rmSync(fullPath, { recursive: true });
                }
                freedBytes += dirSize;
                deletedCount++;
              }
            } else if (stat.isFile()) {
              if (stat.mtimeMs < cutoff) {
                if (!dryRun) {
                  fs.unlinkSync(fullPath);
                }
                freedBytes += stat.size;
                deletedCount++;
              }
            }
          } catch {
            // Skip individual file errors
          }
        }
      } catch {
        return {
          name: 'offload_hygiene',
          status: 'failed',
          dryRun,
          affectedRows: 0,
          durationMs: 0,
          error: 'Failed to read offload directory',
        };
      }

      return {
        name: 'offload_hygiene',
        status: 'success',
        dryRun,
        affectedRows: deletedCount,
        durationMs: 0,
        details: { deletedCount, freedBytes },
      };
    },
  };
}

function getDirSize(dir: string): number {
  let size = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        size += getDirSize(fullPath);
      } else if (entry.isFile()) {
        size += fs.statSync(fullPath).size;
      }
    }
  } catch {
    // Ignore
  }
  return size;
}
