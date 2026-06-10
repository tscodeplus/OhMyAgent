import type { MemoryRepository } from '../../repositories/memory-repository.js';
import type { PersonaStore } from '../../persona-store.js';
import type { PersonaDistiller } from '../../persona-distiller.js';
import type { Logger } from 'pino';
import type { MaintenanceJob, MaintenanceJobResult } from '../maintenance-job.js';

export function createPersonaConsistencyJob(
  memoryRepo: MemoryRepository,
  personaStore: PersonaStore | undefined,
  personaDistiller: PersonaDistiller | undefined,
  logger: Logger,
  intervalMs: number = 6 * 60 * 60 * 1000,
): MaintenanceJob {
  return {
    name: 'persona_consistency',
    enabled: true,
    intervalMs,
    async run({ dryRun }): Promise<MaintenanceJobResult> {
      if (!personaStore || !personaDistiller) {
        return {
          name: 'persona_consistency',
          status: 'skipped',
          dryRun,
          affectedRows: 0,
          durationMs: 0,
          details: { message: 'Persona not enabled' },
        };
      }

      const persona = personaStore.get();
      if (!persona) {
        return {
          name: 'persona_consistency',
          status: 'success',
          dryRun,
          affectedRows: 0,
          durationMs: 0,
          details: { message: 'No persona yet' },
        };
      }

      const activePrefs = memoryRepo.findByScopeKind('user', 'preference')
        .filter(p => p.status === 'active');

      // Check if persona lastUpdated is behind active preferences
      const personaLastUpdated = new Date(persona.lastUpdated).getTime();
      const stalePrefs = activePrefs.filter(
        p => new Date(p.updated_at).getTime() > personaLastUpdated,
      );

      const isStale = stalePrefs.length > 0;

      if (dryRun) {
        return {
          name: 'persona_consistency',
          status: 'success',
          dryRun: true,
          affectedRows: 0,
          durationMs: 0,
          details: {
            isStale,
            stalePrefCount: stalePrefs.length,
            activePrefCount: activePrefs.length,
            personaLastUpdated: persona.lastUpdated,
          },
        };
      }

      if (isStale) {
        const success = await personaDistiller.rebuildFull();
        return {
          name: 'persona_consistency',
          status: success ? 'success' : 'failed',
          dryRun: false,
          affectedRows: success ? 1 : 0,
          durationMs: 0,
          details: { rebuilt: success, stalePrefCount: stalePrefs.length },
        };
      }

      return {
        name: 'persona_consistency',
        status: 'success',
        dryRun: false,
        affectedRows: 0,
        durationMs: 0,
        details: { isStale: false, activePrefCount: activePrefs.length },
      };
    },
  };
}
