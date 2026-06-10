import { i18n } from '../../i18n/index.js';
import type { AppConfig, AppServices } from '../types.js';
import type { openDatabase } from '../../memory/db.js';
import { AgentService } from '../../agent/agent-service.js';
import { MaintenanceScheduler } from '../../memory/maintenance/maintenance-scheduler.js';
import { MaintenanceRunRepository } from '../../memory/maintenance/maintenance-run-repository.js';
import { createMemoryHygieneJob } from '../../memory/maintenance/jobs/memory-hygiene-job.js';
import { createEmbeddingBackfillJob } from '../../memory/maintenance/jobs/embedding-backfill-job.js';
import { createEmbeddingCacheTrimJob } from '../../memory/maintenance/jobs/embedding-cache-trim-job.js';
import { createEntityBackfillJob } from '../../memory/maintenance/jobs/entity-backfill-job.js';
import { createOffloadHygieneJob } from '../../memory/maintenance/jobs/offload-hygiene-job.js';
import { createPersonaConsistencyJob } from '../../memory/maintenance/jobs/persona-consistency-job.js';
import { createSceneClusterJob } from '../../memory/maintenance/jobs/scene-cluster-job.js';
import { createMemoryDoctorJob } from '../../memory/maintenance/jobs/memory-doctor-job.js';
import { CronDeliveryRegistry } from '../../cron/delivery-registry.js';
import { CronStore } from '../../cron/store.js';
import { JobRunner, type AgentRunner } from '../../cron/job-runner.js';
import { CronScheduler } from '../../cron/scheduler.js';
import { CronService } from '../../cron/service.js';
import { CollectingReplyDispatcher } from '../../cron/collecting-dispatcher.js';
import type { MemoryServices } from './memory-services.js';

export interface SchedulerServices {
  maintenanceScheduler: MaintenanceScheduler;
  cronService: CronService;
  jobRunner: JobRunner;
}

function getCronSystemPrompt(): string {
  return i18n.t('prompts:cron.delivery');
}

function createCronAgentRunner(
  agentService: AgentService,
  modelName: string,
): AgentRunner {
  return {
    async run(prompt: string, sessionId: string, chatId: string, agentId?: string, computerUseAllowed?: boolean) {
      const dispatcher = new CollectingReplyDispatcher();
      const agent = await agentService.execute(prompt, {
        sessionId,
        chatId,
        replyDispatcherOverride: dispatcher,
        systemPrompt: getCronSystemPrompt(),
        agentId,
        computerUseAllowed,
      });
      const agentModel = (agent.state as any)?.model;
      const actualModel = (agentModel?.provider && agentModel?.id)
        ? `${agentModel.provider}/${agentModel.id}`
        : dispatcher.getModel() ?? modelName;
      return {
        text: dispatcher.getOutput(),
        modelLabel: actualModel,
      };
    },
    cleanup(sessionId: string) {
      agentService.destroyRuntime(sessionId);
    },
  };
}

export function createSchedulers(input: {
  config: AppConfig;
  logger: AppServices['logger'];
  db: ReturnType<typeof openDatabase>;
  memory: MemoryServices;
  cronDeliveryRegistry: CronDeliveryRegistry;
  agentService: AgentService;
  modelName: string;
}): SchedulerServices {
  const { config, logger, db, memory, cronDeliveryRegistry, agentService, modelName } = input;
  const maintenanceRunRepo = new MaintenanceRunRepository(db);
  const maintenanceConfig = config.memory?.maintenance ?? {
    enabled: true, intervalMs: 300_000, jobs: {
      memory_hygiene: true, embedding_backfill: true, embedding_cache_trim: true,
      entity_backfill: true, persona_consistency: true, offload_hygiene: true,
      scene_cluster: false, memory_doctor: false,
    } };
  const maintenanceScheduler = new MaintenanceScheduler(
    {
      enabled: maintenanceConfig.enabled !== false,
      intervalMs: maintenanceConfig.intervalMs,
    },
    maintenanceRunRepo,
    logger,
  );

  const jobConfigs = maintenanceConfig.jobs;
  if (jobConfigs.memory_hygiene !== false) {
    maintenanceScheduler.register(createMemoryHygieneJob(memory.memoryHygiene));
  }
  if (jobConfigs.embedding_backfill !== false) {
    maintenanceScheduler.register(createEmbeddingBackfillJob(db, memory.embeddingRepository, memory.embeddingClient));
  }
  if (jobConfigs.embedding_cache_trim !== false) {
    maintenanceScheduler.register(createEmbeddingCacheTrimJob(db, config.memory.embeddingCacheMaxEntries));
  }
  if (jobConfigs.entity_backfill !== false) {
    maintenanceScheduler.register(createEntityBackfillJob(db, memory.memoryLinkRepo));
  }
  if (jobConfigs.persona_consistency !== false) {
    maintenanceScheduler.register(createPersonaConsistencyJob(
      memory.memoryRepository, memory.personaStore, memory.personaDistiller, logger,
    ));
  }
  if (jobConfigs.offload_hygiene !== false) {
    maintenanceScheduler.register(createOffloadHygieneJob(memory.offloadDir));
  }
  if (jobConfigs.scene_cluster === true) {
    maintenanceScheduler.register(createSceneClusterJob(memory.sceneClusterer));
  }
  if (jobConfigs.memory_doctor === true) {
    maintenanceScheduler.register(createMemoryDoctorJob(memory.memoryDoctor));
  }
  logger.info({ jobCount: maintenanceScheduler.listJobs().length }, 'MaintenanceScheduler initialized');

  const cronStore = new CronStore(config.cron.dataDir);
  const cronAgentRunner = createCronAgentRunner(agentService, modelName);
  const jobRunner = new JobRunner(cronDeliveryRegistry, cronAgentRunner, {
    executionTimeoutMs: config.cron.executionTimeoutMs,
    footer: config.footer,
    logger,
  });
  const cronScheduler = new CronScheduler(cronStore, jobRunner, {
    tickIntervalMs: config.cron.tickIntervalMs,
    maxConcurrency: config.cron.maxConcurrency,
    logger,
  });
  const cronService = new CronService(cronStore, cronScheduler, jobRunner);

  return {
    maintenanceScheduler,
    cronService,
    jobRunner,
  };
}
