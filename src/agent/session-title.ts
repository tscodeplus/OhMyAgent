/**
 * Session Title Generator
 *
 * Auto-generates a short, language-following conversation title from the
 * user's first message, reusing the exact LLM model the conversation itself
 * uses (agent.state.model). Titles are budgeted in *display columns*
 * (CJK = 2, half-width = 1) so mixed-script titles like
 * "Ubuntu 26.04.1发布了吗" fit naturally instead of being chopped mid-word.
 *
 * Overflow handling, in order: tolerance band (accept slightly-long titles
 * as-is) -> one corrective LLM retry asking for a compression ->
 * deterministic boundary-aware truncation -> same truncation for the
 * no-LLM fallback. User-renamed titles always win: the generator only
 * writes when the current title is still a placeholder.
 */

import { completeSimple } from '@earendil-works/pi-ai';
import type { Logger } from 'pino';

/** Placeholder titles that auto-generation is allowed to replace. */
const PLACEHOLDER_TITLE_RE = /^(new chat|新对话|对话|chat|conversation|会话)\d*$/i;

/** Per-character floor: a title shorter than this is not a title. */
export const MIN_TITLE_CHARS = 3;

/**
 * Hard budget in display columns (CJK/full-width = 2 columns, others = 1).
 * 24 columns ≈ 12 Chinese characters or 24 Latin characters, which keeps
 * information density comparable across scripts.
 */
export const MAX_TITLE_WIDTH = 24;

/**
 * Tolerance band: LLM output up to this width is accepted as-is. A slight
 * overflow renders fine in the UI (CSS ellipsis + tooltip) and beats a
 * destructive mid-word cut.
 */
export const SOFT_TITLE_WIDTH = 30;

/** Long user messages are trimmed before hitting the LLM. */
const MAX_INPUT_CHARS = 500;

const TITLE_TIMEOUT_MS = 20_000;

const COMPRESS_PROMPT =
  'The title you produced is too long. Rewrite it following the same rules, ' +
  'within 24 display columns (CJK characters count as 2 columns, Latin letters ' +
  'and digits as 1). Output ONLY a JSON object: {"title": "..."}';

/** East-asian Wide/Fullwidth ranges (wcwidth-style), counted as 2 columns. */
const WIDE_CHAR_RE =
  /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/** Sentence punctuation usable as a title cut point ("." and ":" excluded — versions, URLs). */
const CUT_PUNCT_RE = /[，。？！、；…—,!?!;]/;

/** Clause boundary for the fallback title (same exclusions). */
const CLAUSE_PUNCT_RE = /[，。？！、；?!;]/;

/** Characters that must not be split apart inside version numbers, URLs, slugs. */
const ALNUM_RUN_RE = /[0-9A-Za-z._\-/]/;

/** Trailing punctuation/whitespace stripped after truncation. */
const TRAILING_JUNK_RE = /[\s,.;:!?"'，。！？；：、…—]+$/;

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

/** Display width: CJK/full-width chars count 2 columns, everything else 1. */
export function titleWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += WIDE_CHAR_RE.test(ch) ? 2 : 1;
  return width;
}

/** Display width of the first `n` code points of `chars`. */
function widthAt(chars: string[], n: number): number {
  let width = 0;
  for (let i = 0; i < n; i++) width += WIDE_CHAR_RE.test(chars[i]) ? 2 : 1;
  return width;
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
- At most 24 display columns: CJK characters count as 2 columns, Latin letters/digits as 1 (roughly 4-12 Chinese characters, or 3-5 English words)
- Use the SAME LANGUAGE as the message (Chinese message -> Chinese title, English message -> English title)
- Keep product names and version numbers intact (e.g. "Ubuntu 26.04.1发布了吗" stays whole)
- Summarize the topic or goal in a few words; do not repeat the full message
- No quotes, no trailing punctuation, numbering prefixes, or generic words like "对话"/"Chat"/"New Chat"
- Output ONLY a JSON object: {"title": "..."}

Example:
Message: """Ubuntu 26.04.1发布了吗，需要根据官方release notes来确认"""
Output: {"title": "Ubuntu 26.04.1发布了吗"}

First message:
"""${message}"""`,
  };
}

export interface ParsedTitle {
  title: string;
  /**
   * The raw LLM output exceeded SOFT_TITLE_WIDTH (the returned title was
   * locally truncated to MAX_TITLE_WIDTH). Callers may retry with a
   * compress instruction instead of trusting the local cut.
   */
  overTolerance: boolean;
}

/**
 * Parse and validate the LLM's JSON response into a title.
 * Returns null when the response is unusable. Titles within the tolerance
 * band (MAX_TITLE_WIDTH < width <= SOFT_TITLE_WIDTH) are accepted as-is;
 * anything wider is truncated to MAX_TITLE_WIDTH and flagged.
 */
export function parseTitleResponse(raw: string): ParsedTitle | null {
  if (!raw) return null;

  let title: string | null = null;
  const match = raw.match(/"title"\s*:\s*"([^"]*)"/i);
  if (match) {
    title = match[1];
  } else {
    try {
      const cleaned = raw
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```$/, '')
        .trim();
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed.title === 'string') title = parsed.title;
    } catch {
      // Fall through to validation
    }
  }

  if (title === null) return null;
  const normalized = title.trim();
  if (!normalized) return null;
  if (titleCharCount(normalized) < MIN_TITLE_CHARS) return null;

  if (titleWidth(normalized) <= SOFT_TITLE_WIDTH) {
    return { title: normalized, overTolerance: false };
  }
  return { title: truncateTitle(normalized), overTolerance: true };
}

/**
 * Truncate to MAX_TITLE_WIDTH display columns, preferring, in order:
 * a sentence-punctuation boundary, a space boundary, the start of the
 * trailing alphanumeric run (keeps "26.04.1" whole), then a plain cut.
 */
export function truncateTitle(text: string, maxWidth: number = MAX_TITLE_WIDTH): string {
  const trimmed = text.trim();
  if (titleWidth(trimmed) <= maxWidth) return trimmed;
  const chars = Array.from(trimmed);

  // Longest prefix that fits the width budget.
  const candidate: string[] = [];
  let width = 0;
  for (const ch of chars) {
    const w = WIDE_CHAR_RE.test(ch) ? 2 : 1;
    if (width + w > maxWidth) break;
    candidate.push(ch);
    width += w;
  }
  if (candidate.length === 0) return chars[0] ?? trimmed;

  // 1) Cut at the last sentence punctuation, if it keeps at least 8 columns.
  for (let i = candidate.length - 1; i > 0; i--) {
    if (!CUT_PUNCT_RE.test(candidate[i])) continue;
    if (widthAt(candidate, i) >= 8) return stripJunk(candidate.slice(0, i));
    break; // only punct found is too early; fall through
  }

  // 2) Cut at the last space, if it keeps at least half the budget.
  const lastSpace = candidate.lastIndexOf(' ');
  if (lastSpace > 0 && widthAt(candidate, lastSpace) >= Math.floor(maxWidth / 2)) {
    return stripJunk(candidate.slice(0, lastSpace));
  }

  // 3) Never split a version/URL-like run: back off to the run's start.
  const next = chars[candidate.length];
  if (ALNUM_RUN_RE.test(candidate[candidate.length - 1]) && next && ALNUM_RUN_RE.test(next)) {
    let start = candidate.length;
    while (start > 0 && ALNUM_RUN_RE.test(candidate[start - 1])) start--;
    if (widthAt(candidate, start) >= 6) return stripJunk(candidate.slice(0, start));
  }

  return stripJunk(candidate);
}

function stripJunk(chars: string[]): string {
  return chars.join('').replace(TRAILING_JUNK_RE, '').trim();
}

/**
 * Deterministic fallback used when the LLM is unavailable: prefer the first
 * sentence clause of the cleaned message (usually the actual ask), else
 * boundary-aware truncation.
 */
export function fallbackTitle(text: string): string | null {
  const clean = cleanTitleInput(text);
  if (!clean) return null;

  const clauseEnd = clean.search(CLAUSE_PUNCT_RE);
  if (clauseEnd > 0) {
    const clause = clean.slice(0, clauseEnd).trim();
    if (
      Array.from(clause.replace(/\s+/g, '')).length >= MIN_TITLE_CHARS &&
      titleWidth(clause) <= SOFT_TITLE_WIDTH
    ) {
      return clause;
    }
  }
  return truncateTitle(clean);
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

/** One candidate model for title generation. */
export interface TitleModelCandidate {
  model: unknown;
  /** API key for this candidate's provider (see GenerateTitleOptions.apiKey). */
  apiKey?: string;
}

export interface GenerateTitleOptions {
  /** The conversation's resolved model (agent.state.model). */
  model: unknown;
  /** User's first message text. */
  message: string;
  /**
   * API key for the model's provider. Required for custom providers (the
   * compat completeSimple() wrapper only auto-injects keys for providers
   * with well-known env vars, e.g. OPENAI_API_KEY — custom providers like
   * `agnes` would otherwise fail with "No API key for provider").
   */
  apiKey?: string;
  /**
   * Ordered fallback candidates tried when the primary model call fails
   * (network/provider error or unparseable output). A result that is only
   * over-tolerance still counts: it is used in truncated form rather than
   * triggering the next candidate.
   */
  fallbackModels?: TitleModelCandidate[];
  logger?: Logger;
}

/**
 * One completeSimple attempt (+ compress retry if over-tolerance) with a
 * single model. Returns null when the model produced nothing usable, so the
 * caller can move on to the next candidate.
 */
async function generateTitleWithModel(
  model: unknown,
  apiKey: string | undefined,
  systemPrompt: string,
  prompt: string,
  logger?: Logger,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
  const callOpts = { temperature: 0.3, maxTokens: 64, signal: controller.signal, apiKey };

  try {
    const result = await completeSimple(
      model as Parameters<typeof completeSimple>[0],
      {
        systemPrompt,
        messages: [{ role: 'user' as const, content: prompt, timestamp: Date.now() }],
      },
      callOpts,
    );
    const parsed = parseTitleResponse(extractText(result));
    if (!parsed) {
      logger?.debug({ modelId: (model as { id?: string })?.id }, 'Title response unparseable');
      return null;
    }
    if (!parsed.overTolerance) return parsed.title;

    // One corrective retry: let the model compress its own title instead of
    // trusting a local mid-word cut.
    try {
      const retry = await completeSimple(
        model as Parameters<typeof completeSimple>[0],
        {
          systemPrompt,
          messages: [
            { role: 'user' as const, content: prompt, timestamp: Date.now() },
            // Reuse the first reply as-is: it is already a complete AssistantMessage.
            result,
            { role: 'user' as const, content: COMPRESS_PROMPT, timestamp: Date.now() },
          ],
        },
        callOpts,
      );
      const second = parseTitleResponse(extractText(retry));
      if (second && !second.overTolerance) return second.title;
    } catch (err) {
      logger?.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Title compression retry failed, using truncated first attempt',
      );
    }
    // parseTitleResponse already truncated the first attempt to budget.
    return parsed.title;
  } catch (err) {
    logger?.debug(
      {
        err: err instanceof Error ? err.message : String(err),
        modelId: (model as { id?: string })?.id,
      },
      'Title model call failed',
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Generate a title for the conversation, trying the conversation's own model
 * first and then any fallback candidates. Never throws: returns null when
 * every candidate fails, in which case callers may fall back to
 * fallbackTitle() themselves (generateSessionTitle already applies that
 * fallback internally).
 */
export async function generateSessionTitle(options: GenerateTitleOptions): Promise<string | null> {
  const { model, message, logger } = options;
  const input = cleanTitleInput(message);
  if (!input) return null;

  const { systemPrompt, prompt } = buildTitlePrompt(input);
  const candidates: TitleModelCandidate[] = [
    { model, apiKey: options.apiKey },
    ...(options.fallbackModels ?? []),
  ];
  for (const candidate of candidates) {
    if (!candidate?.model) continue;
    const title = await generateTitleWithModel(
      candidate.model,
      candidate.apiKey,
      systemPrompt,
      prompt,
      logger,
    );
    if (title) return title;
  }
  return fallbackTitle(input);
}
