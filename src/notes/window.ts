/**
 * Which messages a capture reads (plan §5.1).
 *
 * Five modes, one shape: turn / recent / session / selection / text. The default is
 * `turn` — the user just finished something and wants that thing, not the whole
 * afternoon. `session` is the opposite end of that: everything the budget can hold,
 * which is what "based on this conversation" has to mean to be true.
 *
 * Every mode reports what it *did not* read (`droppedMessages`). A suffix window that
 * silently discards the beginning of a conversation is worse than a short window: the
 * reviewer cannot tell a thin note from a thin material.
 *
 * **Tool calls are not read by default** (`includeTools: 'off'`). Tool output is
 * mostly logs, file contents and success echoes; feeding it to a distiller is how
 * a note becomes a transcript of a `cat`. An agent that did not mention a command
 * in its final answer did not conclude that command was reusable — and only
 * conclusions are notes. `includeTools: 'args'` brings back the call *without* its
 * result, as a single line, because the command itself is often the note.
 *
 * The budget is measured in estimated tokens (`chars/4`, `chars/2` for CJK) and
 * trimmed from the oldest message, never below the last turn.
 */

import type { Message } from '../memory/repositories/message-repository.js';
import { WINDOW_TOKEN_DEFAULT, WINDOW_TURNS_MAX } from './output-budget.js';
import type { CaptureMode } from './types.js';

export interface WindowOptions {
  sessionId: string;
  mode: CaptureMode;
  /** `recent` window size (turns, not messages); 1..`WINDOW_TURNS_MAX`. */
  turns?: number;
  /** `selection`: the exact messages, all of which must belong to the session. */
  messageIds?: string[];
  /** `text`: verbatim content; no message is read. */
  text?: string;
  /** `off` | `args` — see the module comment. */
  includeTools?: 'off' | 'args';
  tokenBudget?: number;
  /**
   * Character cap from an explicit instruction ("只看最近 2000 字"). Applies *with*
   * the token budget — whichever binds first — because a user who says characters
   * means characters, and converting them to tokens would silently disagree with the
   * number they typed.
   */
  charBudget?: number;
}

export interface WindowMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

export interface ResolvedWindow {
  messages: WindowMessage[];
  /** Ids the distiller is allowed to cite. */
  messageIds: string[];
  /** Last user message — the tail of a `turn` window. */
  lastUserMessage: WindowMessage | null;
  tokenEst: number;
  /**
   * Messages the token budget removed from the *old* end. Non-zero means the note was
   * written from a suffix, which is a fact the reviewer is entitled to.
   */
  droppedMessages: number;
  /** Set when the window could not be built at all (`invalid` capture run). */
  error?: 'empty_session' | 'empty_selection' | 'selection_outside_session';
}

/** Rough token estimate: CJK costs ~2 chars/token, latin ~4. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk / 2 + other / 4);
}

/**
 * Tool *results* (`role: 'tool'`) are never read: they are the logs.
 *
 * An assistant row that only called tools is a different thing — the call itself,
 * which `includeTools: 'args'` renders as one line. Conflating the two is how the
 * args mode ends up with nothing to render.
 */
function isToolRow(message: Message): boolean {
  return message.role === 'tool';
}

function hasProse(message: Message): boolean {
  return message.role === 'user' || message.role === 'assistant'
    ? message.content.trim().length > 0
    : false;
}

/**
 * Render a tool call as one line — name plus arguments, no result (plan §5.1).
 *
 * A result can be 40 KB of build log; the call is four words and is the part a
 * note might actually quote.
 */
export function renderToolCallLine(message: Message): string | null {
  if (message.role !== 'assistant' || !message.metadata) return null;
  try {
    const meta = JSON.parse(message.metadata) as {
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    };
    const calls = meta.tool_calls ?? [];
    if (calls.length === 0) return null;
    return calls
      .map((call) => {
        const name = call.function?.name ?? 'tool';
        const args = (call.function?.arguments ?? '').replace(/\s+/g, ' ').slice(0, 240);
        return `[tool] ${name}(${args})`;
      })
      .join('\n');
  } catch {
    return null;
  }
}

/**
 * Turn a stored row into window text.
 *
 * Tool rows are dropped entirely; an assistant row that *only* called tools
 * contributes its call line when `includeTools === 'args'` and nothing otherwise.
 */
function render(message: Message, includeTools: 'off' | 'args'): WindowMessage | null {
  if (message.role === 'tool') return null;
  const content = message.content.trim();
  if (content) {
    return {
      id: message.id,
      role: message.role === 'user' ? 'user' : 'assistant',
      content,
      createdAt: Number(message.created_at) || Date.now(),
    };
  }
  if (includeTools === 'args') {
    const line = renderToolCallLine(message);
    if (line) {
      return {
        id: message.id,
        role: 'assistant',
        content: line,
        createdAt: Number(message.created_at) || Date.now(),
      };
    }
  }
  return null;
}

/**
 * The ids a "last N turns" scope covers, within an already-resolved window.
 *
 * Used to *check* the model rather than to decide what it reads: when a brief says
 * "only the last 3 turns" the distiller may answer from anything it was shown, so the
 * claim has to become mechanical — a note citing a message outside this set is
 * rejected (`evidence_outside_scope`). The turn walk matches `resolveWindow`, because
 * two definitions of "a turn" would disagree exactly when it matters.
 */
export function scopeTurnsIds(messages: readonly WindowMessage[], turns: number): Set<string> {
  const wanted = Math.max(1, Math.min(Math.floor(turns), messages.length));
  const picked: string[] = [];
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    picked.push(messages[index].id);
    if (messages[index].role === 'user') {
      seen += 1;
      if (seen >= wanted) break;
    }
  }
  return new Set(picked);
}

/**
 * The ids an "N characters" scope covers, counted from the newest message back.
 *
 * Character counts are not something a model can measure reliably, which is why the
 * number is computed here and the model only *reports* what the brief asked for. The
 * newest message always fits, so a tiny cap cannot produce an empty evidence set.
 */
export function scopeCharsIds(messages: readonly WindowMessage[], chars: number): Set<string> {
  const limit = Math.max(0, Math.floor(chars));
  const picked: string[] = [];
  let total = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    total += messages[index].content.length;
    picked.push(messages[index].id);
    if (total > limit) break;
  }
  return new Set(picked);
}

/**
 * Trim from the oldest end until the estimate fits, but never below one turn.
 *
 * The dropped count is returned rather than discarded: `capture.ts` puts it on the
 * result and the reply says "read the last N (the earlier M did not fit)". A budget
 * that trims without saying so is how a note about the end of a conversation gets
 * mistaken for a note about the conversation.
 */
function trimToBudget(
  messages: WindowMessage[],
  budget: number,
  charBudget?: number,
): { messages: WindowMessage[]; dropped: number } {
  let total = messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
  let chars = messages.reduce((sum, message) => sum + message.content.length, 0);
  const overChars = (): boolean => charBudget !== undefined && chars > charBudget;
  let start = 0;
  // Keep at least the last two entries (the last user + assistant exchange).
  while ((total > budget || overChars()) && messages.length - start > 2) {
    total -= estimateTokens(messages[start].content);
    chars -= messages[start].content.length;
    start += 1;
  }
  return { messages: messages.slice(start), dropped: start };
}

/**
 * Resolve a capture window from stored messages.
 *
 * `messages` is passed in (newest-first or oldest-first, both accepted — it is
 * sorted here) rather than fetched, so this stays testable without a database
 * and the caller decides how much history to load.
 */
export function resolveWindow(
  messages: readonly Message[],
  options: WindowOptions,
): ResolvedWindow {
  const includeTools = options.includeTools ?? 'off';
  const budget = options.tokenBudget ?? WINDOW_TOKEN_DEFAULT;
  const ordered = [...messages].sort((a, b) => Number(a.created_at) - Number(b.created_at));

  if (options.mode === 'text') {
    const text = (options.text ?? '').trim();
    const lastUser = [...ordered].reverse().find((message) => message.role === 'user');
    const lastUserMessage =
      lastUser && lastUser.content.trim()
        ? {
            id: lastUser.id,
            role: 'user' as const,
            content: lastUser.content.trim(),
            createdAt: Number(lastUser.created_at) || Date.now(),
          }
        : null;
    if (!text) {
      return {
        messages: [],
        messageIds: [],
        lastUserMessage,
        tokenEst: 0,
        droppedMessages: 0,
        error: 'empty_selection',
      };
    }
    return {
      // Verbatim text is not a message, so it gets a synthetic id: it must never
      // be treated as citable evidence (that would let the distiller cite text
      // the user typed into a dialog and call it a conversation).
      messages: [{ id: 'selection', role: 'user', content: text, createdAt: Date.now() }],
      messageIds: [],
      lastUserMessage,
      tokenEst: estimateTokens(text),
      droppedMessages: 0,
    };
  }

  if (options.mode === 'selection') {
    const wanted = new Set(options.messageIds ?? []);
    if (wanted.size === 0) {
      return {
        messages: [],
        messageIds: [],
        lastUserMessage: null,
        tokenEst: 0,
        droppedMessages: 0,
        error: 'empty_selection',
      };
    }
    const picked = ordered.filter((message) => wanted.has(message.id));
    if (picked.length === 0) {
      return {
        messages: [],
        messageIds: [],
        lastUserMessage: null,
        tokenEst: 0,
        droppedMessages: 0,
        error: 'selection_outside_session',
      };
    }
    const rendered = picked
      .map((message) => render(message, includeTools))
      .filter((message): message is WindowMessage => message !== null);
    // A selection is bounded by what the user picked, not by a budget: trimming it
    // would quietly answer a question about a different piece of text.
    return {
      messages: rendered,
      messageIds: rendered.map((message) => message.id),
      lastUserMessage: lastUserOf(ordered),
      tokenEst: rendered.reduce((sum, message) => sum + estimateTokens(message.content), 0),
      droppedMessages: 0,
    };
  }

  // `turn` and `recent` both read from the newest end; `turn` keeps one exchange.
  const prose = ordered.filter(
    (message) => !isToolRow(message) && (hasProse(message) || includeTools === 'args'),
  );
  if (prose.length === 0) {
    return {
      messages: [],
      messageIds: [],
      lastUserMessage: null,
      tokenEst: 0,
      droppedMessages: 0,
      error: 'empty_session',
    };
  }

  // `session` is "everything the budget allows": no turn limit, so the token budget is
  // the only constraint and it reports what it dropped.
  const wantedTurns =
    options.mode === 'session'
      ? Number.POSITIVE_INFINITY
      : options.mode === 'turn'
        ? 1
        : Math.max(1, Math.min(options.turns ?? 5, WINDOW_TURNS_MAX));
  const tail: Message[] = [];
  let turns = 0;
  for (let index = prose.length - 1; index >= 0; index -= 1) {
    const message = prose[index];
    tail.unshift(message);
    if (message.role === 'user') {
      turns += 1;
      // A "turn" is a user message plus everything after it, so stop *after*
      // collecting the user message that starts the window we want.
      if (turns >= wantedTurns) break;
    }
  }

  const rendered = tail
    .map((message) => render(message, includeTools))
    .filter((message): message is WindowMessage => message !== null);
  const trimmed = trimToBudget(rendered, budget, options.charBudget);
  return {
    messages: trimmed.messages,
    messageIds: trimmed.messages.map((message) => message.id),
    lastUserMessage: lastUserOf(ordered),
    tokenEst: trimmed.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0),
    droppedMessages: trimmed.dropped,
  };
}

function lastUserOf(ordered: readonly Message[]): WindowMessage | null {
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const message = ordered[index];
    if (message.role === 'user' && message.content.trim()) {
      return {
        id: message.id,
        role: 'user',
        content: message.content.trim(),
        createdAt: Number(message.created_at) || Date.now(),
      };
    }
  }
  return null;
}

/**
 * The window as prompt text.
 *
 * Roles are spelled out (`user` / `assistant`) instead of emitted as a chat history:
 * the model must see this as *material to distil*, not as a conversation to
 * continue, and a transcript-shaped prompt is exactly what produces the recap
 * failure mode the 4-gram gate then has to catch.
 *
 * The id comes **first, in brackets**, and the role after it. The earlier
 * `user (msg-abc123):` shape reads as "user, in this slot" and a model asked to
 * cite ids answered `"evidence": ["user"]` — the role word, which is not an id, so
 * every note was rejected as uncitable. Brackets are the notation the prompt asks
 * for, so what the model sees and what it must return are the same shape.
 */
export function renderWindowPrompt(messages: readonly WindowMessage[]): string {
  return messages
    .map(
      (message) =>
        `[${message.id}] ${message.role === 'user' ? 'user' : 'assistant'}:\n${message.content}`,
    )
    .join('\n\n---\n\n');
}
