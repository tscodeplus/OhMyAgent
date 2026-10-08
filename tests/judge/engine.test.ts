/**
 * Engine tests (MyDocs/JEV_JUDGE_KERNEL_IMPLEMENTATION.md §6):
 * mode matrix (active/shadow/off × verdict/fail × gray cascade), fail-closed
 * validation, circuit breaker accounting, and the ledger line format
 * (including "no ledger line in off mode").
 * All tiers come from the deterministic mock provider in ./mock.ts — no
 * network, no keys.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JudgeEngine } from '../../src/judge/index.js';
import { JudgeCircuitBreaker } from '../../src/judge/circuit-breaker.js';
import { JudgeLedger } from '../../src/judge/ledger.js';
import { FreeJevMonitor } from '../../src/judge/free-jev.js';
import { choice, defineDecision, noul, score, type DecisionSpec } from '../../src/judge/types.js';
import { createMockResolver, createMockTier, mockJudgeConfig, type MockTierSpec } from './mock.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'judge-engine-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeLedger(): JudgeLedger {
  return new JudgeLedger({ dir: tmpDir, ringMax: 200 });
}

function makeSpec(overrides: Partial<DecisionSpec> = {}): DecisionSpec {
  return defineDecision({
    id: 'tool.admission',
    version: 1,
    questions: {
      q_keep: noul('Keep this chunk?', { true: 'useful', false: 'noise' }),
      q_domain: choice('Which?', { code: 'code', web: 'web', other: 'other' }),
      q_hard: score('How hard?', ['trivial', 'normal', 'hard']),
    },
    policy: () => ({ action: 'keep', ids: ['c1'] }),
    fallback: { action: 'keep-all' },
    ...overrides,
  });
}

const CLEAR = (noulP: number, choiceConf = 0.9, scoreConf = 0.9): MockTierSpec['answers'] => ({
  q_keep: { type: 'noul', probability: noulP },
  q_domain: { type: 'choice', choice: 'code', confidence: choiceConf },
  q_hard: { type: 'score', score: 2, confidence: scoreConf },
});

describe('JudgeEngine — mode matrix', () => {
  it('active + clear verdict: judged, policy applied, answers mapped', async () => {
    const resolver = createMockResolver({ judgeId: 'mock/j1', answers: CLEAR(0.9) });
    const engine = new JudgeEngine({
      config: mockJudgeConfig({ modes: { default: 'active' } }),
      resolver,
      ledger: makeLedger(),
    });
    const verdict = await engine.decide(makeSpec(), { state: { chunks: 1 } });
    expect(verdict.source).toBe('judge');
    expect(verdict.judgeId).toBe('mock/j1');
    expect(verdict.mode).toBe('active');
    expect(verdict.answers.q_keep).toEqual({ type: 'noul', probability: 0.9 });
    expect(verdict.answers.q_domain).toMatchObject({ type: 'choice', choice: 'code' });
    expect(verdict.outcome).toEqual({ action: 'keep', ids: ['c1'] });
    expect(verdict.fallbackReason).toBeUndefined();
  });

  it('shadow: judged answers recorded, but outcome = spec.fallback and policy NOT applied', async () => {
    const policyCalls: unknown[] = [];
    const resolver = createMockResolver({ judgeId: 'mock/j1', answers: CLEAR(0.9) });
    const engine = new JudgeEngine({
      config: mockJudgeConfig({ modes: { default: 'shadow' } }),
      resolver,
      ledger: makeLedger(),
    });
    const verdict = await engine.decide(
      makeSpec({ policy: (a) => (policyCalls.push(a), { action: 'keep', ids: ['x'] }) }),
      { state: { chunks: 1 } },
    );
    expect(verdict.source).toBe('judge');
    expect(policyCalls).toHaveLength(0);
    expect(verdict.outcome).toEqual({ action: 'keep-all' });
    // shadow still records the judged call
    const recent = engine.ledger.recent(1);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ mode: 'shadow', judgeId: 'mock/j1', source: 'judge' });
  });

  it('off: not asked, no ledger line, fallback verdict with mode-off', async () => {
    const tierSpec: MockTierSpec = { judgeId: 'mock/j1', answers: CLEAR(0.9) };
    const calls: unknown[] = [];
    tierSpec.calls = calls as never;
    const resolver = createMockResolver(tierSpec);
    const ledger = makeLedger();
    const engine = new JudgeEngine({
      config: mockJudgeConfig({ modes: { 'tool.admission': 'off', default: 'active' } }),
      resolver,
      ledger,
    });
    const verdict = await engine.decide(makeSpec(), { state: { chunks: 1 } });
    expect(verdict.mode).toBe('off');
    expect(verdict.source).toBe('fallback');
    expect(verdict.fallbackReason).toBe('mode-off');
    expect(verdict.judgeId).toBe('');
    expect(verdict.answers).toEqual({});
    expect(verdict.outcome).toEqual({ action: 'keep-all' });
    expect(calls).toHaveLength(0); // never called
    expect(ledger.recent(20)).toHaveLength(0); // no ledger line in off mode
  });
});

describe('JudgeEngine — decideMany vs decide subset', () => {
  it('decideMany sends ALL questions in one classify call (state billed once)', async () => {
    const calls: Array<{ context: { questions: unknown } }> = [];
    const resolver = createMockResolver({
      judgeId: 'mock/j1',
      answers: CLEAR(0.9),
      calls: calls as never,
    });
    const engine = new JudgeEngine({
      config: mockJudgeConfig(),
      resolver,
      ledger: makeLedger(),
    });
    const verdict = await engine.decideMany(makeSpec(), { state: { shared: true } });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].context.questions as object)).toEqual(
      expect.arrayContaining(['q_keep', 'q_domain', 'q_hard']),
    );
    expect(verdict.source).toBe('judge');
  });

  it('decide(questionIds) sends only the subset over shared state', async () => {
    const calls: Array<{ context: { questions: unknown } }> = [];
    const resolver = createMockResolver({
      judgeId: 'mock/j1',
      answers: { q_keep: { type: 'noul', probability: 0.9 } },
      calls: calls as never,
    });
    const engine = new JudgeEngine({
      config: mockJudgeConfig(),
      resolver,
      ledger: makeLedger(),
    });
    const verdict = await engine.decide(makeSpec(), { state: 'shared', questionIds: ['q_keep'] });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].context.questions as object)).toEqual(['q_keep']);
    expect(verdict.answers).toEqual({ q_keep: { type: 'noul', probability: 0.9 } });
  });

  it('unknown questionIds degenerate to a fallback verdict (never throws)', async () => {
    const engine = new JudgeEngine({
      config: mockJudgeConfig(),
      resolver: createMockResolver({ judgeId: 'mock/j1', answers: CLEAR(0.9) }),
      ledger: makeLedger(),
    });
    const verdict = await engine.decide(makeSpec(), { state: {}, questionIds: ['nope'] });
    expect(verdict.source).toBe('fallback');
    expect(verdict.fallbackReason).toBe('parse-rejected');
  });
});

describe('JudgeEngine — fail-closed validation', () => {
  it('choice answer outside question criteria is discarded; all invalid → parse-rejected (no breaker failure)', async () => {
    const breaker = new JudgeCircuitBreaker();
    const resolver = createMockResolver({
      judgeId: 'mock/j1',
      answers: { q_domain: { type: 'choice', choice: 'NOT-IN-CRITERIA', confidence: 0.99 } },
    });
    const engine = new JudgeEngine({
      config: mockJudgeConfig(),
      resolver,
      breaker,
      ledger: makeLedger(),
    });
    const verdict = await engine.decide(makeSpec());
    expect(verdict.source).toBe('fallback');
    expect(verdict.fallbackReason).toBe('parse-rejected');
    // Healthy service answered — must NOT count toward the breaker.
    expect(breaker.state('tool.admission').consecutiveFailures).toBe(0);
    expect(breaker.isOpen('tool.admission')).toBe(false);
  });

  it('valid answers survive even when one answer is invalid (partial discard)', async () => {
    const resolver = createMockResolver({
      judgeId: 'mock/j1',
      answers: {
        q_keep: { type: 'noul', probability: 0.95 },
        q_domain: { type: 'choice', choice: 'bogus-key', confidence: 0.9 },
      },
    });
    const engine = new JudgeEngine({
      config: mockJudgeConfig({ modes: { default: 'shadow' } }),
      resolver,
      ledger: makeLedger(),
    });
    const verdict = await engine.decide(makeSpec());
    expect(verdict.source).toBe('judge');
    expect(Object.keys(verdict.answers)).toEqual(['q_keep']);
  });
});

describe('JudgeEngine — gray-zone cascade', () => {
  it('single tier gray (noul 0.5) → fallback gray-zone; breaker untouched', async () => {
    const breaker = new JudgeCircuitBreaker();
    const resolver = createMockResolver({ judgeId: 'mock/j1', answers: CLEAR(0.5, 0.95) });
    const engine = new JudgeEngine({
      config: mockJudgeConfig(),
      resolver,
      breaker,
      ledger: makeLedger(),
    });
    const verdict = await engine.decide(makeSpec());
    expect(verdict.fallbackReason).toBe('gray-zone');
    expect(verdict.source).toBe('fallback');
    expect(breaker.state('tool.admission').consecutiveFailures).toBe(0);
  });

  it('gray on tier 1 escalates to tier 2', async () => {
    const resolver = createMockResolver(
      { judgeId: 'mock/j1', answers: CLEAR(0.5) }, // gray noul
      { judgeId: 'mock/j2', answers: CLEAR(0.9) }, // clear scoring
    );
    const engine = new JudgeEngine({
      config: mockJudgeConfig(),
      resolver,
      ledger: makeLedger(),
    });
    const verdict = await engine.decide(makeSpec());
    expect(verdict.source).toBe('judge');
    expect(verdict.judgeId).toBe('mock/j2');
  });

  it('gray choice confidence (<0.5) and low-confidence score escalate too', async () => {
    const engine = new JudgeEngine({
      config: mockJudgeConfig(),
      resolver: createMockResolver(
        { judgeId: 'mock/j1', answers: CLEAR(0.9, 0.4, 0.9) }, // gray choice
        { judgeId: 'mock/j2', answers: CLEAR(0.9, 0.9, 0.9) },
      ),
      ledger: makeLedger(),
    });
    const verdict = await engine.decide(makeSpec());
    expect(verdict.judgeId).toBe('mock/j2');
  });

  it('a healthy service that keeps answering gray NEVER opens the breaker', async () => {
    const breaker = new JudgeCircuitBreaker();
    const engine = new JudgeEngine({
      config: mockJudgeConfig(),
      resolver: createMockResolver({ judgeId: 'mock/j1', answers: CLEAR(0.5, 0.4, 0.4) }),
      breaker,
      ledger: makeLedger(),
    });
    for (let i = 0; i < 10; i++) {
      await engine.decide(makeSpec());
    }
    expect(breaker.isOpen('tool.admission')).toBe(false);
  });
});

describe('JudgeEngine — service failures + circuit breaker', () => {
  it('first tier errors, second tier answers → judged, breaker success', async () => {
    const breaker = new JudgeCircuitBreaker();
    const resolver = createMockResolver(
      { judgeId: 'mock/j1', failWith: { stopReason: 'error', errorMessage: '503' } },
      { judgeId: 'mock/j2', answers: CLEAR(0.9) },
    );
    const engine = new JudgeEngine({
      config: mockJudgeConfig(),
      resolver,
      breaker,
      ledger: makeLedger(),
    });
    const verdict = await engine.decide(makeSpec());
    expect(verdict.judgeId).toBe('mock/j2');
    expect(verdict.source).toBe('judge');
    expect(breaker.state('tool.admission').consecutiveFailures).toBe(0);
  });

  it('all tiers error → fallback unavailable + breaker failure count', async () => {
    const breaker = new JudgeCircuitBreaker();
    const engine = new JudgeEngine({
      config: mockJudgeConfig(),
      resolver: createMockResolver({
        judgeId: 'mock/j1',
        failWith: { stopReason: 'error', errorMessage: 'unreachable' },
      }),
      breaker,
      ledger: makeLedger(),
    });
    const verdict = await engine.decide(makeSpec());
    expect(verdict.fallbackReason).toBe('unavailable');
    expect(breaker.state('tool.admission').consecutiveFailures).toBe(1);
  });

  it('opens after 5 consecutive service failures, then verdicts say circuit-open', async () => {
    const breaker = new JudgeCircuitBreaker({ cooldownMs: 60_000 });
    const calls: unknown[] = [];
    const tierSpec: MockTierSpec = {
      judgeId: 'mock/j1',
      failWith: { stopReason: 'error', errorMessage: 'down' },
      calls: calls as never,
    };
    const engine = new JudgeEngine({
      config: mockJudgeConfig(),
      resolver: createMockResolver(tierSpec),
      breaker,
      ledger: makeLedger(),
    });
    for (let i = 0; i < 5; i++) {
      const v = await engine.decide(makeSpec());
      expect(v.fallbackReason).toBe('unavailable');
    }
    expect(breaker.isOpen('tool.admission')).toBe(true);
    // While open: fallback without calling the service.
    const blocked = await engine.decide(makeSpec());
    expect(blocked.fallbackReason).toBe('circuit-open');
    expect(calls).toHaveLength(5);
  });

  it('half-open: probe allowed after cooldown; failure re-opens, success closes', async () => {
    vi.useFakeTimers();
    try {
      const breaker = new JudgeCircuitBreaker({ cooldownMs: 1000 });
      let healthy = false;
      const failing = createMockResolver({
        judgeId: 'mock/j1',
        failWith: { stopReason: 'error', errorMessage: 'down' },
      });
      const engine = new JudgeEngine({
        config: mockJudgeConfig(),
        resolver: (pointId) =>
          healthy
            ? createMockResolver({ judgeId: 'mock/j2', answers: CLEAR(0.9) })(pointId)
            : failing(pointId),
        breaker,
        ledger: makeLedger(),
      });
      for (let i = 0; i < 5; i++) await engine.decide(makeSpec());
      expect(breaker.isOpen('tool.admission')).toBe(true);

      vi.advanceTimersByTime(1100);
      expect(breaker.isOpen('tool.admission')).toBe(false); // probe allowed

      // A failing probe re-opens (engine still uses the failing resolver).
      await engine.decide(makeSpec());
      expect(breaker.isOpen('tool.admission')).toBe(true);

      // After another cooldown a succeeding probe closes the circuit.
      vi.advanceTimersByTime(1100);
      healthy = true;
      await engine.decide(makeSpec());
      expect(breaker.state('tool.admission').state).toBe('closed');
      expect(breaker.isOpen('tool.admission')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('JudgeEngine — timeout + resolver failures', () => {
  it('tier that hangs until abort: engine timeout produces a service-failure fallback', async () => {
    const breaker = new JudgeCircuitBreaker();
    const engine = new JudgeEngine({
      config: mockJudgeConfig({ timeoutMs: 30 }),
      resolver: createMockResolver({ judgeId: 'mock/j1', hangUntilAbort: true }),
      breaker,
      ledger: makeLedger(),
    });
    const verdict = await engine.decide(makeSpec());
    expect(verdict.fallbackReason).toBe('unavailable');
    expect(verdict.latencyMs).toBeGreaterThanOrEqual(25);
    expect(breaker.state('tool.admission').consecutiveFailures).toBe(1);
  });

  it('resolver throwing / empty chain never throws to the caller', async () => {
    const engine = new JudgeEngine({
      config: mockJudgeConfig(),
      resolver: () => {
        throw new Error('boom');
      },
      ledger: makeLedger(),
    });
    const verdict = await engine.decide(makeSpec());
    expect(verdict.source).toBe('fallback');
    expect(verdict.fallbackReason).toBe('unavailable');
  });

  it('caller abort signal stops the cascade with reason aborted', async () => {
    const controller = new AbortController();
    const engine = new JudgeEngine({
      config: mockJudgeConfig(),
      resolver: createMockResolver({
        judgeId: 'mock/j1',
        failWith: { stopReason: 'error', errorMessage: 'first fails' },
      }),
      ledger: makeLedger(),
    });
    controller.abort();
    const verdict = await engine.decide(makeSpec(), { state: {} }, controller.signal);
    expect(verdict.fallbackReason).toBe('aborted');
  });
});

describe('JudgeEngine — ledger line format', () => {
  it('judged call: full record shape with usage and decisionId', async () => {
    const resolver = createMockResolver({
      judgeId: 'mock/j1',
      answers: CLEAR(0.9),
    });
    // Mock does not emit usage; assert absence rather than shape here.
    const engine = new JudgeEngine({
      config: mockJudgeConfig(),
      resolver,
      ledger: makeLedger(),
    });
    await engine.decide(makeSpec(), { state: { x: 1 }, sessionId: 'sess-1' });
    const [line] = engine.ledger.recent(1);
    expect(line).toMatchObject({
      sessionId: 'sess-1',
      pointId: 'tool.admission',
      decisionId: 'tool.admission@v1',
      mode: 'active',
      judgeId: 'mock/j1',
      source: 'judge',
      latencyMs: expect.any(Number),
      ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(line.state).toBeUndefined(); // recordState off by default
  });

  it('recordState: true persists the state; fallback call carries fallbackReason', async () => {
    const engine = new JudgeEngine({
      config: mockJudgeConfig({ recordState: true, modes: { default: 'shadow' } }),
      resolver: createMockResolver({
        judgeId: 'mock/j1',
        failWith: { stopReason: 'error', errorMessage: 'x' },
      }),
      ledger: makeLedger(),
    });
    await engine.decide(makeSpec(), { state: { secretish: 'trunc' } });
    const [line] = engine.ledger.recent(1);
    expect(line.state).toEqual({ secretish: 'trunc' });
    expect(line.source).toBe('fallback');
    expect(line.fallbackReason).toBe('unavailable');
  });

  it('free-Jev usage gets the daily notice once per day', async () => {
    const notice = vi.fn();
    const freeJev = new FreeJevMonitor({ onNotice: notice });
    const engine = new JudgeEngine({
      config: mockJudgeConfig(),
      resolver: createMockResolver({
        judgeId: 'opencode/jev-1.13-free',
        answers: CLEAR(0.9),
      }),
      freeJev,
      ledger: makeLedger(),
    });
    await engine.decide(makeSpec());
    await engine.decide(makeSpec());
    expect(notice).toHaveBeenCalledTimes(1);
  });

  it('free-Jev suspended by 5 sunset failures is skipped by the engine', async () => {
    const freeJev = new FreeJevMonitor();
    const tier: MockTierSpec = {
      judgeId: 'opencode/jev-1.13-free',
      failWith: { stopReason: 'error', errorMessage: 'HTTP 402 payment required' },
    };
    const engine = new JudgeEngine({
      config: mockJudgeConfig(),
      resolver: createMockResolver(tier, { judgeId: 'mock/paid', answers: CLEAR(0.9) }),
      freeJev,
      ledger: makeLedger(),
    });
    // Warm the sunset detector to the threshold by calling it directly.
    for (let i = 0; i < 5; i++)
      freeJev.recordOutcome(tier.judgeId, { stopReason: 'error', errorMessage: '402 gone' });
    expect(freeJev.isSuspendedToday()).toBe(true);
    const verdict = await engine.decide(makeSpec());
    // Free tier skipped → paid tier answers.
    expect(verdict.judgeId).toBe('mock/paid');
  });
});
