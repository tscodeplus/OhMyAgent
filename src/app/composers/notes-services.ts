/**
 * Compose the notes layer (MyDocs/NOTES_LAYER_PLAN.md §10).
 *
 * A composer of its own rather than another branch inside `memory-services.ts`,
 * for one reason: notes are **not** part of memory. They share the database and
 * the aux model chain and nothing else — no injection, no retrieval lane, no
 * memory linkage (§8). Building it separately keeps "which switch turns this off"
 * answerable by reading one file, and keeps a notes failure from being able to
 * break memory construction.
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
import { BODY_MAX_DEFAULT, MAX_NOTES_DEFAULT } from '../../notes/output-budget.js';
import { createNotesService } from '../../notes/service.js';
import type { NotesRuntimeConfig, NotesService } from '../../notes/service-contract.js';

export interface NotesServices {
  /** Absent when `notes.enabled` is false (or construction failed). */
  notesService?: NotesService;
  notesRepository?: NotesRepository;
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
    windowTurns: notes?.capture?.windowTurns ?? 5,
    tokenBudget: notes?.capture?.tokenBudget ?? 4000,
    includeTools: notes?.capture?.includeTools ?? 'off',
    redact: notes?.capture?.redact ?? true,
    bodyMaxChars: notes?.capture?.bodyMaxChars ?? BODY_MAX_DEFAULT,
    maxOutputTokens: notes?.capture?.maxOutputTokens,
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
  const modelRef = config.notes.capture?.modelRef ?? '';
  if ((config.notes.capture?.maxNotesPerCapture ?? 3) === 0) {
    // Explicitly zero drafts per capture: the layer is on (pages remain readable)
    // but nothing may be distilled. Building the service anyway keeps the read
    // API available, which is what the WebUI needs to show existing notes.
    logger.info('Notes layer enabled with capture disabled (maxNotesPerCapture = 0)');
  }

  try {
    const repository = new NotesRepository(db);
    const modelConfig = resolveNotesModelConfig(input.auxConfig, modelRef);
    const pipeline = new CapturePipeline({
      repository,
      db,
      getConfig: () => readNotesRuntimeConfig(config),
      auxConfig: modelConfig,
      logger,
    });
    const service = createNotesService({
      repository,
      capture: pipeline,
      getConfig: () => readNotesRuntimeConfig(config),
      logger,
    });
    logger.info('Notes service initialized (capture → draft → human review)');
    return { notesService: service, notesRepository: repository };
  } catch (err) {
    logger.warn({ err }, 'Notes service init failed — routes and capture stay off');
    return {};
  }
}
