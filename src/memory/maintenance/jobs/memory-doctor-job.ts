import type { MemoryDoctor } from '../memory-doctor.js';
import type { MaintenanceJob, MaintenanceJobResult } from '../maintenance-job.js';

export function createMemoryDoctorJob(
  doctor: MemoryDoctor,
  intervalMs: number = 24 * 60 * 60 * 1000,
): MaintenanceJob {
  return {
    name: 'memory_doctor',
    enabled: false, // Default off — explicit trigger via tool or config
    intervalMs,
    async run({ dryRun }): Promise<MaintenanceJobResult> {
      if (dryRun) {
        const report = await doctor.diagnose();
        return {
          name: 'memory_doctor',
          status: 'success',
          dryRun: true,
          affectedRows: 0,
          durationMs: 0,
          details: { totalIssues: report.totalIssues, checks: report.checks.map(c => c.name) },
        };
      }

      const report = await doctor.repair();
      return {
        name: 'memory_doctor',
        status: report.totalIssues > report.repaired ? 'failed' : 'success',
        dryRun: false,
        affectedRows: report.repaired,
        durationMs: 0,
        details: { totalIssues: report.totalIssues, repaired: report.repaired },
      };
    },
  };
}
