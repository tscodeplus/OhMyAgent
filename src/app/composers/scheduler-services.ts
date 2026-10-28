import type { AppConfig, AppServices } from '../types.js';
import type { openDatabase } from '../../memory/db.js';
import { AgentService } from '../../agent/agent-service.js';
import { MaintenanceScheduler } from '../../memory/maintenance/maintenance-scheduler.js';
import { MaintenanceRunRepository } from '../../memory/maintenance/maintenance-run-repository.js';
import { createEmbeddingBackfillJob } from '../../memory/maintenance/jobs/embedding-backfill-job.js';
import { createTermsBackfillJob } from '../../memory/maintenance/jobs/terms-backfill-job.js';
import { createEmbeddingCacheTrimJob } from '../../memory/maintenance/jobs/embedding-cache-trim-job.js';
import { createEntityBackfillJob } from '../../memory/maintenance/jobs/entity-backfill-job.js';
import { createOffloadHygieneJob } from '../../memory/maintenance/jobs/offload-hygiene-job.js';
import { createPersonaConsistencyJob } from '../../memory/maintenance/jobs/persona-consistency-job.js';
// scene_cluster and memory_hygiene are now handled by DreamCycle (nightly)
import { createMemoryDoctorJob } from '../../memory/maintenance/jobs/memory-doctor-job.js';
import { createGraphSyncJob } from '../../graph/graph-sync.js';
import { createSessionAutoArchiveJob } from '../../memory/maintenance/jobs/session-auto-archive-job.js';
import { createMaintenanceHistoryPruneJob } from '../../memory/maintenance/jobs/maintenance-history-prune-job.js';
import { loadConfig } from '../config.js';
import { resolveGraphSyncConfig } from '../../graph/graph-config.js';
import { DreamCycle } from '../../memory/dream-cycle.js';
import type { MergeConfig } from '../../memory/memory-merge.js';
import { KnowledgeCurator } from '../../memory/knowledge/curate.js';
import type { KnowledgeCurateConfig } from '../../memory/knowledge/curate.js';
import type { AuxModelConfig } from '../../memory/aux-llm-client.js';
import { CronDeliveryRegistry } from '../../cron/delivery-registry.js';
import { CronStore } from '../../cron/store.js';
import { JobRunner, type AgentRunner } from '../../cron/job-runner.js';
import { CronScheduler } from '../../cron/scheduler.js';
import { CronService } from '../../cron/service.js';
import { CollectingReplyDispatcher } from '../../cron/collecting-dispatcher.js';
import { configEventBus } from '../config-event-bus.js';
import { setKnowledgeCuratorResolver } from '../../commands/command-handler.js';
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

function createCronAgentRunner(agentService: AgentService, modelName: string): AgentRunner {
  return {
    async run(
      prompt: string,
      sessionId: string,
      chatId: string,
      agentId?: string,
      computerUseAllowed?: boolean,
    ) {
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
      const actualModel =
        agentModel?.provider && agentModel?.id
          ? `${agentModel.provider}/${agentModel.id}`
          : (dispatcher.getModel() ?? modelName);
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

/**
 * `knowledge.curate` → the shape the curator takes.
 *
 * `auxConfig` is a getter rather than a copy: `createMemoryServices` mutates the
 * shared `AuxModelConfig` in place on hot-reload (new model chain, new keys), so
 * a snapshot taken here would pin curation to the model that was configured at
 * startup. An empty `curate.model_ref` means "reuse `memory_aux_models`"; a
 * non-empty one overrides only the model, because the per-provider keys,
 * baseUrls and the fallback chain stay whatever `memory_aux_models` resolved to
 * — a curation model that fails falls back down the same chain as every other
 * aux call, which is where `auxLLMCall` already looks.
 */
function knowledgeCurateConfig(
  config: AppConfig,
  auxModelConfig: AuxModelConfig,
): KnowledgeCurateConfig {
  const curate = config.knowledge.curate;
  return {
    enabled: config.knowledge.enabled,
    mode: curate.mode,
    shadow: curate.shadow,
    maxPagesPerRun: curate.maxPagesPerRun,
    requireSources: curate.requireSources,
    minMemoryConfidence: curate.minMemoryConfidence,
    get auxConfig(): AuxModelConfig {
      const modelRef = curate.modelRef.trim();
      return modelRef ? { ...auxModelConfig, modelRef } : auxModelConfig;
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
    enabled: true,
    intervalMs: 300_000,
    jobs: {
      memory_hygiene: true,
      embedding_backfill: true,
      terms_backfill: true,
      embedding_cache_trim: true,
      entity_backfill: true,
      persona_consistency: true,
      offload_hygiene: true,
      scene_cluster: false,
      memory_doctor: true,
      maintenance_history_prune: true,
    },
  };
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
    maintenanceScheduler.register(
      createEmbeddingBackfillJob(db, memory.embeddingRepository, memory.embeddingClient),
    );
  }
  if (jobConfigs.terms_backfill !== false) {
    maintenanceScheduler.register(createTermsBackfillJob(db));
  }
  if (jobConfigs.embedding_cache_trim !== false) {
    maintenanceScheduler.register(
      createEmbeddingCacheTrimJob(db, config.memory.embeddingCacheMaxEntries),
    );
  }
  if (jobConfigs.entity_backfill !== false) {
    maintenanceScheduler.register(createEntityBackfillJob(db, memory.memoryLinkRepo));
  }
  if (jobConfigs.persona_consistency !== false) {
    maintenanceScheduler.register(
      createPersonaConsistencyJob(
        memory.memoryRepository,
        memory.personaStore,
        memory.personaDistiller,
        logger,
      ),
    );
  }
  if (jobConfigs.offload_hygiene !== false) {
    maintenanceScheduler.register(createOffloadHygieneJob(memory.offloadDir));
  }
  // scene_cluster is now handled by DreamCycle (nightly)
  // memory_doctor now defaults to true — it is diagnostic + safe repair.
  if (jobConfigs.memory_doctor !== false) {
    maintenanceScheduler.register(createMemoryDoctorJob(memory.memoryDoctor));
  }
  // Keeps `maintenance_runs` bounded: every job run writes a row and nothing else
  // ever deletes one, while the only readers want the newest row per job.
  if (jobConfigs.maintenance_history_prune !== false) {
    maintenanceScheduler.register(createMaintenanceHistoryPruneJob(maintenanceRunRepo));
  }
  // Knowledge-graph projection of `memory_links` into `entities`/`entity_edges`.
  // It runs here — not on the turn path and not inside DreamCycle — because the
  // scheduler already owns the two things the projector needs: an interval gate
  // (a dream cycle is nightly, but links appear whenever the extractor runs)
  // and one `maintenance_runs` row per run. Registered disabled when
  // memory.graph.enabled is false, so it never even ticks.
  maintenanceScheduler.register(
    createGraphSyncJob(db, resolveGraphSyncConfig(config.memory?.graph), logger),
  );
  // Auto-archive (archive.auto). Registered unconditionally and disabled by its
  // own config: the getter reads the live config on every tick, because the
  // scheduler is built once and a snapshot would make the settings switch need a
  // restart. A disabled run reports `skipped`, so the run history still shows the
  // job is alive.
  maintenanceScheduler.register(
    createSessionAutoArchiveJob(
      db,
      () => loadConfig().archive?.auto,
      (sessionId) => agentService.isRunning(sessionId),
    ),
  );
  logger.info(
    { jobCount: maintenanceScheduler.listJobs().length },
    'MaintenanceScheduler initialized',
  );

  // ── DreamCycle (nightly maintenance orchestrator) ─────────────────────
  const dreamCycleConfig = config.memory?.dreamCycle ?? {
    enabled: true,
    timezone: '',
    hour: 2,
    minute: 0,
    windowGraceMinutes: 120,
    phaseTimeoutMs: 1_800_000,
    synthesizeBatchSize: 50,
    catchUpOnStart: true,
  };

  const mergeConfig: MergeConfig = {
    auxConfig: memory.auxModelConfig,
    mergeThreshold: 0.85,
    outputLanguage: config.memory.outputLanguage,
    logger,
  };

  // ── Knowledge curation (plan §6 K2-5, entry point 1) ──────────────────
  // DreamCycle's `knowledge_curate` phase is a no-op without a curator, so this
  // is the only line that makes `curate.mode: nightly` do anything. The instance
  // is built from the one `knowledgeService` the tools and the WebUI routes read,
  // so a curation write goes through the same service over the same connection.
  // `knowledge.enabled: false` (or a failed service build) leaves no service,
  // hence no curator, hence no writes — the phase stays inert, not half-wired.
  const knowledgeCurator = memory.knowledgeService
    ? new KnowledgeCurator({
        db,
        knowledgeService: memory.knowledgeService,
        logger,
        config: knowledgeCurateConfig(config, memory.auxModelConfig),
      })
    : undefined;
  // `/knowledge curate` runs this same object with the `manual` trigger; it is
  // composed before the command deps exist, hence the resolver (§6 K2-5 entry 2).
  setKnowledgeCuratorResolver(() => knowledgeCurator);

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
    knowledgeCurator,
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
    else void cronService.stop();
  });
  configEventBus.onReload((c) => {
    jobRunner.updateConfig({ footer: c.footer });
  });
  // DreamCycle merge language hot-reload (aux model chain lives on the shared
  // memory.auxModelConfig object, already mutated by memory-services' handler)
  configEventBus.onReload((c) => {
    mergeConfig.outputLanguage = c.memory.outputLanguage;
  });

  return {
    maintenanceScheduler,
    dreamCycle,
    cronService,
    jobRunner,
  };
}
