/**
 * Memory summarizer — generates LLM-driven summaries from completed sessions.
 *
 * When a summary LLM is configured (SUMMARY_MODEL in .env):
 *   1. Incrementally summarizes only new messages since the last episode
 *   2. Calls the LLM to produce a concise summary + extract user preferences
 *   3. Auto-captures extracted preferences via MemoryWriter
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
import type { PersonaDistiller } from './persona-distiller.js';
import { detectTopic } from './write/preference-conflict-resolver.js';
import { hashForObservation, memoryObservability } from './observability.js';

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
    const newMessages = (lastEpisode
      ? messages.filter(m => m.created_at > lastEpisode.created_at)
      : messages)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .reverse();

    if (newMessages.length === 0) {
      this.logger.debug({ sessionKey }, 'No new messages since last episode');
      return;
    }

    if (this.llmConfig?.modelRef || this.llmConfig?.fallbackRefs?.length) {
      await this.llmSummarize(sessionKey, newMessages, channel);
    } else {
      await this.ruleBasedSummarize(sessionKey, newMessages, channel);
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
        this.logger.warn({ err, sessionKey }, 'Persona distillation failed (non-fatal)');
      }
    }
  }

  // ─── LLM-driven summary + auto-capture ───

  private async llmSummarize(
    sessionKey: string,
    messages: Array<{ role: string; content: string; created_at: string }>,
    channel: string | null,
  ): Promise<void> {
    const transcript = messages
      .map(m => `[${m.role}]: ${cleanContent(m.content)}`)
      .join('\n');

    const outputLanguageValue = this.llmConfig?.outputLanguage
      && this.llmConfig.outputLanguage !== 'Auto'
      ? i18n.t('prompts:memory.summarizeOutputLang', {
          lang: translateLanguageName(this.llmConfig.outputLanguage),
        })
      : i18n.t('prompts:memory.summarizeOutputAuto');

    const prompt = i18n.t('prompts:memory.summarizePrompt', {
      outputLanguage: outputLanguageValue,
      transcript,
    });

    try {
      const response = await this.callLLM(prompt);
      const { summary, preferences, usedFallback } = parseSummaryLLMResponse(response);
      if (usedFallback) {
        memoryObservability.record('memory.summary.parse_failed', {
          responseHash: hashForObservation(response),
          responseLength: response.length,
          stage: 'json_parse',
        });
      }
      const supportedPreferences = preferences.filter(pref => this.isSupportedByUserMessage(pref, messages));

      // Store episode
      const episodeId = generateId();
      this.episodeRepo.create({
        id: episodeId,
        session_id: sessionKey,
        summary,
        key_points: JSON.stringify(supportedPreferences),
      });

      // Store summary as session-level memory
      await this.memoryWriter.writeSummary(sessionKey, summary, undefined, channel);

      // Auto-capture preferences
      for (const pref of supportedPreferences) {
        await this.memoryWriter.writePreference(sessionKey, pref, undefined, channel);
        this.logger.debug({ sessionKey, preference: pref, channel }, 'Auto-captured preference');
      }

      this.logger.info(
        { sessionKey, episodeId, messageCount: messages.length, preferenceCount: supportedPreferences.length },
        'LLM session summarized',
      );
    } catch (err) {
      this.logger.warn({ err, sessionKey }, 'LLM summarization failed, falling back to rule-based');
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

    return messages.some(m => (
      m.role === 'user'
      && extractPreferredName(m.content) === name
    ));
  }

  private parseResponse(response: string): { summary: string; preferences: string[] } {
    const parsed = parseSummaryLLMResponse(response);
    return { summary: parsed.summary, preferences: parsed.preferences };
  }

  private async callLLM(prompt: string): Promise<string> {
    const cfg = this.llmConfig!;

    // Build model chain: primary + fallbacks
    const modelRefs = [
      ...(cfg.modelRef ? [cfg.modelRef] : []),
      ...(cfg.fallbackRefs ?? []),
    ];

    let lastError: string | null = null;

    for (const modelRef of modelRefs) {
      const { modelId, apiKey, baseUrl } = await resolveSummaryModelConnection(cfg, modelRef);

      try {
        const OpenAI = (await import('openai')).default;
        const client = new OpenAI({ apiKey, baseURL: baseUrl });

        const completion = await client.chat.completions.create({
          model: modelId,
          messages: [
            { role: 'system', content: i18n.t('prompts:memory.summarizeSystemPrompt') },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 2000,
        });

        return completion.choices[0]?.message?.content ?? '';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn({ modelRef, err: msg.slice(0, 100) }, 'Summary LLM attempt failed');
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
  ): Promise<void> {
    const userMessages = messages.filter(m => m.role === 'user');
    const assistantMessages = messages.filter(m => m.role === 'assistant');

    const userTopics = userMessages
      .map(m => cleanContent(m.content))
      .filter(c => c.length > 0)
      .slice(0, 10);

    const conclusions = assistantMessages
      .slice(-2)
      .map(m => cleanContent(m.content))
      .filter(c => c.length > 0 && !userTopics.includes(c));

    const summaryText = [
      userTopics.length > 0 ? `${i18n.t('prompts:memory.ruleBasedUserTopics')}: ${userTopics.join('; ')}` : '',
      conclusions.length > 0 ? `${i18n.t('prompts:memory.ruleBasedAssistantConclusions')}: ${conclusions.join('; ')}` : '',
      `${i18n.t('prompts:memory.ruleBasedStats')}: ${messages.length} messages, ${userMessages.length} user / ${assistantMessages.length} assistant`,
    ].filter(Boolean).join('\n');

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
    });

    this.logger.info(
      { sessionKey, episodeId, messageCount: messages.length, topicCount: userTopics.length },
      'Session summarized (rule-based)',
    );
  }
}

export function parseSummaryLLMResponse(response: string): { summary: string; preferences: string[]; usedFallback: boolean } {
  const parsed = parseSummaryJson(response) ?? parseSummaryJson(extractJsonFence(response));
  if (parsed) return { ...parsed, usedFallback: false };
  return { ...parsePrefixSummaryResponse(response), usedFallback: true };
}

function parseSummaryJson(response: string | null): { summary: string; preferences: string[] } | null {
  if (!response) return null;
  try {
    const value = JSON.parse(response.trim()) as unknown;
    if (!value || typeof value !== 'object') return null;
    const obj = value as { summary?: unknown; preferences?: unknown };
    if (typeof obj.summary !== 'string') return null;
    const summary = obj.summary.trim().slice(0, 1000);
    if (!summary) return null;
    const preferences = Array.isArray(obj.preferences)
      ? obj.preferences
          .filter((pref): pref is string => typeof pref === 'string')
          .map(pref => pref.trim())
          .filter(pref => pref.length > 2)
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
  const lines = response.split('\n').map(l => l.trim()).filter(Boolean);
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
  const localized = i18n.locale === 'zh-CN'
    ? {
        'English': '英文', 'Simplified Chinese': '简体中文', 'Traditional Chinese': '繁体中文',
        'Spanish': '西班牙文', 'Japanese': '日文', 'French': '法文', 'German': '德文',
      }
    : {
        'English': 'English', 'Simplified Chinese': 'Simplified Chinese', 'Traditional Chinese': 'Traditional Chinese',
        'Spanish': 'Spanish', 'Japanese': 'Japanese', 'French': 'French', 'German': 'German',
      };
  return localized[name as keyof typeof localized] || name;
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
