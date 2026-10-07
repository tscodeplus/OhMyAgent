/**
 * OpenRouter hidden Jev slug contract test (`~typesafe/jev-latest`).
 *
 * Network case SKIPS unless OPENROUTER_API_KEY is set — no key, no network.
 * The resolution contract is pinned WITHOUT network below: the slug parses,
 * resolves to a classifier tier through the compat registry (the resolver's
 * registerModel fallback covers catalog versions without the entry), and its
 * judgeId keeps the tilde slug intact.
 */

import { describe, expect, it, vi } from 'vitest';
import { JudgeResolver, parseJudgeRef } from '../../src/judge/judge-resolver.js';
import { isNonEmptyEnv, runGoldenContract } from './contract-helpers.js';
import type { JudgeSectionConfig } from '../../src/judge/types.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as import('pino').Logger;

const hasKey = isNonEmptyEnv('OPENROUTER_API_KEY');

function config(): JudgeSectionConfig {
  return {
    enabled: true,
    provider: 'openrouter',
    modelRef: '~typesafe/jev-latest',
    modes: { default: 'shadow' },
    features: { testLogFold: 'off', admission: { chunkSizeChars: 2000, keepThreshold: 0.75 } },
    timeoutMs: 20000,
    recordState: false,
  };
}

describe('contract: openrouter hidden slug ~typesafe/jev-latest (no network)', () => {
  it('the tilde slug parses and resolves to a classifier tier', () => {
    expect(parseJudgeRef('openrouter/~typesafe/jev-latest')).toEqual({
      provider: 'openrouter',
      modelId: '~typesafe/jev-latest',
    });
    const resolver = new JudgeResolver({
      config: config(),
      logger,
      env: { OPENROUTER_API_KEY: 'k' },
    });
    const chain = resolver.resolveChain('test');
    expect(chain.tiers.map((t) => t.judgeId)).toEqual(['openrouter/~typesafe/jev-latest']);
    expect(chain.noKeyRefs).toEqual([]);
  });
});

describe.skipIf(!hasKey)('contract: real openrouter/~typesafe/jev-latest', () => {
  it('resolves the real engine chain and answers all three golden shapes', async () => {
    await runGoldenContract({
      provider: 'openrouter',
      modelRef: '~typesafe/jev-latest',
      env: { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY },
    });
  }, 30_000);
});
