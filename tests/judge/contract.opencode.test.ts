/**
 * Real-judge contract test against OpenCode Zen's jev-1.13 (typesafe-system-one).
 * SKIPS unless OPENCODE_API_KEY is set — no key, no network (AGENTS.md test
 * discipline). Asserts answer SHAPES only (bounded answers, no semantics).
 */

import { createLogger } from '../../src/app/logger.js';
import { JudgeEngine } from '../../src/judge/engine.js';
import { JudgeLedger } from '../../src/judge/ledger.js';
import { JudgeResolver, parseJudgeRef } from '../../src/judge/judge-resolver.js';
import { goldenSampleSpec, GOLDEN_SAMPLE_STATE } from '../../src/judge/golden-sample.js';
import type { JudgeSectionConfig } from '../../src/judge/types.js';

const hasKey =
  typeof process.env.OPENCODE_API_KEY === 'string' && process.env.OPENCODE_API_KEY.length > 0;
const d = it.skipIf(!hasKey);

describe.skipIf(!hasKey)('contract: real opencode/jev-1.13', () => {
  d(
    'resolves the real engine chain and answers all three golden shapes',
    async () => {
      const logger = createLogger();
      const config: JudgeSectionConfig = {
        enabled: true,
        provider: 'opencode',
        modelRef: 'jev-1.13',
        modes: { default: 'shadow' },
        features: { testLogFold: 'off', admission: { chunkSizeChars: 2000, keepThreshold: 0.75 } },
        timeoutMs: 8000,
        recordState: false,
      };
      const resolver = new JudgeResolver({ config, logger });
      // Sanity: the ref parses and the chain needs no key swap (key comes from env).
      expect(parseJudgeRef('opencode/jev-1.13')).toEqual({
        provider: 'opencode',
        modelId: 'jev-1.13',
      });

      const engine = new JudgeEngine({
        config,
        resolver: (pointId) => resolver.resolveChain(pointId),
        ledger: new JudgeLedger({ dir: 'data/judge-ledger-contract-test', logger }),
        logger,
      });

      // Shadow mode: behavior-neutral, but the judged answers land in the verdict.
      const verdict = await engine.decide(goldenSampleSpec(), {
        state: GOLDEN_SAMPLE_STATE,
        sessionId: 'contract-opencode',
      });

      expect(verdict.mode).toBe('shadow');
      expect(verdict.source).toBe('judge');
      expect(verdict.judgeId).toBe('opencode/jev-1.13');
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
    },
    30_000,
  );
});
