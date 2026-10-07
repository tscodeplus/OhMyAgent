/**
 * Local llama.cpp judge contract test — pins CURRENT fail-closed behavior only.
 *
 * There is NO working resolution path for llama-cpp classifier models yet:
 * pi-mono v1.0.x ships the `llama-cpp-classify` API but no `llama-cpp`
 * provider/catalog entry, and `customProviders` currently contribute only API
 * keys to the judge resolver (classifying through them fails "Unknown
 * provider" — that wiring is bootstrap-owned, outside M5 scope). A
 * `llama-cpp/<model>` ref therefore lands in `unresolvableRefs` and the engine
 * falls back per its fail-closed rules. This test pins exactly that so the
 * behavior cannot drift silently; flip it when a resolution path exists.
 * No network, no skip gating.
 */

import { describe, expect, it, vi } from 'vitest';
import { JudgeResolver } from '../../src/judge/judge-resolver.js';
import type { JudgeSectionConfig } from '../../src/judge/types.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as import('pino').Logger;

function config(): JudgeSectionConfig {
  return {
    enabled: true,
    provider: 'llama-cpp',
    modelRef: 'jev-local',
    modes: { default: 'shadow' },
    features: { testLogFold: 'off', admission: { chunkSizeChars: 2000, keepThreshold: 0.75 } },
    timeoutMs: 4000,
    recordState: false,
  };
}

describe('contract: local llama.cpp (fail-closed drop, no resolution path yet)', () => {
  it('a llama-cpp ref is unresolvable today: no tier, reported, never thrown', () => {
    const resolver = new JudgeResolver({
      config: config(),
      logger,
      env: {}, // llama-cpp is keyless anyway — the model entry is what's missing
    });
    const chain = resolver.resolveChain('test');
    expect(chain.tiers).toHaveLength(0);
    expect(chain.noKeyRefs).toEqual([]);
    expect(chain.unresolvableRefs).toEqual(['llama-cpp/jev-local']);
    expect(vi.mocked(logger.warn).mock.calls.length).toBeGreaterThan(0);
  });
});
