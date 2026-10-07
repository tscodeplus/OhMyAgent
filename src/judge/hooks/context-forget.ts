/**
 * Hook for kernel M2 decision point `context.forget` (impl doc §4.6):
 * nomination + judged eviction of stale tool results at the capacity
 * watermark.
 *
 * Caller: `src/agent/context-transform.ts` — at the SAME watermark the
 * auto-compression trigger fires, inside the already-async context transform
 * (no floating promises). Evicted results are replaced by a one-line
 * tombstone in the OUTBOUND copy only; the live transcript/session storage
 * keeps the full text (eviction is request-assembly-time, never SQLite).
 *
 * Nomination rules (owned here, per the spec module contract):
 *   - candidates are toolResult messages ≥ MIN_CANDIDATE_TOKENS tokens, older
 *     than the current turn's user message;
 *   - errors are never nominated (usually load-bearing for debugging);
 *   - at most MAX_CANDIDATES_PER_CALL per invocation;
 *   - per-session WeakSet of already-judged messages so judged claims
 *     (tombstones AND judged keeps) are never re-nominated — but ONLY after a
 *     judged+active verdict: shadow / gray / fallback rounds leave the
 *     candidates unmarked so a later watermark can re-ask them.
 *
 * Shadow / gray / fallback are behavior-neutral: `{ asked: true }` with no
 * entries — the outbound copy stays byte-equal. Never throws.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { estimateMessageTokensCached } from '../../agent/compress.js';
import {
  CONTEXT_FORGET_POINT_ID,
  forgetTombstoneLine,
  MAX_CANDIDATES_PER_CALL,
  MIN_CANDIDATE_TOKENS,
  createContextForgetSpec,
  type ForgetCandidate,
} from '../decisions/context-forget.js';
import { currentJudgeEngine } from '../engine-lookup.js';
import type { JudgeEngine } from '../engine.js';

/** Bounded per-session identity sets so judged messages are never re-nominated. */
const nominatedBySession = new Map<string, WeakSet<object>>();
const MAX_NOMINATED_SESSIONS = 500;

function nomineeSetFor(sessionKey: string): WeakSet<object> {
  if (nominatedBySession.size >= MAX_NOMINATED_SESSIONS && !nominatedBySession.has(sessionKey)) {
    const first = nominatedBySession.keys().next().value;
    if (first !== undefined) nominatedBySession.delete(first);
  }
  let set = nominatedBySession.get(sessionKey);
  if (!set) {
    set = new WeakSet();
    nominatedBySession.set(sessionKey, set);
  }
  return set;
}

function messageText(m: AgentMessage): string {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return (m.content as { type: string; text?: string }[])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
      .join('\n');
  }
  return '';
}

/** Approximate turn gap: number of user messages after the candidate index. */
function ageTurnsAt(messages: AgentMessage[], index: number): number {
  let turns = 0;
  for (let i = index + 1; i < messages.length; i++) {
    if (messages[i]?.role === 'user') turns += 1;
  }
  return turns;
}

export interface JudgedForgetEntry {
  /** Index of the toolResult message in the ORIGINAL message array. */
  index: number;
  /** Tombstone text that replaces the full result content. */
  tombstone: string;
}

export interface JudgeContextForgetResult {
  asked: boolean;
  /** Present only when judged+active: index/tombstone pairs to apply. */
  entries?: JudgedForgetEntry[];
}

/**
 * Nominate stale tool results and judge them. Never throws; returns
 * `entries: undefined` in shadow/off/fallback — no behavioral change.
 *
 * The hook keeps the ORIGINAL indices so the caller can rebuild its outbound
 * copy; it does not mutate the messages array.
 */
export async function judgeContextForget(input: {
  engine?: JudgeEngine;
  messages: AgentMessage[];
  /** Index of the last user message (current turn) — candidates live before it. */
  lastUserIndex: number;
  sessionKey?: string;
  taskHint?: string;
  judgeGet?: () => JudgeEngine | undefined;
}): Promise<JudgeContextForgetResult> {
  const engine = input.judgeGet?.() ?? currentJudgeEngine() ?? input.engine;
  if (!engine) return { asked: false };
  if (engine.modeFor(CONTEXT_FORGET_POINT_ID) === 'off') return { asked: false };

  const candidates: Array<{ key: string; index: number; info: ForgetCandidate }> = [];
  const nominated = nomineeSetFor(input.sessionKey ?? 'default');

  for (let i = 0; i < input.messages.length; i++) {
    if (i >= input.lastUserIndex) break; // candidates are older than the current turn
    if (candidates.length >= MAX_CANDIDATES_PER_CALL) break;
    const message = input.messages[i];
    if (!message || message.role !== 'toolResult') continue;
    if (message.isError === true) continue;
    if (nominated.has(message)) continue;
    const text = messageText(message);
    const sizeTokens = estimateMessageTokensCached(message);
    if (sizeTokens < MIN_CANDIDATE_TOKENS) continue;
    const firstLine = text.split('\n')[0] ?? '';
    const candidate: ForgetCandidate = {
      key: `k${candidates.length + 1}`,
      tool: message.toolName ?? 'tool',
      sizeTokens,
      ageTurns: ageTurnsAt(input.messages, i),
      firstLine,
      text,
    };
    candidates.push({ key: candidate.key, index: i, info: candidate });
  }
  if (candidates.length === 0) return { asked: false };

  const infos = candidates.map((c) => c.info);
  const verdict = await engine.decideMany(createContextForgetSpec(infos), {
    state: { taskHint: input.taskHint ?? '', candidates: infos },
    sessionId: input.sessionKey,
  });
  if (verdict.source !== 'judge' || verdict.mode !== 'active') {
    // Judged-keep candidates are marked as nominated AFTER a judged verdict so
    // a fallback round (timeout / gray) can re-ask on a later watermark.
    return { asked: true };
  }
  // Judged + active: the nominees were decided — never re-judge them this
  // session (both evicted tombstones and judged-keeps are final claims).
  for (const { index } of candidates) {
    const message = input.messages[index];
    if (message) nominated.add(message);
  }
  // Fallback / gray / non-keep: behavior-neutral, no entries (hook contract:
  // "entries: undefined" in shadow/off/fallback — key present with undefined).
  if (verdict.outcome.action !== 'keep') return { asked: true, entries: undefined };

  const kept = new Set(verdict.outcome.ids);
  const entries: JudgedForgetEntry[] = [];
  for (const { key, index, info } of candidates) {
    if (kept.has(key)) continue;
    entries.push({
      index,
      tombstone: forgetTombstoneLine(info.tool, info.ageTurns, info.firstLine),
    });
  }
  return { asked: true, entries: entries.length > 0 ? entries : undefined };
}
