import type { MemoryHygiene } from '../../memory-hygiene.js';
import type { MaintenanceJob, MaintenanceJobResult } from '../maintenance-job.js';

export function createMemoryHygieneJob(
  hygiene: MemoryHygiene,
  intervalMs: number = 24 * 60 * 60 * 1000, // daily
): MaintenanceJob {
  return {
    name: 'memory_hygiene',
    enabled: true,
    intervalMs,
    async run({ dryRun }): Promise<MaintenanceJobResult> {
      if (dryRun) {
        // In dry run, just report counts without cleaning
        return {
          name: 'memory_hygiene',
          status: 'success',
          dryRun: true,
          affectedRows: 0,
          durationMs: 0,
          details: { message: 'Dry run — no changes made' },
        };
      }
      const report = hygiene.clean();
      return {
        name: 'memory_hygiene',
        status: report.error ? 'failed' : 'success',
        dryRun: false,
        affectedRows: report.cleanedCount,
        durationMs: report.durationMs,
        error: report.error,
        details: { cleanedKinds: report.cleanedKinds },
      };
    },
  };
}
