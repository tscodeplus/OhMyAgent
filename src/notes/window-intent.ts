/**
 * "Only the last 3 turns." — what an instruction says about *how much* to read.
 *
 * An instructed capture reads the whole conversation (bounded by the token budget),
 * because a requirement is a statement about the conversation, not about the exchange
 * that happened to be last. But the same sentence can also narrow that: 「只整理最近
 * 3 轮」and 「不超过 2000 字」are scope statements, and ignoring them would read more
 * material than the user asked for — including material they explicitly excluded.
 *
 * Deliberately a **parser, not a model call**: it runs before the distiller, it must be
 * instant, and a wrong answer here is visible in one glance at the reply ("read the
 * last 24 messages"), whereas a model that guesses the scope produces a note whose
 * scope nobody can audit.
 *
 * A number alone is not a scope. 「把这段 500 字的说明整理出来」 states the length of
 * the *material*, not of the window, so a quantity only counts when a scope word
 * (最近 / 最后 / 前 / 只看 / 不超过 …) sits next to it. When nothing matches, the
 * instruction widens the window as usual — under-reading a requirement is the failure
 * worth avoiding, and it is the one this file cannot recover from later.
 */

import { WINDOW_TURNS_MAX } from './output-budget.js';

export interface WindowIntent {
  /** Explicit "last N turns" — puts the capture back on `recent`. */
  turns?: number;
  /** Explicit "N characters" — a character cap applied on top of the token budget. */
  charBudget?: number;
}

/** Below this a window is one exchange, so the number was probably not a scope. */
const MIN_TURNS = 1;

/** A cap tighter than this cannot hold one command and its caveat. */
const MIN_CHARS = 200;

/** ~4× the default token budget in CJK characters; past this the token budget binds. */
const MAX_CHARS = 64_000;

/**
 * `(最近|最后|近|前) N 轮` / `last N turns`.
 *
 * The unit list is what separates a scope from a count: 「3 条命令」 is a request about
 * content, 「最近 3 条」 is a request about the window, and only the second may touch it.
 */
const TURNS_PATTERNS: RegExp[] = [
  /(?:最近|最后|近|前)\s*(\d{1,3})\s*(?:轮|回合|次对话|条消息|条|个回合)/u,
  /\b(?:last|latest|recent|past|previous)\s+(\d{1,3})\s+(?:turns?|rounds?|exchanges?|messages?)\b/i,
];

/**
 * `不超过 N 字` / `只看最近 1000 字` / `last 2000 characters`.
 *
 * The leading scope word is mandatory (`SO_SCOPE`), which is the whole guard against
 * 「这段 500 字的说明」 being read as a window cap.
 */
const CHAR_PATTERNS: RegExp[] = [
  /(?:最近|最后|近|前的?|只看|只整理|只读|只要|仅|不超过|最多)\s*(?:最近|最后)?\s*(\d{2,6})\s*(?:个)?(?:字|字符)(?:以内|之内|左右|以下)?/u,
  /\b(?:last|latest|recent|past|only|at most|within)\s+(?:the\s+)?(?:last\s+)?(\d{2,6})\s+(?:chars?|characters?)\b/i,
];

/** Thousands shorthand: 「不超过两千字」 reads naturally where 「2000」 does not. */
const CN_DIGITS: Record<string, number> = {
  一: 1,
  两: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};
const CN_THOUSANDS: RegExp[] = [
  /(不超过|最多|最近|最后|只看|只整理|仅)\s*([一两二三四五六七八九十])\s*千\s*(?:字|字符)/u,
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Read the scope out of an instruction. Returns `{}` when it says nothing about it,
 * which is the common case and must stay cheap.
 */
export function parseWindowIntent(instruction: string | undefined): WindowIntent {
  const text = (instruction ?? '').trim();
  if (!text) return {};

  const intent: WindowIntent = {};

  for (const pattern of TURNS_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      intent.turns = clamp(Number.parseInt(match[1], 10), MIN_TURNS, WINDOW_TURNS_MAX);
      break;
    }
  }

  for (const pattern of CHAR_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      intent.charBudget = clamp(Number.parseInt(match[1], 10), MIN_CHARS, MAX_CHARS);
      break;
    }
  }

  if (intent.charBudget === undefined) {
    for (const pattern of CN_THOUSANDS) {
      const match = pattern.exec(text);
      if (match) {
        const thousands = CN_DIGITS[match[2]] ?? 1;
        intent.charBudget = clamp(thousands * 1000, MIN_CHARS, MAX_CHARS);
        break;
      }
    }
  }

  return intent;
}

/**
 * A short, human-readable rendering of the intent, for logs and for the reply that
 * tells the user what was read. Empty string = "no explicit scope".
 */
export function describeWindowIntent(intent: WindowIntent): string {
  const parts: string[] = [];
  if (intent.turns !== undefined) parts.push(`${intent.turns} turns`);
  if (intent.charBudget !== undefined) parts.push(`${intent.charBudget} chars`);
  return parts.join(' / ');
}
