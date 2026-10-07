/**
 * tool.admission decision spec + admission hook (phase-1 M1).
 *
 * Deterministic mock judge (./mock.ts): chunk policy thresholds (conservative
 * 0.9 drop side), state-cap batching into sequential decideMany calls, the
 * eviction pointer line format, shadow no-op, and the strict no-op invariant
 * (judge undefined OR point off → identical output, no ledger line).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyAdmissionChunks,
  admissionPointerLine,
  chunkToolOutputText,
  createToolAdmissionSpec,
  TOOL_ADMISSION_POINT_ID,
} from '../../src/judge/decisions/tool-admission.js';
import { admitToolResult } from '../../src/judge/admission/admission-hook.js';
import { JudgeEngine } from '../../src/judge/index.js';
import { JudgeLedger } from '../../src/judge/ledger.js';
import { setTurnTaskHint } from '../../src/agent/agent-context.js';
import { createMockResolver, createMockTier, mockJudgeConfig, type MockTierSpec } from './mock.js';
import type { ToolExecutionResult } from '../../src/tools/platform/tool-result.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'judge-admission-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngine(
  mode: 'active' | 'shadow' | 'off',
  overrides: Partial<MockTierSpec> = {},
): {
  engine: JudgeEngine;
  calls: NonNullable<MockTierSpec['calls']>;
} {
  const calls: NonNullable<MockTierSpec['calls']> = [];
  const tier = createMockTier({
    judgeId: 'mock/j1',
    calls,
    ...overrides,
  });
  const engine = new JudgeEngine({
    config: mockJudgeConfig(mode === 'active' ? {} : { modes: { default: mode } }),
    resolver: () => ({ tiers: [tier], noKeyRefs: [], unresolvableRefs: [] }),
    ledger: new JudgeLedger({ dir: tmpDir }),
  });
  return { engine, calls };
}

// keep-probabilities: a chunk is evicted only at P(keep) <= 0.1 (P(drop) >= 0.9)
const KEEP = 0.9;
const GRAY_KEEP = 0.2; // decided "not needed" at 80% — kept (conservative)
const EVICT = 0.05;

describe('tool.admission spec policy', () => {
  it('evicts only P(drop) >= 0.9, keeps gray and conservative chunks; keep ids listed', async () => {
    const { engine, calls } = makeEngine('active', {
      answers: {
        c1: { type: 'noul', probability: KEEP },
        c2: { type: 'noul', probability: GRAY_KEEP },
        c3: { type: 'noul', probability: EVICT },
      },
    });
    const spec = createToolAdmissionSpec(['c1', 'c2', 'c3']);
    const verdict = await engine.decideMany(spec, {
      state: {
        taskHint: 'fix the failing build',
        chunks: [
          { id: 'c1', firstLine: 'a', sizeChars: 10, text: 'aaa' },
          { id: 'c2', firstLine: 'b', sizeChars: 10, text: 'bbb' },
          { id: 'c3', firstLine: 'c', sizeChars: 10, text: 'ccc' },
        ],
      },
      sessionId: 's1',
    });
    expect(verdict.source).toBe('judge');
    expect(verdict.mode).toBe('active');
    expect(verdict.outcome).toEqual({ action: 'keep', ids: ['c1', 'c2'] });
    // one batched call, state billed once, taskHint included
    expect(calls.length).toBe(1);
    const state = calls[0]!.context.state as { taskHint: string; chunks: unknown[] };
    expect(state.taskHint).toBe('fix the failing build');
    expect(state.chunks).toHaveLength(3);
  });

  it('all-clear verdicts keep everything (keep-all)', async () => {
    const { engine } = makeEngine('active', {
      answers: { c1: { type: 'noul', probability: KEEP } },
    });
    const verdict = await engine.decideMany(createToolAdmissionSpec(['c1']), {
      state: { chunks: [{ id: 'c1', firstLine: 'a', sizeChars: 3, text: 'a' }] },
    });
    expect(verdict.outcome).toEqual({ action: 'keep-all' });
  });

  it('shadow asks (ledger line) but outcome is the keep-all fallback', async () => {
    const { engine } = makeEngine('shadow');
    const verdict = await engine.decideMany(createToolAdmissionSpec(['c1']), {
      state: { chunks: [{ id: 'c1', firstLine: 'a', sizeChars: 3, text: 'a' }] },
      sessionId: 's1',
    });
    expect(verdict.mode).toBe('shadow');
    expect(verdict.outcome).toEqual({ action: 'keep-all' });
    expect(engine.ledger.recent(1).length).toBe(1);
  });

  it('off: never asked, no ledger line', async () => {
    const { engine, calls } = makeEngine('off');
    const verdict = await engine.decideMany(createToolAdmissionSpec(['c1']), {
      state: { chunks: [] },
      sessionId: 's1',
    });
    expect(verdict.fallbackReason).toBe('mode-off');
    expect(calls).toHaveLength(0);
    expect(engine.ledger.recent(1).length).toBe(0);
  });
});

describe('tool.admission chunking + pointer rebuild', () => {
  it('chunks at line boundaries and reconstructs byte-identically', () => {
    const text = 'l1\nl2\nl3\nl4\nl5\n';
    const chunks = chunkToolOutputText(text, 3);
    // 2-char lines + separator = 3 → one chunk per line (trailing empty line too)
    expect(chunks.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
    expect(chunks.map((c) => c.text).join('\n')).toBe(text);

    const grouped = chunkToolOutputText(text, 7);
    expect(grouped.map((c) => c.id)).toEqual(['c1', 'c2']); // 3+3+3=9, 2+2+1=5→7 flushes
    expect(grouped.map((c) => c.text).join('\n')).toBe(text);
  });

  it('fallback keep-all rebuild is a no-op; eviction replaces with the pointer line', () => {
    const chunks = [
      { id: 'c1', firstLine: 'one', sizeChars: 3, text: 'one' },
      { id: 'c2', firstLine: 'two', sizeChars: 3, text: 'two' },
    ];
    expect(
      applyAdmissionChunks(chunks, { action: 'keep-all' }, { toolName: 'shell', pointer: 'x' }),
    ).toBeUndefined();
    expect(
      applyAdmissionChunks(
        chunks,
        { action: 'keep', ids: ['c1'] },
        { toolName: 'shell', pointer: 'here.txt' },
      ),
    ).toBe(`one\n${admissionPointerLine('c2', 'shell', 'here.txt')}`);
    expect(admissionPointerLine('c2', 'shell', 'here.txt')).toBe(
      '[admitted-out: chunk c2 of shell result, full text at here.txt]',
    );
  });
});

describe('admission hook (admitToolResult)', () => {
  function bigResult(): ToolExecutionResult {
    return { content: [{ type: 'text', text: '' }], metadata: {} };
  }

  it('state-cap split: >24K chunks go through multiple sequential decideMany calls', async () => {
    // 20 chunks of 4000 chars: capped at 1500 state-chars per chunk → 16 per
    // batch (24K) → two batches.
    const chunkSize = 2000;
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      const line = `chunk ${i + 1} data payload ${'x'.repeat(chunkSize - 20)}`;
      lines.push(line, '');
    }
    const text = lines.join('\n');
    const answers: MockTierSpec['answers'] = {};
    for (let i = 1; i <= 20; i++) answers[`c${i}`] = { type: 'noul', probability: KEEP };
    answers['c19'] = { type: 'noul', probability: EVICT };
    const { engine, calls } = makeEngine('active', { answers });
    setTurnTaskHint('sess-1', 'write tests for the judge kernel');
    const result: ToolExecutionResult = {
      content: [{ type: 'text', text }],
      metadata: {},
    };
    const admitted = await admitToolResult({
      toolName: 'shell',
      sessionId: 'sess-1',
      result,
      engine,
    });
    expect(calls.length).toBe(2);
    expect(calls[0]!.opts.timeoutMs).toBeGreaterThan(0);
    const outText = (admitted.content[0] as { type: 'text'; text: string }).text;
    expect(outText).not.toBe(text);
    // evicted chunk replaced by the pointer line referencing the session log
    expect(outText).toContain(
      '[admitted-out: chunk c19 of shell result, full text at session log]',
    );
    expect(outText).not.toContain('chunk 19 data payload');
    expect(outText).toContain('chunk 18 data payload');
    expect(outText).toContain('chunk 20 data payload');
    // taskHint from the turn-task store reached the judge state
    const state1 = calls[0]!.context.state as { taskHint: string };
    expect(state1.taskHint).toBe('write tests for the judge kernel');
  });

  it('result under chunkSizeChars is untouched (no call)', async () => {
    const { engine, calls } = makeEngine('active');
    const result: ToolExecutionResult = { content: [{ type: 'text', text: 'short output' }] };
    const admitted = await admitToolResult({ toolName: 'shell', result, engine });
    expect(admitted).toBe(result);
    expect(calls).toHaveLength(0);
  });

  it('MCP offload metadata is used as the pointer', async () => {
    const chunkA = 'a'.repeat(2500);
    const chunkB = 'b'.repeat(2500);
    const text = `${chunkA}\n${chunkB}`;
    const { engine } = makeEngine('active', {
      answers: {
        // chunks split at line boundaries: c1 = chunkA (+ first empty line), c2 = chunkB
        c1: { type: 'noul', probability: KEEP },
        c2: { type: 'noul', probability: EVICT },
      },
    });
    const result: ToolExecutionResult = {
      content: [{ type: 'text', text }],
      metadata: { fullOutputPath: '/data/offload/abc.txt' },
    };
    const admitted = await admitToolResult({ toolName: 'mcp__owner__tool', result, engine });
    const outText = (admitted.content[0] as { type: 'text'; text: string }).text;
    expect(outText).toContain(
      '[admitted-out: chunk c2 of mcp__owner__tool result, full text at /data/offload/abc.txt]',
    );
  });
});

describe('strict no-op invariant (tool.admission)', () => {
  it('engine undefined → hook never invoked; point off → identical result, no ledger line', async () => {
    const { engine, calls } = makeEngine('off');
    const text = 'x'.repeat(5000);
    // Judge undefined: the adapter (integration path) skips admitToolResult —
    // simulated here by the direct contract: without a call the result object
    // stays the same reference.
    const result: ToolExecutionResult = { content: [{ type: 'text', text }] };
    // Point off:
    const admitted = await admitToolResult({ toolName: 'shell', result, engine });
    expect(admitted).toBe(result);
    expect(calls).toHaveLength(0);
    expect(engine.ledger.recent(1).length).toBe(0);
    // TOOL_ADMISSION_POINT_ID sanity (registry contract)
    expect(TOOL_ADMISSION_POINT_ID).toBe('tool.admission');
  });
});

describe('adapter integration — engine undefined', () => {
  it('tool result passes through byte-identical when services.judge is missing', async () => {
    const { AgentToolAdapterImpl } = await import('../../src/tools/platform/agent-tool-adapter.js');
    const adapter = new AgentToolAdapterImpl({ getServices: () => ({}) as never });
    const bigText = 'payload\n\n'.repeat(600); // > chunkSizeChars
    const def = {
      name: 'shell',
      label: 'shell',
      description: 'test tool',
      category: 'shell' as const,
      parametersSchema: { type: 'object' },
      capability: {
        category: 'shell' as const,
        readOnly: true,
        readsFiles: false,
        writesFiles: false,
        usesShell: true,
        usesNetwork: false,
        usesComputerUse: false,
        pathAccess: 'none' as const,
        approvalDefault: 'none' as const,
      },
      execute: async () => ({ content: [{ type: 'text' as const, text: bigText }], metadata: {} }),
    };
    const tool = adapter.toAgentTool(def as never);
    const out = await tool.execute('call-1', {}, undefined, undefined);
    expect((out.content[0] as { text: string }).text).toBe(bigText);
  });
});

describe('registered point id contract', () => {
  it('point id matches the registry catalog', () => {
    expect(TOOL_ADMISSION_POINT_ID).toBe('tool.admission');
    expect(makeEngine('active').engine.modeFor(TOOL_ADMISSION_POINT_ID)).toBe('active');
  });
});
