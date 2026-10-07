/**
 * Shared fixture helpers for the M2/M3 decision-point tests (the mock judge
 * from tests/judge/mock.ts drives the REAL engine path — mode gating, gray
 * cascade and fallback behavior are exercised end-to-end, not stubbed).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach } from 'vitest';
import { JudgeEngine } from '../../src/judge/index.js';
import { JudgeLedger } from '../../src/judge/ledger.js';
import { createMockTier, mockJudgeConfig, type MockTierSpec } from './mock.js';

let tmpDir = '';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'judge-decisions-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Engine + spy call list bound to a fixed-answer mock tier under `mode`. */
export function makeEngine(
  mode: 'active' | 'shadow' | 'off',
  overrides: Partial<MockTierSpec> = {},
  sectionOverrides: Partial<Parameters<typeof mockJudgeConfig>[0]> = {},
): { engine: JudgeEngine; calls: NonNullable<MockTierSpec['calls']> } {
  const calls: NonNullable<MockTierSpec['calls']> = [];
  const tier = createMockTier({ judgeId: 'mock/j1', calls, ...overrides });
  const engine = new JudgeEngine({
    config: mockJudgeConfig(
      mode === 'active' ? sectionOverrides : { modes: { default: mode }, ...sectionOverrides },
    ),
    resolver: () => ({ tiers: [tier], noKeyRefs: [], unresolvableRefs: [] }),
    ledger: new JudgeLedger({ dir: tmpDir }),
  });
  return { engine, calls };
}
