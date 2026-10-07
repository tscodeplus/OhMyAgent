/**
 * testlog.fold decision point (phase-1 M1): pure rules folding + the judged
 * `jev` pass through the admission hook.
 *
 * Fixtures use vitest-style failure dumps with byte-identical repeated blocks.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  foldMarkerLine,
  foldTestLogBlocks,
  TESTLOG_FOLD_POINT_ID,
} from '../../src/judge/testlog-fold.js';
import { admitToolResult } from '../../src/judge/admission/admission-hook.js';
import { JudgeEngine } from '../../src/judge/index.js';
import { JudgeLedger } from '../../src/judge/ledger.js';
import { createMockTier, mockJudgeConfig, type MockTierSpec } from './mock.js';
import type { ToolExecutionResult } from '../../src/tools/platform/tool-result.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'judge-fold-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Fixtures ──

function vitestFailureBlock(tag: string): string[] {
  return [
    `FAIL  tests/${tag}.test.ts > ${tag} does the thing`,
    `AssertionError: expected ${tag} to be 42`,
    ` ❯ tests/${tag}.test.ts:12:5`,
    `   10| it('...', () => {`,
    `   11|   const value = compute();`,
    `   12|   expect(value).toBe(42)`,
    `   13| })`,
    `   14|`,
    ` Expected: 42`,
    ` Received: 43`,
  ];
}

function buildDump(copyCount: number, tag: string): string {
  const block = vitestFailureBlock(tag);
  const lines: string[] = ['run start'];
  for (let i = 0; i < copyCount; i++) {
    lines.push(`\`\`\`run-${i + 1}\``);
    lines.push(...block);
  }
  lines.push('run end');
  return lines.join('\n');
}

// ── Pure rules layer ──

describe('foldTestLogBlocks (pure rules)', () => {
  it('keeps the first copy and replaces later copies with one marker line', () => {
    const text = buildDump(3, 'adder');
    const result = foldTestLogBlocks(text);
    expect(result.stats.blocks).toBe(1);
    expect(result.stats.folded).toBe(2);
    expect(result.stats.charsSaved).toBeGreaterThan(0);

    const outLines = result.text.split('\n');
    // first copy intact
    expect(result.text).toContain('```run-1`');
    expect(result.text).toContain('FAIL  tests/adder.test.ts');
    // later copies replaced by ONE line each, pointing at the original range
    const markers = outLines.filter((line) => line.startsWith('... identical to lines'));
    expect(markers).toHaveLength(2);
    expect(markers.every((line) => line.endsWith('above (folded; full output archived).'))).toBe(
      true,
    );
    // the block occupies original lines 3..12 (1-based), marker references it
    expect(markers[0]).toBe(foldMarkerLine(3, 12));
    // no repeated failure body remains
    const bodyOccurrences = result.text.split('FAIL  tests/adder.test.ts').length - 1;
    expect(bodyOccurrences).toBe(1);
  });

  it('folds blocks that are < 8 lines but >= 400 chars, and skips small ones', () => {
    // 3 lines × 150 chars = 450 chars with identical repetitions
    const wideBlock = ['w'.repeat(150), 'x'.repeat(150), 'y'.repeat(150)];
    const text = ['head', ...wideBlock, 'copy marker', ...wideBlock, 'tail'].join('\n');
    const result = foldTestLogBlocks(text);
    expect(result.stats.blocks).toBe(1);
    expect(result.stats.folded).toBe(1);

    // tiny repetition (2 lines, 8 chars) must NOT fold
    const small = ['alpha', 'beta', 'alpha', 'beta', 'alpha', 'beta'].join('\n');
    const smallResult = foldTestLogBlocks(small);
    expect(smallResult.stats.folded).toBe(0);
    expect(smallResult.text).toBe(small);
  });

  it('is idempotent: folding folded output changes nothing', () => {
    const once = foldTestLogBlocks(buildDump(3, 'goat'));
    expect(once.stats.folded).toBe(2);
    const twice = foldTestLogBlocks(once.text);
    expect(twice.stats.blocks).toBe(0);
    expect(twice.stats.folded).toBe(0);
    expect(twice.stats.charsSaved).toBe(0);
    expect(twice.text).toBe(once.text);
  });

  it('unique text is returned unchanged with zero stats', () => {
    const text = buildDump(1, 'only');
    const result = foldTestLogBlocks(text);
    expect(result.stats).toEqual({ blocks: 0, folded: 0, charsSaved: 0 });
    expect(result.text).toBe(text);
  });
});

// ── Hook layer ──

function makeFeaturesEngine(
  foldMode: 'off' | 'rules' | 'jev',
  modes: Record<string, 'active' | 'shadow' | 'off'>,
  overrides: Partial<MockTierSpec> = {},
): { engine: JudgeEngine; calls: NonNullable<MockTierSpec['calls']> } {
  const calls: NonNullable<MockTierSpec['calls']> = [];
  const tier = createMockTier({ judgeId: 'mock/j1', calls, ...overrides });
  const engine = new JudgeEngine({
    config: mockJudgeConfig({
      modes,
      features: {
        testLogFold: foldMode,
        admission: { chunkSizeChars: 2000, keepThreshold: 0.75 },
      },
    }),
    resolver: () => ({ tiers: [tier], noKeyRefs: [], unresolvableRefs: [] }),
    ledger: new JudgeLedger({ dir: tmpDir }),
  });
  return { engine, calls };
}

describe('testlog.fold hook (admitToolResult)', () => {
  it(`'rules' mode folds with zero judge calls`, async () => {
    const { engine, calls } = makeFeaturesEngine('rules', { default: 'active' });
    const result: ToolExecutionResult = { content: [{ type: 'text', text: buildDump(2, 'hint') }] };
    const admitted = await admitToolResult({ toolName: 'shell', result, engine });
    const outText = (admitted.content[0] as { type: 'text'; text: string }).text;
    expect(outText).toContain('... identical to lines 3-12 above (folded; full output archived).');
    expect(calls).toHaveLength(0); // no judge call in rules mode
    expect(engine.ledger.recent(1).length).toBe(0);
  });

  it(`'jev' mode folds by rules then evicts remaining blocks at P(not-needed) >= 0.9`, async () => {
    const { engine, calls } = makeFeaturesEngine(
      'jev',
      { default: 'active' },
      { answers: { t1: { type: 'noul', probability: 0.05 } } },
    );
    const result: ToolExecutionResult = { content: [{ type: 'text', text: buildDump(2, 'hint') }] };
    const admitted = await admitToolResult({ toolName: 'shell', result, engine });
    const outText = (admitted.content[0] as { type: 'text'; text: string }).text;
    // rule fold first (2 copies → 1), then goal-aware pass evicts the block
    expect(outText).not.toContain('FAIL  tests/hint.test.ts');
    expect(outText).toContain('[folded-out: block t1 of shell result, full text at session log]');
    expect(calls).toHaveLength(1); // one decideMany for the jev pass
    expect(
      calls[0]!.context.questions[TESTLOG_FOLD_POINT_ID === 'testlog.fold' ? 't1' : 't1'],
    ).toBeDefined();
    // one ledger line for the judged pass, none for the rules fold
    expect(engine.ledger.recent(5).length).toBe(1);
  });

  it(`'jev' mode keeps gray blocks (evict threshold not reached)`, async () => {
    const { engine } = makeFeaturesEngine(
      'jev',
      { default: 'active' },
      { answers: { t1: { type: 'noul', probability: 0.2 } } },
    );
    const result: ToolExecutionResult = { content: [{ type: 'text', text: buildDump(2, 'hint') }] };
    const admitted = await admitToolResult({ toolName: 'shell', result, engine });
    const outText = (admitted.content[0] as { type: 'text'; text: string }).text;
    expect(outText).toContain('FAIL  tests/hint.test.ts'); // kept
    expect(outText).not.toContain('[folded-out');
  });

  it('point mode off + features off → strict no-op, same output, no ledger line', async () => {
    const { engine, calls } = makeFeaturesEngine('off', { default: 'off' });
    const text = buildDump(2, 'hint');
    const result: ToolExecutionResult = { content: [{ type: 'text', text }] };
    const admitted = await admitToolResult({ toolName: 'shell', result, engine });
    expect(admitted).toBe(result);
    expect((admitted.content[0] as { type: 'text'; text: string }).text).toBe(text);
    expect(calls).toHaveLength(0);
    expect(engine.ledger.recent(1).length).toBe(0);
  });
});
