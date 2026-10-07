/**
 * Hook for kernel M3 decision point `injection.screen` (impl doc §4.9):
 * per-paragraph screening of WEB / MCP tool results for instructions
 * targeting the AI, before the result enters the context.
 *
 * Caller: `src/judge/admission/admission-hook.ts` — inside the admission
 * pipeline that `AgentToolAdapterImpl` already hosts, running BEFORE chunk
 * admission so screened replacements are admitted as ordinary text. The
 * MCP large-output offload (`src/mcp/offload.ts`) stays UPSTREAM of this
 * pipeline: offload owns "too big → spill to disk", this point owns
 * "instruction-bearing paragraph → one-line note".
 *
 * FAIL-CLOSED: an unexpected failure inside the judge call never silently
 * passes the text through — it degrades to the STATIC_INJECTION_PATTERNS
 * phrase floor (the same fallback an active-mode verdict-less result gets).
 * Shadow mode asks + ledger lines but keeps the text unchanged (the defining
 * shadow property), which is a recorded no-op, not a fail-open.
 */

import type { Logger } from 'pino';
import type { JudgeEngine } from '../engine.js';
import {
  INJECTION_SCREEN_POINT_ID,
  applyStaticScreen,
  injectionNoteLine,
  isExternalContentTool,
  screenToolResultText,
  splitScreenParagraphs,
} from '../decisions/injection-screen.js';

/** Short texts (no real paragraph content) are not screenable — keeps the call rate sane. */
const MIN_SCREENABLE_CHARS = 32;

export interface ScreenExternalToolResultInput {
  /** Present-only contract: the caller (admission hook) gates on the engine. */
  engine: JudgeEngine;
  toolName: string;
  sessionId?: string;
  text: string;
  logger?: Logger;
}

/**
 * Screen one external tool result's text. Returns the screened replacement,
 * or the input text unchanged when nothing is blocked (external-tool gate,
 * short text, mode off, shadow, judge says keep-all). Never throws.
 */
export async function screenExternalToolResult(
  input: ScreenExternalToolResultInput,
): Promise<string> {
  const text = input.text;
  if (!isExternalContentTool(input.toolName)) return text;
  if (!text || text.trim().length < MIN_SCREENABLE_CHARS) return text;
  if (input.engine.modeFor(INJECTION_SCREEN_POINT_ID) === 'off') return text;
  try {
    const screened = await screenToolResultText({
      toolName: input.toolName,
      sessionId: input.sessionId,
      text,
      engine: input.engine,
    });
    return typeof screened.screened === 'string' ? screened.screened : text;
  } catch (err) {
    input.logger?.warn({ err }, 'Judge injection.screen pass failed — static phrase floor');
    // Fail-closed: an unexpected judge failure degrades to the static phrase
    // floor instead of passing instruction-bearing segments through unscreened.
    const note = injectionNoteLine();
    return applyStaticScreen(splitScreenParagraphs(text), note) ?? text;
  }
}
