/**
 * Session Title Generator
 *
 * Auto-generates a short, language-following conversation title from the
 * user's first message, reusing the exact LLM model the conversation itself
 * uses (agent.state.model). Pattern follows mainstream agents (ChatGPT,
 * Claude Code, Codex desktop): first real user message -> small async LLM
 * call -> 3-15 char title. User-renamed titles always win: the generator
 * only writes when the current title is still a placeholder.
 */

import { completeSimple } from '@earendil-works/pi-ai';
import type { Logger } from 'pino';

/** Placeholder titles that auto-generation is allowed to replace. */
const PLACEHOLDER_TITLE_RE = /^(new chat|新对话|对话|chat|conversation|会话)\d*$/i;

/** Generated title bounds, counted in non-whitespace characters. */
export const MIN_TITLE_LENGTH = 3;
export const MAX_TITLE_LENGTH = 15;

/** Long user messages are trimmed before hitting the LLM. */
const MAX_INPUT_CHARS = 500;

const TITLE_TIMEOUT_MS = 20_000;

/** True when a title is missing or still a default placeholder. */
export function isPlaceholderTitle(title: string | null | undefined): boolean {
  if (!title) return true;
  return PLACEHOLDER_TITLE_RE.test(title.trim());
}

/** Parse session metadata JSON without throwing. */
export function parseSessionMetadata(metadata: string | null | undefined): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Count non-whitespace characters (CJK counts per 字, Latin per letter). */
export function titleCharCount(title: string): number {
  return Array.from(title.replace(/\s+/g, '')).length;
}

/** Strip decorations (system reminders, injected timestamps) from user input. */
export function cleanTitleInput(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[当前(时间|日期):[^\]]+\]/g, ' ')
    .replace(/\[Current (time|date):[^\]]+\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_INPUT_CHARS);
}

/** Build the LLM prompt. Kept pure for tests. */
export function buildTitlePrompt(message: string): { systemPrompt: string; prompt: string } {
  return {
    systemPrompt:
      'You are a conversation titling assistant. Given the first message of a conversation, ' +
      'you produce a short title that captures its topic or goal.',
    prompt: `Produce a conversation title from the user's first message below.

Rules:
- 3 to 15 characters (Chinese/Japanese/Korean: count 字/文字; Latin: count letters and spaces)
- Use the SAME LANGUAGE as the message (Chinese message -> Chinese title, English message -> English title)
- Summarize the topic or goal in a few words; do not repeat the full message
- No quotes, punctuation, numbering prefixes, or generic words like "对话"/"Chat"/"New Chat"
- Output ONLY a JSON object: {"title": "..."}

First message:
"""${message}"""`,
  };
}

/**
 * Parse and validate the LLM's JSON response into a 3-15 char title.
 * Returns null when the response is unusable.
 */
export function parseTitleResponse(raw: string): string | null {
  if (!raw) return null;

  let title: string | null = null;
  const match = raw.match(/"title"\s*:\s*"([^"]*)"/i);
  if (match) {
    title = match[1];
  } else {
    try {
      const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed.title === 'string') title = parsed.title;
    } catch {
      // Fall through to validation
    }
  }

  if (title === null) return null;
  const normalized = title.trim();
  if (!normalized) return null;

  if (titleCharCount(normalized) > MAX_TITLE_LENGTH) {
    return truncateTitle(normalized);
  }
  if (titleCharCount(normalized) < MIN_TITLE_LENGTH) {
    return null;
  }
  return normalized;
}

/** Truncate to MAX_TITLE_LENGTH, cutting at a word boundary when possible. */
function truncateTitle(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= MAX_TITLE_LENGTH) return text;
  const candidate = chars.slice(0, MAX_TITLE_LENGTH).join('');
  const lastSpace = candidate.lastIndexOf(' ');
  if (lastSpace >= Math.ceil(MAX_TITLE_LENGTH / 2)) {
    return candidate.slice(0, lastSpace).trim();
  }
  return candidate.trim();
}

/** Deterministic fallback: the cleaned first message, truncated to 15 chars. */
export function fallbackTitle(text: string): string | null {
  const clean = cleanTitleInput(text);
  if (!clean) return null;
  return Array.from(clean).slice(0, MAX_TITLE_LENGTH).join('');
}

/** Extract text blocks from an AssistantMessage. */
function extractText(message: {
  content: Array<{ type?: string; text?: string }>;
  stopReason?: string;
}): string {
  if (message.stopReason === 'error' || message.stopReason === 'aborted') return '';
  return message.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

export interface GenerateTitleOptions {
  /** The conversation's resolved model (agent.state.model). */
  model: unknown;
  /** User's first message text. */
  message: string;
  logger?: Logger;
}

/**
 * Generate a title for the conversation using the conversation's own model.
 * Never throws: returns null when generation fails, in which case callers
 * may fall back to fallbackTitle() themselves (generateSessionTitle already
 * applies that fallback internally).
 */
export async function generateSessionTitle(options: GenerateTitleOptions): Promise<string | null> {
  const { model, message, logger } = options;
  const input = cleanTitleInput(message);
  if (!input) return null;

  const { systemPrompt, prompt } = buildTitlePrompt(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);

  try {
    const result = await completeSimple(
      model as Parameters<typeof completeSimple>[0],
      {
        systemPrompt,
        messages: [{ role: 'user' as const, content: prompt, timestamp: Date.now() }],
      },
      { temperature: 0.3, maxTokens: 64, signal: controller.signal },
    );
    const title = parseTitleResponse(extractText(result));
    if (title) return title;
    logger?.debug({ modelId: (model as { id?: string })?.id }, 'Title response unparseable, using fallback');
  } catch (err) {
    logger?.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Session title generation failed, using fallback',
    );
  } finally {
    clearTimeout(timeout);
  }

  return fallbackTitle(input);
}
