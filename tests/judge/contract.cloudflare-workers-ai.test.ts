/**
 * Real-judge contract test against Cloudflare Workers AI (typesafe/jev,
 * cloudflare-workers-ai-system-one). Network case SKIPS unless BOTH
 * CLOUDFLARE_API_KEY and CLOUDFLARE_ACCOUNT_ID are set — the key alone cannot
 * build the endpoint URL, so account-id presence is part of the env contract.
 * The account-id env handling itself is pinned WITHOUT network below.
 */

import { isNonEmptyEnv, runGoldenContract } from './contract-helpers.js';
import { JudgeResolver } from '../../src/judge/judge-resolver.js';
import { vi } from 'vitest';
import type { JudgeSectionConfig } from '../../src/judge/types.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as import('pino').Logger;

const hasFullEnv = isNonEmptyEnv('CLOUDFLARE_API_KEY') && isNonEmptyEnv('CLOUDFLARE_ACCOUNT_ID');

function config(): JudgeSectionConfig {
  return {
    enabled: true,
    provider: 'cloudflare-workers-ai',
    modelRef: 'typesafe/jev',
    modes: { default: 'shadow' },
    features: { testLogFold: 'off', admission: { chunkSizeChars: 2000, keepThreshold: 0.75 } },
    timeoutMs: 20000,
    recordState: false,
  };
}

describe('contract: cloudflare-workers-ai env handling (no network)', () => {
  it('key + account id resolve the chain; key alone is dropped with noKeyRefs', () => {
    const full = new JudgeResolver({
      config: config(),
      logger,
      env: { CLOUDFLARE_API_KEY: 'k', CLOUDFLARE_ACCOUNT_ID: 'acct' },
    });
    expect(full.resolveChain('test').tiers.map((t) => t.judgeId)).toEqual([
      'cloudflare-workers-ai/typesafe/jev',
    ]);
    const keyOnly = new JudgeResolver({
      config: config(),
      logger,
      env: { CLOUDFLARE_API_KEY: 'k' },
    });
    const chain = keyOnly.resolveChain('test');
    expect(chain.tiers).toHaveLength(0);
    expect(chain.noKeyRefs).toEqual(['cloudflare-workers-ai/typesafe/jev']);
  });
});

describe.skipIf(!hasFullEnv)('contract: real cloudflare-workers-ai/typesafe/jev', () => {
  it('resolves the real engine chain and answers all three golden shapes', async () => {
    await runGoldenContract({
      provider: 'cloudflare-workers-ai',
      modelRef: 'typesafe/jev',
      env: {
        CLOUDFLARE_API_KEY: process.env.CLOUDFLARE_API_KEY,
        CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
      },
    });
  }, 30_000);
});
