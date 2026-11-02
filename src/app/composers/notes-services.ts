/**
 * Compose the notes layer (MyDocs/NOTES_LAYER_PLAN.md §10).
 *
 * A composer of its own rather than another branch inside `memory-services.ts`,
 * for one reason: notes are **not** part of memory. They share the database and
 * the aux model chain and nothing else — no memory linkage (§8), no shared schema,
 * no shared ranking. Since the review's §4 U1 the layer does have its own read
 * paths (`notes_search` and the `<notes_context>` block), but they are wired
 * through the service this file returns, which is also the switch: when
 * `notes.enabled` is false nothing is constructed and both go away. Building it
 * separately keeps "which switch turns this off" answerable by reading one file,
 * and keeps a notes failure from being able to break memory construction.
 *
 * Only `notes.enabled` is read here: the numeric knobs (`capture.*`, `draft.*`)
 * are hot-reloadable, so they are read through `getConfig()` on every call rather
 * than snapshotted into the instance. `capture.modelRef` is the exception by
 * design — it is resolved into the shared aux chain at construction (see
 * `resolveNotesModelConfig`), exactly like the aux model itself.
 */

import type { Logger } from 'pino';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../types.js';
import type { AuxModelConfig } from '../../memory/aux-llm-client.js';
import { CapturePipeline } from '../../notes/capture.js';
import { NotesRepository } from '../../notes/repository.js';
import {
  BODY_MAX_DEFAULT,
  MAX_NOTES_DEFAULT,
  SESSION_ROWS_DEFAULT,
} from '../../notes/output-budget.js';
import { createNotesService } from '../../notes/service.js';
import { configEventBus } from '../config-event-bus.js';
import type { NotesRuntimeConfig, NotesService } from '../../notes/service-contract.js';

export interface NotesServices {
  /** Absent when `notes.enabled` is false (or construction failed). */
  notesService?: NotesService;
  notesRepository?: NotesRepository;
  /**
   * The live capture numbers, as the pipeline sees them.
   *
   * Exists because "was this value actually applied" is otherwise a question you can
   * only answer with a model call and a stopwatch — and the answer used to be "no"
   * for every `notes.capture.*` field.
   */
  readRuntimeConfig?: () => NotesRuntimeConfig;
}

export interface NotesComposerInput {
  config: AppConfig;
  db: Database.Database;
  logger: Logger;
  /** The shared aux chain, by reference — hot reloads mutate it in place. */
  auxConfig: AuxModelConfig;
}

/**
 * The per-call config the service reads.
 *
 * `modelRef` is surfaced for diagnostics only: the actual chain is the aux config
 * (overridden at construction when `notes.capture.modelRef` is set).
 */
export function readNotesRuntimeConfig(config: AppConfig): NotesRuntimeConfig {
  // A partial config object is tolerated rather than assumed: this composer runs
  // during bootstrap, where a missing section must degrade to "layer off" instead
  // of taking the process down. In production the schema always fills these in.
  const notes = config.notes;
  return {
    maxNotesPerCapture: notes?.capture?.maxNotesPerCapture ?? MAX_NOTES_DEFAULT,
    sessionRows: notes?.capture?.sessionRows ?? SESSION_ROWS_DEFAULT,
    includeTools: notes?.capture?.includeTools ?? 'off',
    redact: notes?.capture?.redact ?? true,
    bodyMaxChars: notes?.capture?.bodyMaxChars ?? BODY_MAX_DEFAULT,
    maxOutputTokens: notes?.capture?.maxOutputTokens,
    thinking: notes?.capture?.thinking ?? 'inherit',
    temperature: notes?.capture?.temperature ?? 0.2,
    ttlDays: notes?.draft?.ttlDays ?? 14,
    logRetentionDays: notes?.logRetentionDays ?? 90,
    modelRef: notes?.capture?.modelRef ?? '',
  };
}

/**
 * Apply `notes.capture.modelRef` on top of the aux chain.
 *
 * A dedicated extraction model belongs at the *front* of the chain with the aux
 * model as fallback: overriding both would turn a configured extraction model
 * into a single point of failure for capture.
 */
export function resolveNotesModelConfig(
  auxConfig: AuxModelConfig,
  modelRef: string,
): AuxModelConfig {
  const trimmed = modelRef.trim();
  if (!trimmed) return auxConfig;
  return {
    ...auxConfig,
    modelRef: trimmed,
    fallbackRefs: [auxConfig.modelRef, ...(auxConfig.fallbackRefs ?? [])].filter(
      (ref): ref is string => typeof ref === 'string' && ref.length > 0,
    ),
  };
}

export function createNotesServices(input: NotesComposerInput): NotesServices {
  const { config, db, logger } = input;
  if (!config.notes?.enabled) return {};
  /**
   * The config the service reads on every capture, replaced on hot reload.
   *
   * It was the bootstrap `AppConfig` object, captured by the `getConfig` closures —
   * so `notes.capture.body_max_chars`, `max_notes_per_capture` and the rest were read
   * once, at boot, and every later edit was invisible — a changed number still behaved
   * like the old one, which looks exactly like the setting working. `modelRef` stays a restart (the aux chain is built from it), and
   * `notes.enabled` stays a restart (routes are wired from it).
   */
  let runtimeConfig = config;
  const modelRef = config.notes.capture?.modelRef ?? '';
  if ((config.notes.capture?.maxNotesPerCapture ?? 3) === 0) {
    // Explicitly zero drafts per capture: the layer is on (pages remain readable)
    // but nothing may be distilled. Building the service anyway keeps the read
    // API available, which is what the WebUI needs to show existing notes.
    logger.info('Notes layer enabled with capture disabled (maxNotesPerCapture = 0)');
  }

  try {
    // The logger goes into the repository so a corrupt JSON column (`tags`,
    // `fields`) leaves a warning naming the note and the column: the row still
    // renders as empty, which without that line is indistinguishable from a note
    // that never had tags.
    const repository = new NotesRepository(db, logger);
    const modelConfig = resolveNotesModelConfig(input.auxConfig, modelRef);
    const pipeline = new CapturePipeline({
      repository,
      db,
      getConfig: () => readNotesRuntimeConfig(runtimeConfig),
      auxConfig: modelConfig,
      logger,
    });
    const service = createNotesService({
      repository,
      capture: pipeline,
      getConfig: () => readNotesRuntimeConfig(runtimeConfig),
      logger,
    });
    configEventBus.onReload((next) => {
      runtimeConfig = next;
    });
    logger.info('Notes service initialized (capture → draft → human review)');
    return {
      notesService: service,
      notesRepository: repository,
      readRuntimeConfig: () => readNotesRuntimeConfig(runtimeConfig),
    };
  } catch (err) {
    logger.warn({ err }, 'Notes service init failed — routes and capture stay off');
    return {};
  }
}
