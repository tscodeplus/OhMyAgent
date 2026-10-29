/**
 * Memory summarizer — generates LLM-driven summaries from completed sessions.
 *
 * When a summary LLM is configured (SUMMARY_MODEL in .env):
 *   1. Incrementally summarizes only new messages since the last episode
 *   2. Calls the LLM for a concise summary (always produced) plus a `durable`
 *      list of long-term user attributes (defaults to empty)
 *   3. Runs the write-side gates — shape (§3.2), durability (§3.3) and the
 *      `memory.worth` judgment — then writes only what survives them
 *
 * Falls back to rule-based extraction when no summary LLM is configured.
 */

import type { Logger } from 'pino';
import { i18n } from '../i18n/index.js';
import { generateId } from '../shared/ids.js';
import type { MessageRepository } from './repositories/message-repository.js';
import type { EpisodeRepository } from './repositories/episode-repository.js';
import type { MemoryRepository } from './repositories/memory-repository.js';
import type { MemoryWriter } from './memory-writer.js';
import { openCodeClientOptions } from '../utils/opencode-session.js';
import type { PersonaDistiller } from './persona-distiller.js';
import { detectTopic } from './write/preference-conflict-resolver.js';
import { isDurableShape } from './write/durable-shape.js';
import { assessDurability } from './write/durability.js';
import { judgePreferenceCandidates } from './write/worth-gate.js';
import { hashForObservation, memoryObservability } from './observability.js';
import { judgeExperiences } from './judge-experience-gate.js';
import type { JudgeEngine } from '../judge/engine.js';

export interface SummaryLLMConfig {
  /** Primary model in "provider/model-id" format. */
  modelRef?: string;
  /** Fallback model refs tried in order if the primary fails. */
  fallbackRefs?: string[];
  /** Optional API key overrides by provider name. */
  apiKeys?: Record<string, string>;
  /** Optional base URL overrides by provider name. */
  baseUrls?: Record<string, string>;
  /** Optional base URL override. */
  baseUrl?: string;
  /** Output language for summaries and preferences. "Auto" follows the conversation language. */
  outputLanguage?: string;
  /**
   * `memory.capture.durable_only` — when false, the shape/durability/worth gates
   * in the summarizer are all skipped and every parsed candidate is written, i.e.
   * exactly the behavior before plan §3.2/§3.3. The kind selection in
   * `MemoryWriter.writePreference` is NOT covered by this switch.
   */
  durableOnly?: boolean;
}

export async function resolveSummaryModelConnection(
  cfg: SummaryLLMConfig,
  modelRef: string,
): Promise<{ provider: string; modelId: string; apiKey: string; baseUrl: string }> {
  const idx = modelRef.indexOf('/');
  const provider = idx !== -1 ? modelRef.slice(0, idx) : '';
  const modelId = idx !== -1 ? modelRef.slice(idx + 1) : modelRef;

  // Resolve apiKey: provider-specific → env var → wildcard
  let apiKey = cfg.apiKeys?.[provider] ?? '';
  let baseUrl = cfg.baseUrls?.[provider] ?? cfg.baseUrl;

  try {
    const { getEnvApiKey, getModel } = await import('@earendil-works/pi-ai');
    apiKey ||= getEnvApiKey(provider as any) ?? '';
    if (!baseUrl) {
      const model = getModel(provider as any, modelId as any);
      if (model) baseUrl = (model as any).baseUrl;
    }
  } catch {
    // Keep explicit config/env fallbacks below.
  }

  // Wildcard key as last resort (only if no provider-specific key found)
  if (!apiKey) apiKey = cfg.apiKeys?.['*'] ?? '';

  if (!baseUrl) baseUrl = 'https://api.deepseek.com/v1';
  return { provider, modelId, apiKey, baseUrl };
}

export interface SummarizeOptions {
  maxMessages?: number;
  /** Channel identifier for source tracking (e.g. 'qq', 'feishu', 'wechat'). */
  channel?: string;
  /**
   * Agent id to attribute the extracted session summary to. Callers resolve
   * this per-write at the source (TDAM v1.0.2 lesson: shared mutable writer
   * state / hardcoded ids misform recall attribution). Only summary memories
   * are attributed — preference/fact extraction deliberately stays shared so
   * user-level facts remain reusable across agents at full recall weight.
   */
  agentId?: string | null;
}

export class MemorySummarizer {
  private readonly openai: typeof import('openai').default | null = null;

  constructor(
    private readonly messageRepo: MessageRepository,
    private readonly episodeRepo: EpisodeRepository,
    private readonly memoryRepo: MemoryRepository,
    private readonly memoryWriter: MemoryWriter,
    private readonly logger: Logger,
    private readonly llmConfig?: SummaryLLMConfig,
    private readonly personaDistiller?: PersonaDistiller,
    /** Kernel M2 judged experience gate — reads the live engine via lookup. */
    private readonly judgeGet?: () => JudgeEngine | undefined,
  ) {}

  /**
   * Summarize a session — incrementally since the last episode,
   * then call the summary LLM (or fall back to rule-based).
   */
  async summarizeSession(sessionKey: string, opts?: SummarizeOptions): Promise<void> {
    const maxMessages = opts?.maxMessages ?? 100;
    const channel = opts?.channel ?? null;

    this.logger.info({ sessionKey, channel }, 'Starting session summarization');

    // Incremental: fetch messages from the end (newest first), then filter
    const lastEpisode = this.episodeRepo.findBySessionId(sessionKey).pop();
    const totalCount = this.messageRepo.countBySessionId(sessionKey);

    // Fetch the newest messages (ORDER BY created_at DESC for latest N)
    const fetchLimit = Math.min(maxMessages, totalCount);
    const messages = this.messageRepo.findBySessionIdDesc(sessionKey, fetchLimit, 0);

    if (messages.length === 0) {
      this.logger.debug({ sessionKey }, 'No messages to summarize');
      return;
    }

    // Filter to messages after the last episode, then reverse to chronological order
    const newMessages = (
      lastEpisode ? messages.filter((m) => m.created_at > lastEpisode.created_at) : messages
    )
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .reverse();

    if (newMessages.length === 0) {
      this.logger.debug({ sessionKey }, 'No new messages since last episode');
      return;
    }

    if (this.llmConfig?.modelRef || this.llmConfig?.fallbackRefs?.length) {
      await this.llmSummarize(sessionKey, newMessages, channel, opts?.agentId);
    } else {
      await this.ruleBasedSummarize(sessionKey, newMessages, channel, opts?.agentId);
    }

    // P2: Fire-and-forget persona distillation
    // Runs only when a PersonaDistiller is configured (persona.enabled === true).
    // Non-blocking: failures are logged but never propagated.
    if (this.personaDistiller) {
      try {
        if (await this.personaDistiller.shouldDistill()) {
          await this.personaDistiller.distillIncremental();
          this.logger.info({ sessionKey }, 'User persona updated via incremental distillation');
        }
      } catch (err) {
        this.logger.info({ err, sessionKey }, 'Persona distillation failed (non-fatal)');
      }
    }
  }

  // ─── LLM-driven summary + auto-capture ───

  private async llmSummarize(
    sessionKey: string,
    messages: Array<{ role: string; content: string; created_at: string }>,
    channel: string | null,
    agentId?: string | null,
  ): Promise<void> {
    const transcript = messages.map((m) => `[${m.role}]: ${cleanContent(m.content)}`).join('\n');

    const outputLanguageValue =
      this.llmConfig?.outputLanguage && this.llmConfig.outputLanguage !== 'Auto'
        ? `Write the summary and the durable attributes in ${translateLanguageName(this.llmConfig.outputLanguage)}.`
        : 'Use the same language as the conversation.';

    // Plan §3.2: summarizing the session and harvesting durable user attributes
    // are two jobs. The summary is always produced; `durable` starts empty and
    // the model has to earn every entry.
    const prompt = `You are a conversation analyst. Review the following conversation and:

1. Write a concise summary (2-5 sentences) of what was discussed and decided.
2. Extract ONLY long-term user attributes that stay true across sessions, into an array named "durable":
   - Allowed: how to address the user, their identity/role, long-term preferences (tools, style, habits, language), explicit long-term rules.
   - Forbidden: this task's output format/length requirements, directory or file listings and counts, the current time or an environment snapshot, narration of what already happened ("user asked X, the assistant answered Y"), any temporary state tied to a concrete date.
   These live in the conversation itself and can be found later with session_search; they do not belong in long-term memory.
3. "durable" MUST default to an empty array []. When unsure, leave it empty.
4. ${outputLanguageValue}

Conversation:
${transcript}

Output ONLY valid JSON with this shape:
{"summary":"concise summary","durable":["durable user attribute"]}`;

    try {
      const response = await this.callLLM(prompt);
      const durableOnly = this.durableOnly;
      const { summary, preferences, usedFallback, dropped } = parseSummaryLLMResponse(response, {
        durableOnly,
      });
      if (usedFallback) {
        memoryObservability.record('memory.summary.parse_failed', {
          responseHash: hashForObservation(response),
          responseLength: response.length,
          stage: 'json_parse',
        });
      }
      for (const rejection of dropped) {
        // One row per refused candidate: this is the measurement §5③ reads.
        memoryObservability.record('memory.durability.rejected', {
          reason: rejection.reason,
          candidateHash: hashForObservation(rejection.text),
          candidateLength: rejection.text.length,
        });
        this.logger.debug(
          { sessionKey, reason: rejection.reason, candidate: rejection.text.slice(0, 120) },
          'Dropped non-durable memory candidate',
        );
      }
      const supportedPreferences = preferences.filter((pref) =>
        this.isSupportedByUserMessage(pref, messages),
      );

      // Worth gate (plan §3.3): the judge must recognise a reusable attribute
      // before it is persisted. `durable_only: false` is the whole-subsystem
      // rollback and skips all three gates together.
      const durablePreferences = durableOnly
        ? await judgePreferenceCandidates({
            candidates: supportedPreferences,
            sessionScenario: summary.slice(0, 200),
            judgeGet: this.judgeGet,
            sessionId: sessionKey,
            logger: this.logger,
          })
        : supportedPreferences;

      // Store episode
      const episodeId = generateId();
      this.episodeRepo.create({
        id: episodeId,
        session_id: sessionKey,
        summary,
        key_points: JSON.stringify(durablePreferences),
      });

      // Kernel M2 (`memory.capture`/`memory.worth`): judged experience gate —
      // additive judged capture candidates from rule-setting user messages.
      // No-op in every mode/absence combination; failures are contained.
      try {
        await judgeExperiences({
          judgeGet: this.judgeGet,
          sessionKey,
          messages: messages.map((m) => ({ role: m.role, content: cleanContent(m.content) })),
          writer: this.memoryWriter,
          channel,
          logger: this.logger,
        });
      } catch (err) {
        this.logger.debug({ err, sessionKey }, 'Judged experience gate skipped');
      }

      // Store summary as session-level memory.
      // Preferences below are intentionally NOT attributed: user-level facts
      // stay in the shared pool so every agent recalls them at full weight.
      await this.memoryWriter.writeSummary(sessionKey, summary, undefined, channel, agentId);

      // Auto-capture durable user attributes
      for (const pref of durablePreferences) {
        await this.memoryWriter.writePreference(sessionKey, pref, undefined, channel);
        this.logger.debug({ sessionKey, preference: pref, channel }, 'Auto-captured preference');
      }

      this.logger.info(
        {
          sessionKey,
          episodeId,
          messageCount: messages.length,
          candidates: preferences.length,
          preferenceCount: durablePreferences.length,
        },
        'LLM session summarized',
      );
    } catch (err) {
      this.logger.info({ err, sessionKey }, 'LLM summarization failed, falling back to rule-based');
      await this.ruleBasedSummarize(sessionKey, messages, channel);
    }
  }

  private isSupportedByUserMessage(
    preference: string,
    messages: Array<{ role: string; content: string }>,
  ): boolean {
    const topic = detectTopic(preference);
    if (topic !== 'preferred_name') return true;

    const name = extractPreferredName(preference);
    if (!name) return false;

    return messages.some((m) => m.role === 'user' && extractPreferredName(m.content) === name);
  }

  /** `memory.capture.durable_only` — one switch for all three write-side gates. */
  private get durableOnly(): boolean {
    return this.llmConfig?.durableOnly !== false;
  }

  private parseResponse(response: string): { summary: string; preferences: string[] } {
    const parsed = parseSummaryLLMResponse(response, { durableOnly: this.durableOnly });
    return { summary: parsed.summary, preferences: parsed.preferences };
  }

  private async callLLM(prompt: string): Promise<string> {
    const cfg = this.llmConfig!;

    // Build model chain: primary + fallbacks
    const modelRefs = [...(cfg.modelRef ? [cfg.modelRef] : []), ...(cfg.fallbackRefs ?? [])];

    let lastError: string | null = null;

    for (const modelRef of modelRefs) {
      const { provider, modelId, apiKey, baseUrl } = await resolveSummaryModelConnection(
        cfg,
        modelRef,
      );

      try {
        const OpenAI = (await import('openai')).default;
        const client = new OpenAI({
          apiKey,
          baseURL: baseUrl,
          // opencode rejects header-less requests (MissingSessionID / free-tier restriction)
          ...openCodeClientOptions(provider, baseUrl),
        });

        const completion = await client.chat.completions.create({
          model: modelId,
          messages: [
            {
              role: 'system',
              content:
                'You are a precise conversation analyst. Always respond in the requested format.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 2000,
        });

        return completion.choices[0]?.message?.content ?? '';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug({ modelRef, err: msg.slice(0, 100) }, 'Summary LLM attempt failed');
        lastError = msg;
        // Continue to next fallback
      }
    }

    throw new Error(`All summary models failed. Last error: ${lastError}`);
  }

  // ─── Rule-based fallback ───

  private async ruleBasedSummarize(
    sessionKey: string,
    messages: Array<{ role: string; content: string; created_at: string }>,
    channel: string | null,
    agentId?: string | null,
  ): Promise<void> {
    const userMessages = messages.filter((m) => m.role === 'user');
    const assistantMessages = messages.filter((m) => m.role === 'assistant');

    const userTopics = userMessages
      .map((m) => cleanContent(m.content))
      .filter((c) => c.length > 0)
      .slice(0, 10);

    const conclusions = assistantMessages
      .slice(-2)
      .map((m) => cleanContent(m.content))
      .filter((c) => c.length > 0 && !userTopics.includes(c));

    const summaryText = [
      userTopics.length > 0
        ? `${i18n.t('memory:ruleBasedUserTopics')}: ${userTopics.join('; ')}`
        : '',
      conclusions.length > 0
        ? `${i18n.t('memory:ruleBasedAssistantConclusions')}: ${conclusions.join('; ')}`
        : '',
      `${i18n.t('memory:ruleBasedStats')}: ${messages.length} messages, ${userMessages.length} user / ${assistantMessages.length} assistant`,
    ]
      .filter(Boolean)
      .join('\n');

    const keyPoints = [...userTopics, ...conclusions];

    const episodeId = generateId();
    this.episodeRepo.create({
      id: episodeId,
      session_id: sessionKey,
      summary: summaryText,
      key_points: JSON.stringify(keyPoints),
    });

    await this.memoryWriter.write({
      content: summaryText,
      scope: 'session',
      scopeKey: sessionKey,
      kind: 'summary',
      sourceChannel: channel,
      agentId: agentId ?? undefined,
    });

    // Kernel M2: judged experience gate — same additive judged capture the
    // LLM path gets (no-op unless both judged points are active).
    try {
      await judgeExperiences({
        judgeGet: this.judgeGet,
        sessionKey,
        messages: messages.map((m) => ({ role: m.role, content: cleanContent(m.content) })),
        writer: this.memoryWriter,
        channel,
        logger: this.logger,
      });
    } catch (err) {
      this.logger.debug({ err, sessionKey }, 'Judged experience gate skipped');
    }

    this.logger.info(
      { sessionKey, episodeId, messageCount: messages.length, topicCount: userTopics.length },
      'Session summarized (rule-based)',
    );
  }
}

/**
 * Why a candidate never reached the write path. `shape` is §3.2 (the model
 * narrated the session instead of stating an attribute), `durability` is §3.3
 * (the candidate is provably a transient: a listing, a past event, this task's
 * output format).
 */
export type DurableRejectionReason = 'shape' | 'durability';

export interface RejectedCandidate {
  text: string;
  reason: DurableRejectionReason;
}

export interface SummaryParseOptions {
  /** `memory.capture.durable_only` — default true. False = pre-plan behavior. */
  durableOnly?: boolean;
}

export interface ParsedSummary {
  summary: string;
  /** Kept candidates. The field keeps its old name on purpose (§3.2 兼容): it is
   * the parser's output for both the JSON and the degraded PREF: path. */
  preferences: string[];
  usedFallback: boolean;
  /** Candidates the deterministic gates refused, for observability. */
  dropped: RejectedCandidate[];
}

/**
 * The two deterministic gates, in the documented order. Applied at the parse
 * layer so BOTH the JSON path and the degraded `PREF:` path are covered — the
 * degraded path exists precisely because the model misbehaved, so it is the last
 * one that should be trusted with unfiltered output.
 */
function gateCandidates(candidates: string[]): {
  kept: string[];
  dropped: RejectedCandidate[];
} {
  const kept: string[] = [];
  const dropped: RejectedCandidate[] = [];
  for (const candidate of candidates) {
    if (!isDurableShape(candidate)) {
      dropped.push({ text: candidate, reason: 'shape' });
      continue;
    }
    if (assessDurability(candidate) === 'volatile') {
      dropped.push({ text: candidate, reason: 'durability' });
      continue;
    }
    kept.push(candidate);
  }
  return { kept, dropped };
}

export function parseSummaryLLMResponse(
  response: string,
  options?: SummaryParseOptions,
): ParsedSummary {
  const fromJson = parseSummaryJson(response) ?? parseSummaryJson(extractJsonFence(response));
  const parsed = fromJson ?? parsePrefixSummaryResponse(response);
  const durableOnly = options?.durableOnly !== false;
  const gated = durableOnly
    ? gateCandidates(parsed.preferences)
    : { kept: parsed.preferences, dropped: [] as RejectedCandidate[] };
  return {
    summary: parsed.summary,
    preferences: gated.kept,
    usedFallback: !fromJson,
    dropped: gated.dropped,
  };
}

function parseSummaryJson(
  response: string | null,
): { summary: string; preferences: string[] } | null {
  if (!response) return null;
  try {
    const value = JSON.parse(response.trim()) as unknown;
    if (!value || typeof value !== 'object') return null;
    // `durable` is what the §3.2 prompt asks for; `preferences` is the pre-plan
    // field name, still accepted so an older/other model shape is not discarded.
    const obj = value as { summary?: unknown; preferences?: unknown; durable?: unknown };
    if (typeof obj.summary !== 'string') return null;
    const summary = obj.summary.trim().slice(0, 1000);
    if (!summary) return null;
    const list = Array.isArray(obj.durable) ? obj.durable : obj.preferences;
    const preferences = Array.isArray(list)
      ? list
          .filter((pref): pref is string => typeof pref === 'string')
          .map((pref) => pref.trim())
          .filter((pref) => pref.length > 2)
          .slice(0, 10)
      : [];
    return { summary, preferences };
  } catch {
    return null;
  }
}

function extractJsonFence(response: string): string | null {
  const match = response.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() ?? null;
}

function parsePrefixSummaryResponse(response: string): { summary: string; preferences: string[] } {
  const lines = response
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const summaryLines: string[] = [];
  const preferences: string[] = [];

  let inPrefs = false;
  for (const line of lines) {
    if (line.startsWith('PREF:') || line.startsWith('PREF：')) {
      inPrefs = true;
      const pref = line.replace(/^PREF[：:]\s*/, '').trim();
      if (pref && pref.length > 2) preferences.push(pref);
    } else if (line.startsWith('SUMMARY:') || line.startsWith('SUMMARY：')) {
      inPrefs = false;
      const s = line.replace(/^SUMMARY[：:]\s*/, '').trim();
      if (s) summaryLines.push(s);
    } else if (inPrefs) {
      if (line.length > 2) {
        const last = preferences.pop() ?? '';
        preferences.push(last ? `${last} ${line}` : line);
      }
    } else {
      summaryLines.push(line);
    }
  }

  return {
    summary: summaryLines.join(' ').slice(0, 1000) || 'Session summary unavailable.',
    preferences: preferences.slice(0, 10),
  };
}

/**
 * Clean message content — handles both plain text and leftover JSON array strings.
 */
// Map English language names to localized names (used in summarizer prompts).
function translateLanguageName(name: string): string {
  const key = `memory:languageNames.${name.replace(/\s+/g, '')}`;
  const result = i18n.t(key);
  // i18next returns the key itself when translation is missing
  return result === key ? name : result;
}

function cleanContent(content: string): string {
  if (content.startsWith('[{') || content.startsWith('[\n{')) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
          .map((b: any) => b.text)
          .join(' ');
      }
    } catch {
      // Not valid JSON, treat as plain text
    }
  }
  return content.slice(0, 200);
}

function cleanName(name: string): string {
  return name
    .replace(/^[''""「」『』]+/, '')
    .replace(/[''""「」『』]+$/, '')
    .trim();
}

function extractPreferredName(content: string): string | null {
  const patterns = [
    /(?:称呼|称谓)偏好(?:是|为|[:：])?\s*[""'']*([^"'""''\s，,;。.]{1,24})/,
    /(?:我|用户)(?:希望|想|要|偏好|喜欢)被称呼为\s*[""'']*([^"'""''\s，,;。.]{1,24})/,
    /(?:我|用户)(?:希望|想|要|偏好|喜欢)?称呼为\s*[""'']*([^"'""''\s，,;。.]{1,24})/,
    /(?:以后)?(?:称呼|叫|喊)(?:我|用户|其)(?:为|成|作)?\s*[""'']*([^"'""''\s，,;。.]{1,24})/,
    /(?:call\s+me|call\s+the\s+user)\s*[""'']*([^"'""''\s，,;。.]{1,24})/i,
  ];
  for (const pattern of patterns) {
    const match = content.match(pattern);
    const raw = match?.[1]?.trim();
    if (!raw) continue;
    const name = cleanName(raw);
    if (name && !['我', '用户', '自己'].includes(name)) return name;
  }
  return null;
}
