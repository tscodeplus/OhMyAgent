/**
 * Judged experience gate (kernel M2 `memory.capture` + `memory.worth`).
 *
 * The judged capture pipeline is ADDITIVE to the session summarizer: user
 * messages that the capture point judges as "corrects the agent / establishes
 * a rule" produce candidates; the worth point then decides
 * `useful-again / one-off / already-known`, and only `useful-again` messages
 * are persisted (via MemoryWriter, with the SAME write-path quality gates the
 * other memory writes run — isSafe / shouldExtractL1 / isPromptInjection).
 *
 * STRICT no-ops (identical to the pre-judge behavior — zero writes):
 *   - judge engine absent (kernel disabled or no resolvable judge);
 *   - either point mode 'off'.
 *
 * Shadow semantics: the points are asked (ledger lines) but the pipeline
 * activates only when BOTH capture and worth deliver a judged+active verdict;
 * a fallback worth verdict keeps every judged-capture candidate (keep-all).
 * Every judge/write failure is logged and swallowed — a judged memory
 * pipeline must never break the summarization run.
 */

import type { Logger } from 'pino';
import type { MemoryWriter } from './memory-writer.js';
import { detectCategory, isPromptInjection, isSafe, shouldExtractL1 } from './memory-filter.js';
import {
  createMemoryCaptureSpec,
  MEMORY_CAPTURE_POINT_ID,
  MEMORY_CAPTURE_TEXT_MAX,
  memoryCaptureKeys,
  type MemoryCaptureMessage,
} from '../judge/decisions/memory-capture.js';
import {
  createMemoryWorthSpec,
  MEMORY_WORTH_POINT_ID,
  memoryWorthKeys,
  type MemoryWorthCandidate,
} from '../judge/decisions/memory-worth.js';
import type { JudgeEngine } from '../judge/engine.js';
import { currentJudgeEngine } from '../judge/engine-lookup.js';

/** Max user messages judged per summarization run (cost bound). */
const MAX_CANDIDATES = 20;

/** Min assistant-reply excerpt carried as scenario context (state minimization). */
const SCENARIO_MAX = 300;

export interface JudgeExperienceGateInput {
  judgeGet?: () => JudgeEngine | undefined;
  sessionKey: string;
  /** Chronological transcript slice for this summarization run (cleaned text). */
  messages: Array<{ role: string; content: string }>;
  writer: MemoryWriter;
  channel: string | null;
  logger: Pick<Logger, 'debug' | 'info' | 'warn'>;
  agentId?: string | null;
}

export interface JudgeExperienceGateResult {
  /** Judge was consulted at all (both point modes not 'off', engine present). */
  asked: boolean;
  /** Messages written through the judged pipeline (active mode only). */
  written: number;
}

/**
 * Run the judged capture → worth pipeline over a summarization run's user
 * messages. Never throws; failures are logged at debug level and skipped.
 */
export async function judgeExperiences(
  input: JudgeExperienceGateInput,
): Promise<JudgeExperienceGateResult> {
  const engine = input.judgeGet?.() ?? currentJudgeEngine();
  if (!engine) return { asked: false, written: 0 };
  try {
    if (engine.modeFor(MEMORY_CAPTURE_POINT_ID) === 'off') return { asked: false, written: 0 };
    if (engine.modeFor(MEMORY_WORTH_POINT_ID) === 'off') return { asked: false, written: 0 };

    // Candidate user messages that already pass the existing write-path filters.
    const candidates: Array<{ role: string; content: string }> = [];
    for (const message of input.messages) {
      if (message.role !== 'user') continue;
      const text = message.content.trim();
      if (text.length < 5 || text.length > 2000) continue; // isSafe bounds
      if (!shouldExtractL1(text)) continue;
      if (isPromptInjection(text)) continue;
      candidates.push({ role: 'user', content: text });
      if (candidates.length >= MAX_CANDIDATES) break;
    }
    if (candidates.length === 0) return { asked: false, written: 0 };

    const assistantScenario =
      ([...input.messages].reverse().find((m) => m.role === 'assistant')?.content ?? '').slice(
        0,
        SCENARIO_MAX,
      ) || undefined;

    // ── Point 1: memory.capture (noul per candidate message) ──
    const captureKeys = memoryCaptureKeys(candidates.length);
    const captureMessages: MemoryCaptureMessage[] = candidates.map((m, index) => ({
      id: `u${index + 1}`,
      key: captureKeys[index]!,
      text: m.content.slice(0, MEMORY_CAPTURE_TEXT_MAX),
    }));
    const captureVerdict = await engine.decideMany(createMemoryCaptureSpec(captureMessages), {
      state: {
        ...(assistantScenario ? { assistantScenario } : {}),
        messages: captureMessages,
      },
      sessionId: input.sessionKey,
    });
    if (captureVerdict.source !== 'judge' || captureVerdict.mode !== 'active') {
      return { asked: true, written: 0 };
    }
    if (captureVerdict.outcome.action !== 'keep') return { asked: true, written: 0 };

    const judgedMessages = captureVerdict.outcome.ids
      .map((id) => captureMessages.find((m) => m.id === id))
      .filter((m): m is MemoryCaptureMessage => Boolean(m))
      // Belt and braces: re-assert the per-message quality gate on the text
      // that will actually be written (the judge saw truncated state).
      .filter((m) => !isPromptInjection(m.text) && isSafe(m.text).capture);

    if (judgedMessages.length === 0) {
      input.logger.debug(
        { sessionKey: input.sessionKey, captureCandidates: candidates.length },
        'Judged capture kept no messages',
      );
      return { asked: true, written: 0 };
    }

    // ── Point 2: memory.worth (choice per judged candidate) ──
    const worthKeys = memoryWorthKeys(judgedMessages.length);
    const worthCandidates: MemoryWorthCandidate[] = judgedMessages.map((m, index) => ({
      id: m.id,
      key: worthKeys[index]!,
      text: m.text,
    }));
    const worthVerdict = await engine.decideMany(createMemoryWorthSpec(worthCandidates), {
      state: {
        ...(assistantScenario ? { scenario: assistantScenario } : {}),
        candidates: worthCandidates,
      },
      sessionId: input.sessionKey,
    });

    let persist: MemoryWorthCandidate[];
    if (worthVerdict.source === 'judge' && worthVerdict.mode === 'active') {
      if (worthVerdict.outcome.action === 'keep') {
        persist = worthVerdict.outcome.ids
          .map((id) => worthCandidates.find((c) => c.id === id))
          .filter((c): c is MemoryWorthCandidate => Boolean(c));
      } else if (worthVerdict.outcome.action === 'keep-all') {
        persist = worthCandidates;
      } else {
        persist = [];
      }
    } else {
      // Fallback verdict = keep-all semantics: the capture point already said
      // this message belongs in the pipeline, so all judged candidates persist.
      persist = worthCandidates;
    }

    let written = 0;
    for (const candidate of persist) {
      try {
        await input.writer.write({
          content: candidate.text,
          scope: 'user',
          scopeKey: input.sessionKey,
          kind: detectCategory(candidate.text),
          sourceChannel: input.channel,
          agentId: input.agentId ?? undefined,
          metadata: { judgeCapture: true },
        });
        written += 1;
      } catch (err) {
        input.logger.debug(
          { err, sessionKey: input.sessionKey },
          'Judged experience write failed — non-fatal',
        );
      }
    }
    input.logger.info(
      { sessionKey: input.sessionKey, judged: captureMessages.length, persisted: written },
      'Judged experience gate run',
    );
    return { asked: true, written };
  } catch (err) {
    input.logger.warn(
      { err, sessionKey: input.sessionKey },
      'Judged experience gate failed — skipping (non-fatal)',
    );
    return { asked: true, written: 0 };
  }
}
