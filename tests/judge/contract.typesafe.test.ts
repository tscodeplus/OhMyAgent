/**
 * Real-judge contract test against TypeSafe direct (jev-latest,
 * typesafe-system-one). SKIPS unless TYPESAFE_API_KEY is set — no key, no
 * network (AGENTS.md test discipline). Asserts answer SHAPES only (bounded
 * answers, no semantics).
 */

import { isNonEmptyEnv, runGoldenContract } from './contract-helpers.js';

const hasKey = isNonEmptyEnv('TYPESAFE_API_KEY');

describe.skipIf(!hasKey)('contract: real typesafe/jev-latest', () => {
  it('resolves the real engine chain and answers all three golden shapes', async () => {
    await runGoldenContract({
      provider: 'typesafe',
      modelRef: 'jev-latest',
      env: { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY },
    });
  }, 30_000);
});
