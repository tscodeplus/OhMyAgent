
import type { AppConfig, AppServices } from '../types.js';
import type { openDatabase } from '../../memory/db.js';
import { AgentService } from '../../agent/agent-service.js';
import { MaintenanceScheduler } from '../../memory/maintenance/maintenance-scheduler.js';
import { MaintenanceRunRepository } from '../../memory/maintenance/maintenance-run-repository.js';
import { createEmbeddingBackfillJob } from '../../memory/maintenance/jobs/embedding-backfill-job.js';
import { createEmbeddingCacheTrimJob } from '../../memory/maintenance/jobs/embedding-cache-trim-job.js';
import { createEntityBackfillJob } from '../../memory/maintenance/jobs/entity-backfill-job.js';
import { createOffloadHygieneJob } from '../../memory/maintenance/jobs/offload-hygiene-job.js';
import { createPersonaConsistencyJob } from '../../memory/maintenance/jobs/persona-consistency-job.js';
// scene_cluster and memory_hygiene are now handled by DreamCycle (nightly)
import { createMemoryDoctorJob } from '../../memory/maintenance/jobs/memory-doctor-job.js';
import { DreamCycle } from '../../memory/dream-cycle.js';
import type { MergeConfig } from '../../memory/memory-merge.js';
import { CronDeliveryRegistry } from '../../cron/delivery-registry.js';
import { CronStore } from '../../cron/store.js';
import { JobRunner, type AgentRunner } from '../../cron/job-runner.js';
import { CronScheduler } from '../../cron/scheduler.js';
import { CronService } from '../../cron/service.js';
import { CollectingReplyDispatcher } from '../../cron/collecting-dispatcher.js';
import { configEventBus } from '../config-event-bus.js';
import type { MemoryServices } from './memory-services.js';

export interface SchedulerServices {
  maintenanceScheduler: MaintenanceScheduler;
  dreamCycle: DreamCycle;
  cronService: CronService;
  jobRunner: JobRunner;
}

function getCronSystemPrompt(): string {
  return `You are a message relay, NOT a chat assistant. Your output will be shown directly to the user.

**Strictly follow:**
1. Read the prompt in the user message
2. Strip the "remind user to" / "tell user" prefix, output the rest in a natural tone
3. Add NOTHING else — no greeting, no closing, no confirmation, no advice, no tips, no questions
4. If the prompt asks for information, search and present results directly
5. Two hard limits: (a) Do not output any sentence containing the word "remind" (b) Do not output any question marks`;
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
  // memory_hygiene and scene_cluster are handled by DreamCycle (nightly),
  // not registered as MaintenanceScheduler jobs
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
  // scene_cluster is now handled by DreamCycle (nightly)
  if (jobConfigs.memory_doctor === true) {
    maintenanceScheduler.register(createMemoryDoctorJob(memory.memoryDoctor));
  }
  logger.info({ jobCount: maintenanceScheduler.listJobs().length }, 'MaintenanceScheduler initialized');

  // ── DreamCycle (nightly maintenance orchestrator) ─────────────────────
  const dreamCycleConfig = config.memory?.dreamCycle ?? {
    enabled: true,
    timezone: '',
    hour: 2,
    minute: 0,
    windowGraceMinutes: 120,
    phaseTimeoutMs: 1_800_000,
    synthesizeBatchSize: 50,
  };

  const mergeConfig: MergeConfig = {
    auxConfig: memory.auxModelConfig,
    mergeThreshold: 0.85,
    logger,
  };

  const dreamCycle = new DreamCycle(
    dreamCycleConfig,
    db,
    maintenanceRunRepo,
    memory.memoryRepository,
    memory.memoryLinkRepo,
    memory.embeddingRepository,
    memory.embeddingClient,
    memory.memoryHygiene,
    memory.sceneClusterer,
    mergeConfig,
    logger,
  );

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

  // Cron on/off + footer update on config reload
  configEventBus.onReload((c) => {
    if (c.cron.enabled) cronService.start();
    else cronService.stop();
  });
  configEventBus.onReload((c) => {
    jobRunner.updateConfig({ footer: c.footer });
  });

  return {
    maintenanceScheduler,
    dreamCycle,
    cronService,
    jobRunner,
  };
}
