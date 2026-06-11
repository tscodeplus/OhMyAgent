import path from 'node:path';
import type { AppConfig, AppServices } from '../types.js';
import type { SummaryLLMConfig } from '../../memory/memory-summarizer.js';
import type { AuxModelConfig } from '../../memory/aux-llm-client.js';
import type { LLMExpansionConfig } from '../../memory/query-expansion-llm.js';
import type { PlannerConfig } from '../../memory/query-planner.js';
import type { MergeConfig } from '../../memory/memory-merge.js';
import type { LLMExtractionConfig } from '../../memory/entity-extractor.js';
import type { MemoryChangeEvent } from '../../memory/memory-writer.js';
import { createEmbeddingClient } from '../../provider/embedding-client.js';
import { CircuitBreaker } from '../../memory/circuit-breaker.js';
import { MemoryRepository } from '../../memory/repositories/memory-repository.js';
import { EmbeddingRepository } from '../../memory/repositories/embedding-repository.js';
import { EmbeddingCacheRepo } from '../../memory/repositories/embedding-cache-repository.js';
import { MemoryLinkRepository } from '../../memory/repositories/memory-link-repository.js';
import { MemoryTermRepository } from '../../memory/repositories/memory-term-repository.js';
import { MemoryRetriever } from '../../memory/memory-retriever.js';
import type { RecallConfig } from '../../memory/memory-retriever.js';
import { MemoryWriter } from '../../memory/memory-writer.js';
import { MemoryHygiene } from '../../memory/memory-hygiene.js';
import { MemorySummarizer } from '../../memory/memory-summarizer.js';
import { MemoryDoctor } from '../../memory/maintenance/memory-doctor.js';
import { SessionRepository } from '../../memory/repositories/session-repository.js';
import { MessageRepository } from '../../memory/repositories/message-repository.js';
import { ProcessedMessageRepository } from '../../memory/repositories/processed-message-repository.js';
import { EpisodeRepository } from '../../memory/repositories/episode-repository.js';
import { ToolRunRepository } from '../../memory/repositories/tool-run-repository.js';
import { ApprovalRequestRepository } from '../../memory/repositories/approval-request-repository.js';
import { ApprovalDecisionRepository } from '../../memory/repositories/approval-decision-repository.js';
import { PersonaStore } from '../../memory/persona-store.js';
import { PersonaDistiller, createDistillerLLM } from '../../memory/persona-distiller.js';
import { SceneClusterer } from '../../memory/scene-cluster.js';
import { PersonaDistillationLog } from '../../memory/persona/persona-distillation-log.js';
import { PersonaAuditService } from '../../memory/persona/persona-audit-service.js';
import type { openDatabase } from '../../memory/db.js';

export interface MemoryServices {
  embeddingClient: ReturnType<typeof createEmbeddingClient>;
  memoryRepository: MemoryRepository;
  embeddingRepository: EmbeddingRepository;
  embeddingCacheRepo: EmbeddingCacheRepo;
  memoryLinkRepo: MemoryLinkRepository;
  memoryTermRepo: MemoryTermRepository;
  memoryRetriever: MemoryRetriever;
  memoryWriter: MemoryWriter;
  memoryHygiene: MemoryHygiene;
  memorySummarizer: MemorySummarizer;
  memoryDoctor: MemoryDoctor;
  sessionRepository: SessionRepository;
  messageRepository: MessageRepository;
  processedMessageRepository: ProcessedMessageRepository;
  episodeRepository: EpisodeRepository;
  toolRunRepository: ToolRunRepository;
  approvalRequestRepo: ApprovalRequestRepository;
  approvalDecisionRepository: ApprovalDecisionRepository;
  personaStore?: PersonaStore;
  personaDistiller?: PersonaDistiller;
  personaAuditService: PersonaAuditService;
  sceneClusterer?: SceneClusterer;
  memoryChangeCallbacks: Array<(event?: MemoryChangeEvent) => void>;
  offloadDir: string;
}

function buildSummaryLLMConfig(
  auxConfig: AuxModelConfig,
  outputLanguage: string,
): SummaryLLMConfig {
  return {
    modelRef: auxConfig.modelRef,
    fallbackRefs: auxConfig.fallbackRefs?.length ? auxConfig.fallbackRefs : undefined,
    apiKeys: auxConfig.apiKeys,
    baseUrls: auxConfig.baseUrls,
    baseUrl: auxConfig.baseUrl,
    outputLanguage,
  };
}

export async function createMemoryServices(
  config: AppConfig,
  logger: AppServices['logger'],
  db: ReturnType<typeof openDatabase>,
): Promise<MemoryServices> {
  const cbConfig = config.memory.embeddingCircuitBreaker;
  const embeddingBreaker = new CircuitBreaker({
    failureThreshold: cbConfig.failureThreshold,
    cooldownMs: cbConfig.cooldownSec * 1000,
  });
  const embeddingClient = createEmbeddingClient({ embedding: config.embedding }, embeddingBreaker);

  const memoryRepository = new MemoryRepository(db);
  const embeddingRepository = new EmbeddingRepository(db);

  // Eagerly probe sqlite-vec so any DLL/platform issues surface at startup.
  // backfillVec() only calls loadSqliteVec() when there are existing embeddings,
  // which is never true on a fresh install.
  try {
    embeddingRepository.probeVec();
    logger.info('sqlite-vec extension loaded; vector search will activate on first embedding write');
  } catch (err: any) {
    logger.warn({ err: err?.message ?? err }, 'sqlite-vec unavailable; memory vector search will use cosine fallback');
  }

  const vecBackfilled = embeddingRepository.backfillVec();
  const embeddingCacheRepo = new EmbeddingCacheRepo(db, config.memory.embeddingCacheMaxEntries);
  const memoryLinkRepo = new MemoryLinkRepository(db);
  const memoryTermRepo = new MemoryTermRepository(db);

  const auxApiKeys: Record<string, string> = {};
  for (const [envVar, provider] of [
    ['DEEPSEEK_API_KEY', 'deepseek'],
    ['XIAOMI_API_KEY', 'xiaomi'],
    ['MINIMAX_API_KEY', 'minimax'],
    ['MOONSHOT_API_KEY', 'moonshotai'],
    ['ANTHROPIC_API_KEY', 'anthropic'],
    ['OPENAI_API_KEY', 'openai'],
    ['GEMINI_API_KEY', 'google'],
    ['MISTRAL_API_KEY', 'mistral'],
    ['GROQ_API_KEY', 'groq'],
  ] as const) {
    const key = process.env[envVar];
    if (key) auxApiKeys[provider] = key;
  }
  for (const cp of config.customProviders ?? []) {
    if (cp.apiKey) auxApiKeys[cp.provider] = cp.apiKey;
  }
  if (config.piAi.apiKey) {
    auxApiKeys['*'] = config.piAi.apiKey;
  }

  const memAux = config.memoryAuxModels;
  const mainModel = `${config.piAi.provider}/${config.piAi.model}`;
  const auxPrimary = memAux?.primary || mainModel;
  const configuredFallbackModels = Array.isArray(config.fallbackModels)
    ? config.fallbackModels
    : [];
  const auxFallbacks = [
    ...(memAux?.fallback_models ?? []),
    ...(memAux?.primary ? [] : configuredFallbackModels),
  ];
  const auxModelConfig: AuxModelConfig = {
    modelRef: auxPrimary,
    fallbackRefs: auxFallbacks,
    apiKeys: auxApiKeys,
    baseUrl: config.piAi.baseUrl,
  };

  logger.info({ primary: auxPrimary, fallbackCount: auxFallbacks.length }, 'Memory aux models configured');

  const expansionConfig: LLMExpansionConfig = {
    auxConfig: auxModelConfig,
    enabled: config.memory.expansion.enabled,
    minQueryLength: config.memory.expansion.minQueryLength,
    minScoreTrigger: config.memory.expansion.minScoreTrigger,
    maxVariants: config.memory.expansion.maxVariants,
    logger,
  };

  const mergeConfig: MergeConfig = {
    auxConfig: auxModelConfig,
    mergeThreshold: 0.85,
    logger,
  };

  const extractionConfig: LLMExtractionConfig = {
    auxConfig: auxModelConfig,
    enabled: true,
    minConfidence: 0.7,
    logger,
  };

  const plannerConfig: PlannerConfig = {
    enabled: config.memory.queryPlanner.enabled,
    commonalityCoverage: config.memory.queryPlanner.commonalityCoverage,
    speakerBoost: config.memory.queryPlanner.speakerBoost,
    perSlotFloor: config.memory.queryPlanner.perSlotFloor,
    maxEntities: config.memory.queryPlanner.maxEntities,
    llm: { enabled: config.memory.queryPlanner.llm.enabled },
  };

  const recallConfig: RecallConfig = {
    prefilterMultiplier: config.memory.recall.prefilterMultiplier,
    prefilterMin: config.memory.recall.prefilterMin,
    mergeCandidateMultiplier: config.memory.recall.mergeCandidateMultiplier,
  };

  const memoryRetriever = new MemoryRetriever(
    memoryRepository,
    embeddingRepository,
    embeddingClient,
    embeddingCacheRepo,
    db,
    expansionConfig,
    embeddingBreaker,
    { halfLifeDays: config.memory.decayHalfLifeDays },
    config.memory.recallMinScore,
    memoryLinkRepo,
    undefined,
    config.memory.queryEmbeddingTimeoutMs,
    plannerConfig,
    recallConfig,
  );
  const memoryChangeCallbacks: Array<(event?: MemoryChangeEvent) => void> = [() => memoryRetriever.clearCache()];
  const memoryWriter = new MemoryWriter(
    memoryRepository,
    embeddingRepository,
    embeddingClient,
    embeddingCacheRepo,
    mergeConfig,
    extractionConfig,
    undefined,
    memoryLinkRepo,
    (event) => memoryChangeCallbacks.forEach(cb => cb(event)),
    memoryTermRepo,
  );

  const sceneClusterer = config.memory.sceneClustering?.enabled
    ? new SceneClusterer(memoryRepository, config.memory.offloading?.refDir || './data', {
        windowDays: config.memory.sceneClustering.windowDays,
        minMemories: config.memory.sceneClustering.minMemories,
      }, logger)
    : undefined;
  if (sceneClusterer) {
    logger.info('SceneClusterer initialized');
  }

  const memoryHygiene = new MemoryHygiene(memoryRepository, db, {
    tempRetentionDays: config.memory.hygiene.retentionDays,
    checkIntervalMs: 12 * 60 * 60 * 1000,
  }, sceneClusterer, () => memoryRetriever.clearCache());

  const sessionRepository = new SessionRepository(db);
  const messageRepository = new MessageRepository(db);
  const processedMessageRepository = new ProcessedMessageRepository(db);
  const episodeRepository = new EpisodeRepository(db);
  const toolRunRepository = new ToolRunRepository(db);
  const approvalRequestRepo = new ApprovalRequestRepository(db);
  const approvalDecisionRepository = new ApprovalDecisionRepository(db);

  const summaryConfig = buildSummaryLLMConfig(auxModelConfig, config.memory.outputLanguage);
  const personaDistillationLog = new PersonaDistillationLog(db);
  const personaStore = config.memory.persona?.enabled
    ? new PersonaStore(memoryRepository)
    : undefined;
  const personaAuditService = new PersonaAuditService(
    memoryRepository,
    personaStore,
    personaDistillationLog,
  );
  let personaDistiller: PersonaDistiller | undefined;
  if (config.memory.persona?.enabled) {
    const distillerLLM = await createDistillerLLM(summaryConfig, logger);
    personaDistiller = new PersonaDistiller(
      distillerLLM,
      memoryRepository,
      personaStore!,
      logger,
      {
        distillThreshold: config.memory.persona.distillThreshold,
        minDistillIntervalHours: config.memory.persona.minDistillIntervalHours,
        outputLanguage: config.memory.outputLanguage,
      },
      personaDistillationLog,
    );
    logger.info('Persona distiller initialized (model: %s)', summaryConfig.modelRef || 'rule-based');
    if (await personaDistiller.shouldDistill(1, 0)) {
      personaDistiller.distillIncremental().catch(err => logger.warn({ err }, 'Startup persona catch-up failed'));
    }
    let personaDistillTimer: NodeJS.Timeout | undefined;
    let personaNeedsFullRebuild = false;
    memoryChangeCallbacks.push((event) => {
      const isUserPreference = event?.scope === 'user' && event.kind === 'preference';
      const needsFullRebuild = isUserPreference && (event.action === 'delete' || event.action === 'update');
      personaNeedsFullRebuild ||= needsFullRebuild;

      if (isUserPreference && event.action !== 'delete') {
        const applied = personaStore!.applyFastPreference(event.content);
        if (applied) logger.debug({ preference: event.content.slice(0, 120) }, 'Persona fast preference applied');
      }
      if (personaDistillTimer) clearTimeout(personaDistillTimer);
      personaDistillTimer = setTimeout(() => {
        const runFullRebuild = personaNeedsFullRebuild;
        personaNeedsFullRebuild = false;
        const task = runFullRebuild
          ? personaDistiller!.rebuildFull()
          : personaDistiller!.distillIncremental();
        task.catch(err => logger.warn({ err }, runFullRebuild
          ? 'Full persona rebuild failed'
          : 'Incremental persona distillation failed'));
      }, 1500);
      personaDistillTimer.unref?.();
    });
  }

  const memorySummarizer = new MemorySummarizer(
    messageRepository,
    episodeRepository,
    memoryRepository,
    memoryWriter,
    logger,
    summaryConfig,
    personaDistiller,
  );

  const offloadBaseDir = config.memory.offloading?.refDir || path.dirname(config.database.path);
  const offloadDir = path.join(offloadBaseDir, 'offload');
  if (!config.tools.fileRead.allowedRoots.includes(offloadDir)) {
    config.tools.fileRead.allowedRoots.push(offloadDir);
  }

  const memoryDoctor = new MemoryDoctor(db, memoryRepository, personaStore, personaDistiller);

  return {
    embeddingClient,
    memoryRepository,
    embeddingRepository,
    embeddingCacheRepo,
    memoryLinkRepo,
    memoryTermRepo,
    memoryRetriever,
    memoryWriter,
    memoryHygiene,
    memorySummarizer,
    memoryDoctor,
    sessionRepository,
    messageRepository,
    processedMessageRepository,
    episodeRepository,
    toolRunRepository,
    approvalRequestRepo,
    approvalDecisionRepository,
    personaStore,
    personaDistiller,
    personaAuditService,
    sceneClusterer,
    memoryChangeCallbacks,
    offloadDir,
  };
}
