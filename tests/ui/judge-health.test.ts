import { describe, it, expect } from 'vitest';
import {
  deriveJudgeHealth,
  type JudgeConfigResponse,
} from '../../ui/src/components/settings/judgeHealth';

/**
 * The judge dot in the Models & Routing health bar has four states (off / ok /
 * warn / error) and each one is a claim about a config the user can get wrong
 * in a different way: layer switched off, key only in the environment,
 * cloudflare's extra account id, a provider added with no model, a custom relay
 * judge, hand-written refs the `keyStatus` map knows nothing about. These cases
 * encode that state table.
 */
function payload(
  config: JudgeConfigResponse['config'],
  keyStatus?: JudgeConfigResponse['keyStatus'],
): JudgeConfigResponse {
  return { config, keyStatus };
}

const TYPESAFE = 'typesafe/jev-latest';

describe('deriveJudgeHealth', () => {
  it('treats a missing payload / missing judge section as off, not error', () => {
    // A server without the judge routes returns nothing usable here, and an
    // inert kernel is a legitimate configuration.
    expect(deriveJudgeHealth(null).tone).toBe('off');
    expect(deriveJudgeHealth(undefined).tone).toBe('off');
    expect(deriveJudgeHealth({}).tone).toBe('off');
    expect(deriveJudgeHealth(payload({}, { typesafe: { present: true } })).tone).toBe('off');
  });

  it('treats enabled: false as off even with keys present', () => {
    const health = deriveJudgeHealth(
      payload(
        { enabled: false, provider: 'typesafe', modelRef: 'jev-latest' },
        { typesafe: { present: true } },
      ),
    );
    expect(health).toEqual({ tone: 'off', usable: 0, total: 0 });
  });

  it('is ok when every chain entry has a usable key', () => {
    const health = deriveJudgeHealth(
      payload(
        {
          enabled: true,
          provider: 'typesafe',
          modelRef: 'jev-latest',
          fallbackTiers: ['openrouter/~typesafe/jev-latest'],
        },
        { typesafe: { present: true }, openrouter: { present: true } },
      ),
    );
    expect(health).toEqual({ tone: 'ok', usable: 2, total: 2 });
  });

  it('is ok for a single-key chain', () => {
    expect(
      deriveJudgeHealth(
        payload(
          { enabled: true, provider: 'typesafe', modelRef: 'jev-latest' },
          {
            typesafe: { present: true },
          },
        ),
      ),
    ).toEqual({ tone: 'ok', usable: 1, total: 1 });
  });

  it('is warn when only part of the chain is usable', () => {
    const health = deriveJudgeHealth(
      payload(
        {
          enabled: true,
          provider: 'typesafe',
          modelRef: 'jev-latest',
          fallbackTiers: ['openrouter/x'],
        },
        { typesafe: { present: true }, openrouter: { present: false } },
      ),
    );
    expect(health).toEqual({ tone: 'warn', usable: 1, total: 2 });
  });

  it('is error when no chain entry is usable (key never configured)', () => {
    const health = deriveJudgeHealth(
      payload(
        { enabled: true, chain: [TYPESAFE, 'openrouter/x'] },
        {
          typesafe: { present: false },
        },
      ),
    );
    expect(health).toEqual({ tone: 'error', usable: 0, total: 2 });
  });

  it('is error when enabled with no resolvable primary at all', () => {
    // provider set but no modelRef resolves to no ref (see refsForPoint), so
    // the chain is empty — nothing can judge.
    expect(deriveJudgeHealth(payload({ enabled: true, provider: 'typesafe' }, {})).tone).toBe(
      'error',
    );
    expect(deriveJudgeHealth(payload({ enabled: true }, {})).tone).toBe('error');
  });

  it('prefers the WebUI-written chain over the legacy main + fallbackTiers', () => {
    const health = deriveJudgeHealth(
      payload(
        {
          enabled: true,
          provider: 'typesafe',
          modelRef: 'jev-latest',
          fallbackTiers: ['openrouter/legacy'],
          chain: ['opencode/jev-1.13-free'],
        },
        { typesafe: { present: true }, opencode: { present: true } },
      ),
    );
    // The legacy refs are ignored once a chain exists.
    expect(health).toEqual({ tone: 'ok', usable: 1, total: 1 });
  });

  it('drops model-less builtin group markers, like the resolver does', () => {
    const health = deriveJudgeHealth(
      payload(
        { enabled: true, chain: [TYPESAFE, 'openrouter'] },
        {
          typesafe: { present: true },
          openrouter: { present: true },
        },
      ),
    );
    expect(health).toEqual({ tone: 'ok', usable: 1, total: 1 });

    // Only a model-less group left → nothing can judge.
    expect(deriveJudgeHealth(payload({ enabled: true, chain: ['openrouter'] }, {})).tone).toBe(
      'error',
    );
  });

  it('counts an env-supplied key as present (server-resolved keyStatus)', () => {
    // keyStatus.present is true for provider_keys *and* env vars; deriving this
    // client-side from providerKeys would wrongly go red.
    const health = deriveJudgeHealth(
      payload(
        { enabled: true, chain: ['openrouter/x'] },
        {
          openrouter: { present: true, envVars: ['OPENROUTER_API_KEY'] },
        },
      ),
    );
    expect(health.tone).toBe('ok');
  });

  it('requires an account id for cloudflare-workers-ai', () => {
    expect(
      deriveJudgeHealth(
        payload(
          { enabled: true, provider: 'cloudflare-workers-ai', modelRef: 'x' },
          {
            'cloudflare-workers-ai': { present: true, accountId: { present: false } },
          },
        ),
      ).tone,
    ).toBe('error');

    expect(
      deriveJudgeHealth(
        payload(
          { enabled: true, provider: 'cloudflare-workers-ai', modelRef: 'x' },
          {
            'cloudflare-workers-ai': { present: true, accountId: { present: true } },
          },
        ),
      ).tone,
    ).toBe('ok');
  });

  it('treats the keyless local llama.cpp provider as usable without a key', () => {
    // JUDGE_PROVIDER_ENV_KEYS['llama-cpp'] is empty and keyStatus reports
    // present:false for it — the resolver still runs it.
    const health = deriveJudgeHealth(
      payload(
        { enabled: true, provider: 'llama-cpp', modelRef: 'reflex-latest' },
        {
          'llama-cpp': { present: false },
        },
      ),
    );
    expect(health.tone).toBe('ok');
  });

  it('does not report unverifiable refs as broken', () => {
    // Hand-written refs outside the builtin judge catalog have no keyStatus
    // entry; the ledger, not the dot, surfaces their real call failures.
    expect(
      deriveJudgeHealth(payload({ enabled: true, provider: 'my-relay', modelRef: 'model-a' }, {}))
        .tone,
    ).toBe('ok');
  });

  it('resolves custom relay judges from judge.judges', () => {
    const usable = deriveJudgeHealth(
      payload(
        {
          enabled: true,
          provider: 'judges',
          modelRef: 'primary',
          fallbackTiers: ['judges.second'],
          judges: {
            primary: { type: 'http', baseUrl: 'https://a', apiKey: 'sk-x' },
            second: { type: 'typesafe', apiKeyEnv: 'JUDGE_KEY' },
          },
        },
        {},
      ),
    );
    expect(usable).toEqual({ tone: 'ok', usable: 2, total: 2 });

    const unusable = deriveJudgeHealth(
      payload(
        {
          enabled: true,
          provider: 'judges',
          modelRef: 'relay',
          judges: { relay: { type: 'http', baseUrl: 'https://a' } },
        },
        {},
      ),
    );
    expect(unusable.tone).toBe('error');

    // A judges.<name> ref with no matching entry is unresolvable.
    expect(deriveJudgeHealth(payload({ enabled: true, chain: ['judges.ghost'] }, {})).tone).toBe(
      'error',
    );
  });

  it('unions per-point routes with the default chain', () => {
    // routes replace the chain for one point, so a config that only works
    // through routes must not be reported as broken.
    const routesOnly = deriveJudgeHealth(
      payload(
        { enabled: true, routes: { default: [TYPESAFE] } },
        {
          typesafe: { present: true },
        },
      ),
    );
    expect(routesOnly).toEqual({ tone: 'ok', usable: 1, total: 1 });

    // Deduped: the same ref in chain and routes counts once.
    const deduped = deriveJudgeHealth(
      payload(
        { enabled: true, chain: [TYPESAFE], routes: { admission: [TYPESAFE] } },
        {
          typesafe: { present: true },
        },
      ),
    );
    expect(deduped).toEqual({ tone: 'ok', usable: 1, total: 1 });
  });

  it('drops empty strings and non-strings from ref lists', () => {
    const health = deriveJudgeHealth(
      payload(
        {
          enabled: true,
          provider: 'typesafe',
          modelRef: 'jev-latest',
          fallbackTiers: ['', '  ', 42, null],
        },
        { typesafe: { present: true } },
      ),
    );
    expect(health).toEqual({ tone: 'ok', usable: 1, total: 1 });
  });

  it('accepts the older boolean keyStatus shape', () => {
    const health = deriveJudgeHealth(
      payload({ enabled: true, provider: 'typesafe', modelRef: 'jev-latest' }, { typesafe: true }),
    );
    expect(health.tone).toBe('ok');
  });
});
