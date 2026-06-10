import type { SceneClusterer } from '../../scene-cluster.js';
import type { MaintenanceJob, MaintenanceJobResult } from '../maintenance-job.js';

export function createSceneClusterJob(
  sceneClusterer: SceneClusterer | undefined,
  intervalMs: number = 24 * 60 * 60 * 1000,
): MaintenanceJob {
  return {
    name: 'scene_cluster',
    enabled: false, // Default off per v9 spec
    intervalMs,
    async run({ dryRun }): Promise<MaintenanceJobResult> {
      if (!sceneClusterer) {
        return {
          name: 'scene_cluster',
          status: 'skipped',
          dryRun,
          affectedRows: 0,
          durationMs: 0,
          details: { message: 'SceneClusterer not configured' },
        };
      }

      if (dryRun) {
        return {
          name: 'scene_cluster',
          status: 'success',
          dryRun: true,
          affectedRows: 0,
          durationMs: 0,
          details: { message: 'Dry run — would run clustering' },
        };
      }

      try {
        await sceneClusterer.cluster();
        return {
          name: 'scene_cluster',
          status: 'success',
          dryRun: false,
          affectedRows: 1,
          durationMs: 0,
        };
      } catch (err) {
        return {
          name: 'scene_cluster',
          status: 'failed',
          dryRun: false,
          affectedRows: 0,
          durationMs: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
