/**
 * Deterministic mock judge (MyDocs/JEV_JUDGE_KERNEL_IMPLEMENTATION.md §6):
 * a fixed probability table keyed by question id, injected as a
 * `JudgeModelResolver` stub — zero network, zero keys.
 *
 * Tier answers are emitted in the real pi-mono ClassifierAnswer wire shapes
 * (bool/choice/score) so the engine's real fail-closed validation path runs.
 */

import type {
  ClassifierAnswer,
  ClassifierContext,
  ClassifierResult,
} from '../../src/pi-mono/ai/types.js';
import type { JudgeModelResolver, JudgeTier, ResolvedJudgeChain } from '../../src/judge/types.js';

/** Mock answer spec (OhMyAgent-side shape). */
export type MockAnswer =
  | { type: 'noul'; probability: number }
  | { type: 'choice'; choice: string; probabilities?: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; confidence: number };

export interface MockTierSpec {
  judgeId: string;
  /** Fixed answer table keyed by question id (deterministic). */
  answers?: Record<string, MockAnswer | 'junk'>;
  /** Deterministic request-level failure (counts for the circuit breaker). */
  failWith?: { stopReason: 'error' | 'aborted'; errorMessage: string };
  /** Record of every classify() call, for assertions on the wire context. */
  calls?: Array<{ context: ClassifierContext; opts: { signal?: AbortSignal; timeoutMs?: number } }>;
  /** Never resolves until the signal aborts — exercises the engine timeout. */
  hangUntilAbort?: boolean;
}

function mockToClassifierAnswer(spec: MockAnswer): ClassifierAnswer {
  switch (spec.type) {
    case 'noul':
      return { type: 'bool', probability: spec.probability };
    case 'choice':
      return {
        type: 'choice',
        choice: spec.choice,
        probabilities: spec.probabilities ?? { [spec.choice]: spec.confidence },
        confidence: spec.confidence,
      };
    case 'score':
      return { type: 'score', score: spec.score, confidence: spec.confidence };
  }
}

export function createMockTier(spec: MockTierSpec): JudgeTier {
  const calls = spec.calls;
  return {
    judgeId: spec.judgeId,
    async classify(context, opts) {
      calls?.push({ context, opts: { signal: opts?.signal, timeoutMs: opts?.timeoutMs } });
      if (spec.hangUntilAbort) {
        return await new Promise<ClassifierResult>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('Aborted by caller')), {
            once: true,
          });
        });
      }
      if (spec.failWith) {
        return {
          api: 'typesafe-system-one',
          provider: 'mock',
          model: spec.judgeId,
          answers: {},
          stopReason: spec.failWith.stopReason,
          errorMessage: spec.failWith.errorMessage,
          timestamp: Date.now(),
        };
      }
      const answers: Record<string, ClassifierAnswer> = {};
      for (const [id, question] of Object.entries(context.questions)) {
        const tabled = spec.answers?.[id];
        if (!tabled) continue; // missing answer → parse-rejected path
        if (tabled === 'junk') continue;
        answers[id] = mockToClassifierAnswer(tabled);
      }
      return {
        api: 'typesafe-system-one',
        provider: 'mock',
        model: spec.judgeId,
        answers,
        stopReason: 'stop',
        timestamp: Date.now(),
      };
    },
  };
}

export function createMockResolver(...tierSpecs: MockTierSpec[]): JudgeModelResolver {
  const tiers = tierSpecs.map(createMockTier);
  return (_pointId: string): ResolvedJudgeChain => ({
    tiers,
    noKeyRefs: [],
    unresolvableRefs: [],
  });
}

/** Minimal valid JudgeSectionConfig for engine tests. */
export function mockJudgeConfig(
  overrides: Partial<import('../../src/judge/types.js').JudgeSectionConfig> = {},
): import('../../src/judge/types.js').JudgeSectionConfig {
  return {
    enabled: true,
    provider: 'mock',
    modelRef: 'mock-1',
    modes: { default: 'active' },
    features: { testLogFold: 'off', admission: { chunkSizeChars: 2000, keepThreshold: 0.75 } },
    timeoutMs: 4000,
    recordState: false,
    ...overrides,
  };
}
