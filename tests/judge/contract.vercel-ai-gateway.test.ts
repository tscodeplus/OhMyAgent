/**
 * Real-judge contract test against Vercel AI Gateway (typesafe-ai/jev,
 * typesafe-system-one). SKIPS unless AI_GATEWAY_API_KEY is set — no key, no
 * network (AGENTS.md test discipline). Asserts answer SHAPES only.
 */

import { isNonEmptyEnv, runGoldenContract } from './contract-helpers.js';

const hasKey = isNonEmptyEnv('AI_GATEWAY_API_KEY');

describe.skipIf(!hasKey)('contract: real vercel-ai-gateway/typesafe-ai/jev', () => {
  it('resolves the real engine chain and answers all three golden shapes', async () => {
    await runGoldenContract({
      provider: 'vercel-ai-gateway',
      modelRef: 'typesafe-ai/jev',
      env: { AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY },
    });
  }, 30_000);
});
