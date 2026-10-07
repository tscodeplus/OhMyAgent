/**
 * Shared helpers for the real-judge contract tests (tests/judge/contract-*.test.ts):
 * env gating (no key → auto-skip, zero network) and one golden-sample engine run
 * with answer-SHAPE assertions only (bounded answers, no semantics).
 */

import { expect } from 'vitest';
import { createLogger } from '../../src/app/logger.js';
import { JudgeEngine } from '../../src/judge/engine.js';
import { JudgeLedger } from '../../src/judge/ledger.js';
import { JudgeResolver } from '../../src/judge/judge-resolver.js';
import { goldenSampleSpec, GOLDEN_SAMPLE_STATE } from '../../src/judge/golden-sample.js';
import type { JudgeSectionConfig } from '../../src/judge/types.js';

/** True when the env var exists and is non-empty (skipIf helper). */
export function isNonEmptyEnv(name: string): boolean {
  return typeof process.env[name] === 'string' && process.env[name].length > 0;
}

export interface GoldenContractOptions {
  provider: string;
  modelRef: string;
  /** Scoped env for the resolver — the ONLY env source (host-env independent). */
  env: Record<string, string | undefined>;
  /** Expected verdict.judgeId (default `${provider}/${modelRef}`). */
  judgeId?: string;
  /** Ledger directory for the golden run. */
  ledgerDir?: string;
}

/**
 * One shadow-mode golden-sample decide() against a REAL provider, asserting
 * the verdict attribution plus noul/choice/score answer shapes.
 */
export async function runGoldenContract(options: GoldenContractOptions): Promise<void> {
  const judgeId = options.judgeId ?? `${options.provider}/${options.modelRef}`;
  const logger = createLogger();
  const config: JudgeSectionConfig = {
    enabled: true,
    provider: options.provider,
    modelRef: options.modelRef,
    modes: { default: 'shadow' },
    features: { testLogFold: 'off', admission: { chunkSizeChars: 2000, keepThreshold: 0.75 } },
    timeoutMs: 20000,
    recordState: false,
  };
  const resolver = new JudgeResolver({ config, logger, env: options.env });
  const chain = resolver.resolveChain('test');
  expect(chain.tiers.map((t) => t.judgeId)).toEqual([judgeId]);
  expect(chain.noKeyRefs).toEqual([]);

  const engine = new JudgeEngine({
    config,
    resolver: (pointId) => resolver.resolveChain(pointId),
    ledger: new JudgeLedger({
      dir: options.ledgerDir ?? 'data/judge-ledger-contract-test',
      logger,
    }),
    logger,
  });

  // Shadow mode: behavior-neutral, but the judged answers land in the verdict.
  const verdict = await engine.decide(goldenSampleSpec(), {
    state: GOLDEN_SAMPLE_STATE,
    sessionId: `contract-${options.provider}`,
  });

  expect(verdict.mode).toBe('shadow');
  expect(verdict.source).toBe('judge');
  expect(verdict.judgeId).toBe(judgeId);
  expect(verdict.latencyMs).toBeGreaterThan(0);

  // Answer shapes — noul/bool probability, choice key within criteria, score numeric.
  const answers = verdict.answers;
  expect(Object.keys(answers).sort()).toEqual(['q1_domain', 'q2_keep', 'q3_difficulty']);
  for (const answer of Object.values(answers)) {
    switch (answer.type) {
      case 'noul':
        expect(answer.probability).toBeGreaterThanOrEqual(0);
        expect(answer.probability).toBeLessThanOrEqual(1);
        break;
      case 'choice':
        expect(['code', 'web', 'other']).toContain(answer.choice);
        expect(typeof answer.confidence).toBe('number');
        break;
      case 'score':
        expect(typeof answer.score).toBe('number');
        expect(typeof answer.confidence).toBe('number');
        break;
    }
  }
}
