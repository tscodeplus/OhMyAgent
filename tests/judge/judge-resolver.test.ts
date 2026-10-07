/**
 * Resolver tests: ref parsing (canonical / shorthand / jev-free / llm:
 * placeholder), routes override of the whole chain, no-key drop + once-per-
 * startup warn, and the OpenRouter hidden slug fallback.
 * All chains run with a scoped env map — the resolver treats an explicit
 * `opts.env` as the ONLY env source, so tests are host-env independent.
 */

import { describe, expect, it, vi } from 'vitest';
import { JudgeResolver, judgeIdOf, parseJudgeRef } from '../../src/judge/judge-resolver.js';
import { JudgeError, type JudgeSectionConfig } from '../../src/judge/types.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as import('pino').Logger;

function baseConfig(overrides: Partial<JudgeSectionConfig> = {}): JudgeSectionConfig {
  return {
    enabled: true,
    provider: 'opencode',
    modelRef: 'jev-1.13',
    modes: { default: 'shadow' },
    features: { testLogFold: 'off', admission: { chunkSizeChars: 2000, keepThreshold: 0.75 } },
    timeoutMs: 4000,
    recordState: false,
    ...overrides,
  };
}

describe('parseJudgeRef — ref syntax', () => {
  it('canonical classifier: form', () => {
    expect(parseJudgeRef('classifier:opencode/jev-1.13')).toEqual({
      provider: 'opencode',
      modelId: 'jev-1.13',
    });
  });

  it('shorthand <provider>/<model>', () => {
    expect(parseJudgeRef('opencode/jev-1.13')).toEqual({
      provider: 'opencode',
      modelId: 'jev-1.13',
    });
    // Model ids themselves may contain slashes (e.g. OpenRouter slugs).
    expect(parseJudgeRef('openrouter/~typesafe/jev-latest')).toEqual({
      provider: 'openrouter',
      modelId: '~typesafe/jev-latest',
    });
  });

  it('jev-free alias expands to opencode/jev-1.13-free', () => {
    expect(parseJudgeRef('jev-free')).toEqual({
      provider: 'opencode',
      modelId: 'jev-1.13-free',
    });
    expect(judgeIdOf(parseJudgeRef('jev-free'))).toBe('opencode/jev-1.13-free');
  });

  it('llm: refs are the phase-3 placeholder and MUST throw JudgeError(unsupported)', () => {
    const err = capture(() => parseJudgeRef('llm:openai/gpt-5'));
    expect(err).toBeInstanceOf(JudgeError);
    expect((err as JudgeError).code).toBe('unsupported');
  });

  it('malformed refs throw', () => {
    expect(capture(() => parseJudgeRef('opencode'))).toBeInstanceOf(JudgeError);
    expect(capture(() => parseJudgeRef('/junk'))).toBeInstanceOf(JudgeError);
    expect(capture(() => parseJudgeRef('opencode/'))).toBeInstanceOf(JudgeError);
    expect(capture(() => parseJudgeRef('  '))).toBeInstanceOf(JudgeError);
  });
});

describe('JudgeResolver — chain resolution', () => {
  it('main chain = [provider/modelRef, ...fallbackTiers] with explicit key env', () => {
    const resolver = new JudgeResolver({
      config: baseConfig({ fallbackTiers: ['opencode/jev-1.13-free'] }),
      logger,
      env: { OPENCODE_API_KEY: 'k' },
    });
    const chain = resolver.resolveChain('tool.admission');
    expect(chain.tiers.map((t) => t.judgeId)).toEqual([
      'opencode/jev-1.13',
      'opencode/jev-1.13-free',
    ]);
    expect(chain.noKeyRefs).toEqual([]);
  });

  it('routes[pointId] replaces the WHOLE chain', () => {
    const resolver = new JudgeResolver({
      config: baseConfig({
        provider: 'opencode',
        modelRef: 'jev-1.13',
        fallbackTiers: ['opencode/jev-1.13-free'],
        routes: { 'tool.risk': ['typesafe/jev-latest'] },
      }),
      logger,
      env: { OPENCODE_API_KEY: 'k', TYPESAFE_API_KEY: 't' },
    });
    expect(resolver.resolveChain('tool.risk').tiers.map((t) => t.judgeId)).toEqual([
      'typesafe/jev-latest',
    ]);
    // Untouched points still use the main chain.
    expect(resolver.resolveChain('tool.admission').tiers.map((t) => t.judgeId)).toEqual([
      'opencode/jev-1.13',
      'opencode/jev-1.13-free',
    ]);
  });

  it('key falls back to provider_keys config before env', () => {
    const resolver = new JudgeResolver({
      config: baseConfig(),
      logger,
      providerKeys: { opencode: { apiKey: 'config-key' } },
      env: {}, // scoped empty env — config provider_keys must still win
    });
    expect(resolver.resolveChain('tool.admission').tiers).toHaveLength(1);
  });

  it('no key on a chain member: ref dropped, reported ONCE across calls, not silently skipped', () => {
    const resolver = new JudgeResolver({
      config: baseConfig(),
      logger,
      env: {}, // no OPENCODE_API_KEY anywhere
    });
    const first = resolver.resolveChain('tool.admission');
    expect(first.tiers).toHaveLength(0);
    expect(first.noKeyRefs).toContain('opencode/jev-1.13');

    resolver.resolveChain('tool.admission');
    resolver.resolveChain('memory.worth');
    // Startup warn at most once per ref.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn).mock.calls[0][0]).toMatchObject({
      ref: 'opencode/jev-1.13',
    });
  });

  it('jev-free needs no key even with an empty env', () => {
    const resolver = new JudgeResolver({
      config: baseConfig({ provider: 'opencode', modelRef: 'jev-1.13-free' }),
      logger,
      env: {},
    });
    const chain = resolver.resolveChain('tool.admission');
    expect(chain.tiers.map((t) => t.judgeId)).toEqual(['opencode/jev-1.13-free']);
    expect(chain.noKeyRefs).toEqual([]);
  });

  it('jev-free prefers the configured provider key (placeholder Bearer is rejected with 401 upstream)', () => {
    // The tier must still resolve when ONLY a provider_keys entry exists (no env):
    // resolveApiKey() is consulted for keyless tiers too, and the key is what
    // OpenCode's endpoint actually requires (verified 200 with key / 401 without).
    const resolver = new JudgeResolver({
      config: baseConfig({ provider: 'opencode', modelRef: 'jev-1.13-free' }),
      logger,
      env: {},
      providerKeys: { opencode: { apiKey: 'real-key' } },
    });
    const chain = resolver.resolveChain('tool.admission');
    expect(chain.tiers.map((t) => t.judgeId)).toEqual(['opencode/jev-1.13-free']);
    expect(chain.noKeyRefs).toEqual([]);
  });

  it('cloudflare requires BOTH the key and an account id (config OR env on either side)', () => {
    const withKeyOnly = new JudgeResolver({
      config: baseConfig({ provider: 'cloudflare-workers-ai', modelRef: 'typesafe/jev' }),
      logger: { ...logger },
      env: { CLOUDFLARE_API_KEY: 'k', CLOUDFLARE_ACCOUNT_ID: 'acct' },
    });
    expect(withKeyOnly.resolveChain('p').tiers).toHaveLength(1);

    const missingAccount = new JudgeResolver({
      config: baseConfig({ provider: 'cloudflare-workers-ai', modelRef: 'typesafe/jev' }),
      logger: { ...logger },
      env: { CLOUDFLARE_API_KEY: 'k' },
    });
    expect(missingAccount.resolveChain('p').noKeyRefs).toHaveLength(1);
  });

  it('cloudflare resolves from provider_keys ALONE ({ apiKey, accountId }, env empty)', () => {
    const resolver = new JudgeResolver({
      config: baseConfig({ provider: 'cloudflare-workers-ai', modelRef: 'typesafe/jev' }),
      logger: { ...logger },
      providerKeys: { 'cloudflare-workers-ai': { apiKey: 'k', accountId: 'acct' } },
      env: {},
    });
    const chain = resolver.resolveChain('p');
    expect(chain.tiers.map((t) => t.judgeId)).toEqual(['cloudflare-workers-ai/typesafe/jev']);
    expect(chain.noKeyRefs).toEqual([]);
  });

  it('cloudflare provider_keys apiKey WITHOUT accountId still drops (no-key)', () => {
    const resolver = new JudgeResolver({
      config: baseConfig({ provider: 'cloudflare-workers-ai', modelRef: 'typesafe/jev' }),
      logger: { ...logger },
      providerKeys: { 'cloudflare-workers-ai': { apiKey: 'k' } },
      env: {},
    });
    const chain = resolver.resolveChain('p');
    expect(chain.tiers).toHaveLength(0);
    expect(chain.noKeyRefs).toEqual(['cloudflare-workers-ai/typesafe/jev']);
  });

  it('openrouter hidden slug ~typesafe/jev-latest resolves (registered when catalog lacks it)', () => {
    const resolver = new JudgeResolver({
      config: baseConfig({ provider: 'openrouter', modelRef: '~typesafe/jev-latest' }),
      logger,
      env: { OPENROUTER_API_KEY: 'k' },
    });
    const chain = resolver.resolveChain('tool.admission');
    expect(chain.tiers.map((t) => t.judgeId)).toEqual(['openrouter/~typesafe/jev-latest']);
  });

  it('unknown model / unsupported ref land in unresolvableRefs without throwing', () => {
    const resolver = new JudgeResolver({
      config: baseConfig({ provider: 'opencode', modelRef: 'does-not-exist' }),
      logger,
      env: { OPENCODE_API_KEY: 'k' },
    });
    const chain = resolver.resolveChain('tool.admission');
    expect(chain.tiers).toHaveLength(0);
    expect(chain.unresolvableRefs).toEqual(['opencode/does-not-exist']);
  });

  it('llm: chain member is reported unresolvable (phase-3), chain continues with the rest', () => {
    const resolver = new JudgeResolver({
      config: baseConfig({ modelRef: 'jev-1.13', fallbackTiers: ['llm:x/y'] }),
      logger,
      env: { OPENCODE_API_KEY: 'k' },
    });
    const chain = resolver.resolveChain('tool.admission');
    expect(chain.tiers.map((t) => t.judgeId)).toEqual(['opencode/jev-1.13']);
    expect(chain.unresolvableRefs).toEqual(['llm:x/y']);
  });

  it('no provider/modelRef configured but routes exist for the point: chain comes from routes', () => {
    const resolver = new JudgeResolver({
      config: baseConfig({
        provider: undefined,
        modelRef: undefined,
        routes: { 'p.x': ['opencode/jev-1.13'] },
      }),
      logger,
      env: { OPENCODE_API_KEY: 'k' },
    });
    expect(resolver.resolveChain('p.x').tiers).toHaveLength(1);
    expect(resolver.resolveChain('p.y').tiers).toHaveLength(0);
  });
});

describe('JudgeResolver — judges.<name> refs (custom relay judges as chain peers)', () => {
  function withJudges(overrides: Partial<JudgeSectionConfig> = {}): JudgeSectionConfig {
    return baseConfig({
      judges: {
        relay: { type: 'typesafe', baseUrl: 'https://relay.example/v1', apiKeyEnv: 'RELAY_KEY' },
      },
      ...overrides,
    });
  }

  it('explicit judges.<name> as the only chain ref: no auto-prepend duplicate', () => {
    const resolver = new JudgeResolver({
      config: withJudges({
        provider: undefined,
        modelRef: undefined,
        routes: { 'p.x': ['judges.relay'] },
      }),
      logger,
      env: { RELAY_KEY: 'k' },
    });
    const chain = resolver.resolveChain('p.x');
    expect(chain.tiers.map((t) => t.judgeId)).toEqual(['relay']);
    expect(chain.noKeyRefs).toEqual([]);
    expect(chain.unresolvableRefs).toEqual([]);
  });

  it('explicit ref inside fallbackTiers at position 2: chain order [builtin, judges]', () => {
    const resolver = new JudgeResolver({
      config: withJudges({
        provider: 'opencode',
        modelRef: 'jev-1.13-free',
        fallbackTiers: ['judges.relay'],
      }),
      logger,
      env: { RELAY_KEY: 'k' },
    });
    expect(resolver.resolveChain('tool.admission').tiers.map((t) => t.judgeId)).toEqual([
      'opencode/jev-1.13-free',
      'relay',
    ]);
  });

  it('unreferenced entries keep the auto-prepend semantics', () => {
    const resolver = new JudgeResolver({
      config: baseConfig({
        judges: {
          placed: { type: 'typesafe', baseUrl: 'https://relay.example/v1', apiKeyEnv: 'RELAY_KEY' },
          loose: { type: 'typesafe', baseUrl: 'https://relay.example/v2', apiKeyEnv: 'RELAY_KEY' },
        },
        provider: 'opencode',
        modelRef: 'jev-1.13-free',
        fallbackTiers: ['judges.placed'],
      }),
      logger,
      env: { RELAY_KEY: 'k' },
    });
    // Only `placed` is referenced → `loose` auto-prepends above the builtin chain;
    // `placed` stays exactly where fallbackTiers puts it.
    expect(resolver.resolveChain('tool.admission').tiers.map((t) => t.judgeId)).toEqual([
      'loose',
      'opencode/jev-1.13-free',
      'placed',
    ]);
  });

  it("an entry referenced in one point's routes is NOT auto-prepended for another point", () => {
    const resolver = new JudgeResolver({
      config: withJudges({
        provider: 'opencode',
        modelRef: 'jev-1.13-free',
        routes: { 'tool.risk': ['judges.relay'] },
      }),
      logger,
      env: { RELAY_KEY: 'k' },
    });
    expect(resolver.resolveChain('tool.risk').tiers.map((t) => t.judgeId)).toEqual(['relay']);
    // Other points do not see the entry at all (explicit placement is global).
    expect(resolver.resolveChain('tool.admission').tiers.map((t) => t.judgeId)).toEqual([
      'opencode/jev-1.13-free',
    ]);
  });

  it('explicit ref to an unknown judges name → unresolvableRefs, other tiers still resolve', () => {
    const resolver = new JudgeResolver({
      config: withJudges({
        provider: 'opencode',
        modelRef: 'jev-1.13-free',
        fallbackTiers: ['judges.ghost'],
      }),
      logger,
      env: { RELAY_KEY: 'k' },
    });
    const chain = resolver.resolveChain('tool.admission');
    // `ghost` does not exist → unresolvable; the untouched `relay` entry is not
    // referenced anywhere, so it keeps its auto-prepend slot.
    expect(chain.tiers.map((t) => t.judgeId)).toEqual(['relay', 'opencode/jev-1.13-free']);
    expect(chain.unresolvableRefs).toEqual(['judges.ghost']);
  });

  it('explicit ref with a missing apiKeyEnv value → judges.<name> noKeyRef, no auto-prepend', () => {
    const resolver = new JudgeResolver({
      config: withJudges({
        provider: 'opencode',
        modelRef: 'jev-1.13-free',
        fallbackTiers: ['judges.relay'],
      }),
      logger,
      env: {},
    });
    const chain = resolver.resolveChain('tool.admission');
    expect(chain.tiers.map((t) => t.judgeId)).toEqual(['opencode/jev-1.13-free']);
    expect(chain.noKeyRefs).toEqual(['judges.relay']);
  });
});

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}
