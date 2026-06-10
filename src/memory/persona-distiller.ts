/**
 * PersonaDistiller — LLM-driven user persona generation and incremental update.
 *
 * Uses the DistillerLLM interface to distill preference memories into a
 * structured UserPersona (full) or PartialPersona (incremental).
 *
 * For production usage, create a DistillerLLM via createDistillerLLM(config, logger),
 * then pass it to the PersonaDistiller constructor.
 */

import { extractJson } from './json-utils.js';
import type { Logger } from 'pino';
import type { Memory } from './repositories/memory-repository.js';
import { resolveSummaryModelConnection, type SummaryLLMConfig } from './memory-summarizer.js';
import {
  createEmptyPersona,
  personaJsonSchema,
  partialPersonaJsonSchema,
  personaSchemaForPrompt,
  partialPersonaSchemaForPrompt,
  personaToJson,
  mergePartialPersona,
} from './persona-model.js';
import type { UserPersona, PartialPersona } from './persona-model.js';

/**
 * Narrow query interface for the distiller.
 * The production MemoryRepository implements this side-by-side with its
 * other query methods; tests can provide a minimal mock.
 */
export interface PreferenceQuery {
  findByScopeKind(scope: string, kind: string): Memory[];
}

// ---------------------------------------------------------------------------
// PersonaStore interface
// ---------------------------------------------------------------------------

/**
 * Storage abstraction for reading and persisting a UserPersona.
 * Compatible with the concrete `PersonaStore` class in persona-store.ts
 * (which exposes `get(): UserPersona | null` and `save(persona): void`).
 */
export interface PersonaStore {
  get(): UserPersona | null;
  save(persona: UserPersona): void;
  applyFastPreference?(content: string): boolean;
}

// ---------------------------------------------------------------------------
// DistillerLLM interface & factory
// ---------------------------------------------------------------------------

/**
 * LLM abstraction for the distiller.
 * The `call` method should return valid JSON as a string.
 */
export interface DistillerLLM {
  call(systemPrompt: string, userPrompt: string): Promise<string>;
}

/**
 * Create a production DistillerLLM from SummaryLLMConfig.
 *
 * Replicates the callLLM logic from MemorySummarizer:
 *  - Primary model + fallback chain
 *  - OpenAI client with resolved provider/model, API key, and base URL
 *  - Temperature 0.3, max_tokens 2000
 *  - Throws when all models fail
 */
export async function createDistillerLLM(
  config: SummaryLLMConfig,
  logger: Logger,
): Promise<DistillerLLM> {
  return {
    async call(systemPrompt: string, userPrompt: string): Promise<string> {
      const modelRefs = [
        ...(config.modelRef ? [config.modelRef] : []),
        ...(config.fallbackRefs ?? []),
      ];

      let lastError: string | null = null;

      for (const modelRef of modelRefs) {
        const { modelId, apiKey, baseUrl } = await resolveSummaryModelConnection(config, modelRef);

        try {
          const OpenAI = (await import('openai')).default;
          const client = new OpenAI({ apiKey, baseURL: baseUrl });

          const completion = await client.chat.completions.create({
            model: modelId,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            temperature: 0.3,
            max_tokens: 2000,
          });

          const content = completion.choices[0]?.message?.content ?? '';
          if (!content) {
            throw new Error('Empty LLM response');
          }
          return content;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ modelRef, err: msg.slice(0, 100) }, 'Distiller LLM attempt failed');
          lastError = msg;
          // Continue to next fallback
        }
      }

      throw new Error(`All distiller models failed. Last error: ${lastError}`);
    },
  };
}

// ---------------------------------------------------------------------------
// PersonaDistiller
// ---------------------------------------------------------------------------

function buildSystemPrompt(outputLanguage?: string): string {
  const isChinese = outputLanguage === 'Simplified Chinese'
    || outputLanguage === 'Traditional Chinese';
  if (isChinese) {
    return '你是一个精确的用户画像分析师。根据用户偏好记忆，提取或更新用户画像。\n'
      + '只输出 JSON，不要有其他文本。使用中文。';
  }
  // Match the summarizer's localized system prompt approach:
  // for Auto or any non-Chinese language, use English (LLM follows outputLanguage
  // instruction in the user prompt).
  return 'You are a precise user persona analyst. Extract or update user persona '
    + 'from preference memories.\nOutput ONLY JSON, no other text.';
}

function buildFullDistillExtra(outputLanguage?: string): string {
  const isChinese = outputLanguage === 'Simplified Chinese'
    || outputLanguage === 'Traditional Chinese';
  return isChinese
    ? '注意：你生成的是完整的用户画像，必须包含所有字段。'
    : 'Note: You are generating a complete user persona. All fields must be included.';
}

function buildIncrementalExtra(outputLanguage?: string): string {
  const isChinese = outputLanguage === 'Simplified Chinese'
    || outputLanguage === 'Traditional Chinese';
  return isChinese
    ? '注意：这是增量更新，你只需返回有变化的字段。保留现有画像中合理的部分，仅根据新增偏好进行更新。'
    : 'Note: Incremental update — return only changed fields. Preserve reasonable existing persona parts and only update based on new preferences.';
}

function timestampMs(value: string | undefined): number {
  if (!value) return 0;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

function memoryChangedMs(memory: Memory): number {
  return Math.max(timestampMs(memory.created_at), timestampMs(memory.updated_at));
}

export class PersonaDistiller {
  private readonly outputLanguage: string | undefined;

  constructor(
    private readonly llm: DistillerLLM,
    private readonly memoryRepo: PreferenceQuery,
    private readonly personaStore: PersonaStore,
    private readonly logger: Logger,
    private readonly config: {
      distillThreshold?: number;
      minDistillIntervalHours?: number;
      outputLanguage?: string;
    } = {},
    private readonly distillationLog?: { startRun(mode: string, count: number): string; finishRun(id: string, error?: string): void },
  ) {
    this.outputLanguage = config.outputLanguage;
  }

  /**
   * Full distillation: distill all preference memories into a complete UserPersona.
   *
   * - 0 preferences → returns `createEmptyPersona()`
   * - LLM failure or invalid JSON → returns `createEmptyPersona()` (no throw)
   */
  async distillFull(): Promise<UserPersona> {
    const preferences = this.memoryRepo.findByScopeKind('user', 'preference');
    if (preferences.length === 0) {
      this.logger.debug('No preferences found for full distillation, returning empty persona');
      return createEmptyPersona();
    }

    const prefList = preferences
      .map((p, i) => `${i + 1}. ${p.content}`)
      .join('\n');

    const schema = personaSchemaForPrompt();
    const userPrompt = [
      '请根据以下用户偏好记忆，生成完整的用户画像 JSON。',
      '',
      '偏好列表：',
      prefList,
      '',
      '请严格按照以下 JSON Schema 输出：',
      schema,
    ].join('\n');

    try {
      const response = await this.llm.call(
        `${buildSystemPrompt(this.outputLanguage)}\n${buildFullDistillExtra(this.outputLanguage)}`,
        userPrompt,
      );
      return this.parseFullResponse(response) ?? createEmptyPersona();
    } catch (err) {
      this.logger.warn({ err }, 'Full distillation LLM failed, returning empty persona');
      return createEmptyPersona();
    }
  }

  /**
   * Safely rebuild and persist the persona from all current preference memories.
   *
   * Unlike the old implementation, the safety net (applyFastPreference) runs
   * AFTER the try/catch so it always executes — even when the LLM rebuild fails.
   * This prevents stale preferred_name references from persisting in the persona.
   */
  async rebuildFull(): Promise<boolean> {
    const preferences = this.memoryRepo.findByScopeKind('user', 'preference');
    const activePreferences = preferences.filter(p => (p as any).status !== 'deleted' && (p as any).status !== 'superseded');
    const runId = this.distillationLog?.startRun('rebuild', activePreferences.length);

    if (activePreferences.length === 0) {
      this.personaStore.save(createEmptyPersona());
      this.logger.info('Persona reset because no active preference memories remain');
      this.distillationLog?.finishRun(runId!);
      return true;
    }

    const prefList = activePreferences
      .map((p, i) => `${i + 1}. ${p.content}`)
      .join('\n');

    const schema = personaSchemaForPrompt();
    const userPrompt = [
      '请根据以下当前仍然存在的用户偏好记忆，重新生成完整的用户画像 JSON。',
      '',
      '偏好列表：',
      prefList,
      '',
      '请严格按照以下 JSON Schema 输出：',
      schema,
    ].join('\n');

    let rebuildSucceeded = false;
    try {
      const response = await this.llm.call(
        `${buildSystemPrompt(this.outputLanguage)}\n${buildFullDistillExtra(this.outputLanguage)}`,
        userPrompt,
      );
      const persona = this.parseFullResponse(response);
      if (persona) {
        this.personaStore.save(persona);
        this.logger.info('Persona rebuilt from current active preferences');
        rebuildSucceeded = true;
      } else {
        this.logger.warn('Full distillation returned invalid JSON, keeping existing persona');
      }
    } catch (err) {
      this.logger.warn({ err }, 'Full persona rebuild LLM failed, preserving existing persona');
    }

    // Safety net: always run after rebuild attempt, success or failure.
    // Ensures preferred_name preferences directly patch the persona
    // communication field even when the LLM rebuild fails.
    if (this.personaStore.applyFastPreference) {
      for (const p of activePreferences) {
        this.personaStore.applyFastPreference(p.content);
      }
    }

    this.distillationLog?.finishRun(runId!,
      rebuildSucceeded ? undefined : 'LLM rebuild did not produce valid persona');
    return rebuildSucceeded;
  }

  /**
   * Incremental distillation: update an existing persona based on preferences
   * added after the given `since` timestamp.
   *
   * When `since` is omitted, the method reads `lastUpdated` from the stored
   * persona (or epoch if none exists).
   *
   * After successfully obtaining a partial update from the LLM, the result is
   * merged into the existing persona and persisted via `personaStore.save()`.
   * This makes the call truly fire-and-forget for the caller.
   *
   * - Returns `{}` when there are no new preferences.
   * - Returns `{}` when the LLM call fails.
   */
  async distillIncremental(since?: string): Promise<PartialPersona> {
    if (since === undefined) {
      const stored = this.personaStore.get();
      since = stored?.lastUpdated ?? new Date(0).toISOString();
    }

    const preferences = this.memoryRepo.findByScopeKind('user', 'preference');
    const activePrefs = preferences.filter(p => (p as any).status !== 'deleted' && (p as any).status !== 'superseded');
    const sinceMs = timestampMs(since);
    const newPrefs = activePrefs.filter(p => memoryChangedMs(p) > sinceMs);

    if (newPrefs.length === 0) {
      this.logger.debug({ since }, 'No new preferences for incremental distillation');
      return {};
    }

    const runId = this.distillationLog?.startRun('incremental', newPrefs.length);

    const currentPersona = this.personaStore.get();
    const existingJson = currentPersona
      ? personaToJson(currentPersona)
      : '无现有画像';

    const prefList = newPrefs
      .map((p, i) => `${i + 1}. ${p.content}`)
      .join('\n');

    const schema = partialPersonaSchemaForPrompt();
    const userPrompt = [
      '请根据现有用户画像和新增偏好记忆，更新用户画像。',
      '',
      '现有用户画像：',
      existingJson,
      '',
      '新增偏好：',
      prefList,
      '',
      '请严格按照以下 JSON Schema 输出（只需返回有变化的字段）：',
      schema,
    ].join('\n');

    try {
      const response = await this.llm.call(
        `${buildSystemPrompt(this.outputLanguage)}\n${buildIncrementalExtra(this.outputLanguage)}`,
        userPrompt,
      );
      const partial = this.parsePartialResponse(response);

      // Merge and persist when we got meaningful updates
      if (Object.keys(partial).length > 0) {
        const base = this.personaStore.get() ?? createEmptyPersona();
        const merged = mergePartialPersona(base, partial);
        this.personaStore.save(merged);
        this.logger.info('Persona updated via incremental distillation');
      }

      this.distillationLog?.finishRun(runId!);
      return partial;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err }, 'Incremental distillation LLM failed, returning empty update');
      this.distillationLog?.finishRun(runId!, errorMsg);
      return {};
    }
  }

  /**
   * Check whether a new distillation should be triggered.
   *
   * Compares the number of `preference` memories added since the existing
   * persona's `lastUpdated` against `threshold` (default 5).
   *
   * @param threshold — minimum number of new preferences to trigger (default 5)
   */
  async shouldDistill(threshold?: number, minIntervalHours?: number): Promise<boolean> {
    const th = threshold ?? this.config.distillThreshold ?? 5;
    const persona = this.personaStore.get();
    const since = persona?.lastUpdated ?? new Date(0).toISOString();

    const minHours = minIntervalHours ?? this.config.minDistillIntervalHours ?? 0;
    if (persona && minHours > 0) {
      const lastUpdatedMs = new Date(persona.lastUpdated).getTime();
      if (Number.isFinite(lastUpdatedMs) && Date.now() - lastUpdatedMs < minHours * 60 * 60 * 1000) {
        return false;
      }
    }

    const preferences = this.memoryRepo.findByScopeKind('user', 'preference');
    const sinceMs = timestampMs(since);
    const newCount = preferences.filter(p => memoryChangedMs(p) > sinceMs).length;

    return newCount >= th;
  }

  // ── Private helpers ──

  private parseFullResponse(response: string): UserPersona | null {
    const cleaned = extractJson(response);
    if (!cleaned) {
      this.logger.warn('No valid JSON found in LLM response for full distillation');
      return null;
    }
    try {
      const parsed = JSON.parse(cleaned);
      const result = personaJsonSchema.safeParse(parsed);
      if (result.success) {
        return result.data as UserPersona;
      }
      this.logger.warn(
        { errors: result.error.format() },
        'Full distillation JSON validation failed',
      );
      return null;
    } catch {
      this.logger.warn('Failed to parse LLM response JSON for full distillation');
      return null;
    }
  }

  private parsePartialResponse(response: string): PartialPersona {
    const cleaned = extractJson(response);
    if (!cleaned) {
      this.logger.warn('No valid JSON found in LLM response for incremental distillation');
      return {};
    }
    try {
      const parsed = JSON.parse(cleaned);
      const result = partialPersonaJsonSchema.safeParse(parsed);
      if (result.success) {
        return result.data as PartialPersona;
      }
      this.logger.warn(
        { errors: result.error.format() },
        'Incremental distillation JSON validation failed',
      );
      return {};
    } catch {
      this.logger.warn('Failed to parse LLM response JSON for incremental distillation');
      return {};
    }
  }
}
