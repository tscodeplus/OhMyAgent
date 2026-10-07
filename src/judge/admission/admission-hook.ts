/**
 * Hook for `tool.admission` + `testlog.fold` (phase-1 M1): optional
 * post-processing between tool result production and transcript entry.
 *
 * Caller: `AgentToolAdapterImpl` — inside the already-async tool execution
 * flow, every judge call awaited, so no floating/misused promises are
 * introduced. MCP offload (`src/mcp/offload.ts`) runs UPSTREAM of this hook;
 * when the result metadata carries the spill path the eviction pointers
 * reference it, otherwise they point at the session log (the full result
 * stays in the session record).
 *
 * STRICT no-ops:
 *   - engine absent — the caller (adapter) skips the hook entirely;
 *   - `tool.admission` mode 'off' → no admission, no ledger line;
 *   - `testlog.fold` mode 'off' → no judged fold pass; the pure rules layer
 *     only runs when `features.testLogFold` is 'rules' or 'jev'.
 * Shadow mode asks + ledger writes but keeps the result unchanged (channel
 * level: zero output change — the defining shadow property).
 */

import type { Logger } from 'pino';
import type { ToolExecutionResult } from '../../tools/platform/tool-result.js';
import type { JudgeEngine } from '../engine.js';
import {
  chunkToolOutputText,
  applyAdmissionChunks,
  admissionPointerLine,
  createToolAdmissionSpec,
  TOOL_ADMISSION_POINT_ID,
  type ToolAdmissionChunk,
} from '../decisions/tool-admission.js';
import {
  createTestLogFoldSpec,
  testLogFoldPointerLine,
  TESTLOG_FOLD_POINT_ID,
  type TestLogFoldBlock,
} from '../testlog-fold.js';
import { foldTestLogBlocks } from './testlog-fold-rules.js';
import { activeSkillForSession } from '../../agent/skill-activator.js';
import { getTurnTaskHint } from '../../agent/agent-context.js';
import { screenExternalToolResult } from '../hooks/safety-injection-screen.js';

/** Jev-1.13 contextWindow is ~32K tokens — a state over ~24K chars is split into sequential batches. */
const STATE_CHAR_CAP = 24_000;
/** Per-chunk text carried into a state (impl doc §4.1). */
const STATE_CHUNK_TEXT_MAX = 1500;

export interface AdmitToolResultInput {
  toolName: string;
  sessionId?: string;
  result: ToolExecutionResult;
  /** Present-only contract: the adapter gates on `services.judge` before calling. */
  engine: JudgeEngine;
  logger?: Logger;
}

interface JudgedPart {
  id: string;
  text: string;
}

/** Split sequential decideMany batches so each state stays under STATE_CHAR_CAP. */
function splitBatches(
  parts: Array<{ id: string; text: string }>,
): Array<Array<{ id: string; text: string }>> {
  const batches: Array<Array<{ id: string; text: string }>> = [];
  let current: Array<{ id: string; text: string }> = [];
  let currentChars = 0;
  for (const part of parts) {
    const partChars = Math.min(part.text.length, STATE_CHUNK_TEXT_MAX);
    if (currentChars + partChars > STATE_CHAR_CAP && current.length > 0) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(part);
    currentChars += partChars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function pointerFor(result: ToolExecutionResult): string {
  const spill = (result.metadata as Record<string, unknown> | undefined)?.fullOutputPath;
  return typeof spill === 'string' && spill.length > 0 ? spill : 'session log';
}

/** Text blocks merged for judging; everything else (images/files) rides along untouched. */
function splitResultText(result: ToolExecutionResult): {
  textBlocks: Array<{ type: 'text'; text: string }>;
  mergedText: string;
  nonTextBlocks: ToolExecutionResult['content'];
} {
  const textBlocks = result.content.filter(
    (block): block is { type: 'text'; text: string } => block.type === 'text',
  );
  const mergedText = textBlocks.map((block) => block.text).join('\n');
  const nonTextBlocks = result.content.filter((block) => block.type !== 'text');
  return { textBlocks, mergedText, nonTextBlocks };
}

/**
 * Judged fold pass (`features.testLogFold: 'jev'`): goal-aware noul per block
 * of the rule-folded text; evicts at P(not needed) >= 0.9, gray keeps.
 */
async function judgeFoldBlocks(input: {
  engine: JudgeEngine;
  text: string;
  chunkSizeChars: number;
  toolName: string;
  pointer: string;
  taskHint: string;
  sessionId?: string;
  logger?: Logger;
}): Promise<string> {
  const blocks: TestLogFoldBlock[] = chunkToolOutputText(input.text, input.chunkSizeChars).map(
    (chunk, index) => ({
      id: `t${index + 1}`,
      firstLine: chunk.firstLine,
      sizeChars: chunk.sizeChars,
      text: chunk.text,
    }),
  );
  if (blocks.length === 0) return input.text;

  const evicted = new Map<string, string>(); // block id → pointer line
  for (const batch of splitBatches(blocks)) {
    try {
      const verdict = await input.engine.decideMany(createTestLogFoldSpec(batch.map((b) => b.id)), {
        state: { taskHint: input.taskHint, toolName: input.toolName, blocks: batch },
        sessionId: input.sessionId,
      });
      if (
        verdict.source === 'judge' &&
        verdict.mode === 'active' &&
        verdict.outcome.action === 'keep'
      ) {
        const kept = new Set(verdict.outcome.ids);
        for (const block of batch) {
          if (!kept.has(block.id)) {
            evicted.set(block.id, testLogFoldPointerLine(block.id, input.toolName, input.pointer));
          }
        }
      }
    } catch (err) {
      input.logger?.warn({ err }, 'Judge testlog.fold pass failed (non-fatal)');
    }
  }
  if (evicted.size === 0) return input.text;
  return blocks.map((block) => evicted.get(block.id) ?? block.text).join('\n');
}

/**
 * Apply the judged admission pipeline to one tool result. Never throws —
 * per-batch failures only log and keep that batch.
 */
export async function admitToolResult(input: AdmitToolResultInput): Promise<ToolExecutionResult> {
  const { engine, result } = input;
  const features = engine.section.features;
  const chunkSizeChars = features?.admission?.chunkSizeChars ?? 2000;
  const pointer = pointerFor(result);
  const taskHint = input.sessionId ? (getTurnTaskHint(input.sessionId) ?? '') : '';

  const { mergedText, nonTextBlocks } = splitResultText(result);
  if (mergedText.length === 0) return result;

  let working = mergedText;

  // ── kernel M3 `injection.screen`: per-paragraph screening of external results ──
  // web_fetch / mcp__* results only; runs BEFORE admission so judged-AI-directed
  // instruction segments are replaced (one-line note) before chunk admission.
  // Gated + fail-closed inside the hook module (src/judge/hooks/safety-injection-screen.ts).
  working = await screenExternalToolResult({
    engine,
    toolName: input.toolName,
    sessionId: input.sessionId,
    text: working,
    logger: input.logger,
  });

  // ── test-log folding: pure rules, plus the judged pass in 'jev' mode ──
  const foldMode = features?.testLogFold ?? 'off';
  if (foldMode !== 'off') {
    const folded = foldTestLogBlocks(working);
    if (folded.stats.folded > 0) working = folded.text;
    if (foldMode === 'jev' && engine.modeFor(TESTLOG_FOLD_POINT_ID) !== 'off') {
      working = await judgeFoldBlocks({
        engine,
        text: working,
        chunkSizeChars,
        toolName: input.toolName,
        pointer,
        taskHint,
        sessionId: input.sessionId,
        logger: input.logger,
      });
    }
  }

  // ── judged chunk admission (state-cap batched decideMany) ──
  if (engine.modeFor(TOOL_ADMISSION_POINT_ID) !== 'off' && working.length > chunkSizeChars) {
    const chunks: ToolAdmissionChunk[] = chunkToolOutputText(working, chunkSizeChars);
    const goalHint = input.sessionId
      ? activeSkillForSession.get(input.sessionId)?.skill.manifest.id
      : undefined;
    const evicted = new Map<string, string>(); // chunk id → pointer line
    // Sequential batches (state cap); batches are disjoint, so accumulated
    // eviction decisions drive the final rebuild.
    for (const batch of splitBatches(chunks)) {
      try {
        const verdict = await engine.decideMany(
          createToolAdmissionSpec(batch.map((chunk) => chunk.id)),
          {
            state: {
              taskHint,
              ...(goalHint ? { goalHint } : {}),
              toolName: input.toolName,
              chunks: batch,
            },
            sessionId: input.sessionId,
          },
        );
        if (
          verdict.source === 'judge' &&
          verdict.mode === 'active' &&
          verdict.outcome.action === 'keep'
        ) {
          const kept = new Set(verdict.outcome.ids);
          for (const chunk of batch) {
            if (!kept.has(chunk.id)) {
              evicted.set(chunk.id, admissionPointerLine(chunk.id, input.toolName, pointer));
            }
          }
        }
      } catch (err) {
        input.logger?.warn({ err }, 'Judge tool.admission batch failed (non-fatal)');
      }
    }
    if (evicted.size > 0) {
      const rebuilt = applyAdmissionChunks(
        chunks,
        { action: 'keep', ids: chunks.map((chunk) => chunk.id).filter((id) => !evicted.has(id)) },
        { toolName: input.toolName, pointer },
      );
      if (typeof rebuilt === 'string') working = rebuilt;
    }
  }

  if (working === mergedText) return result;
  return {
    ...result,
    content: [{ type: 'text', text: working }, ...nonTextBlocks],
  };
}
