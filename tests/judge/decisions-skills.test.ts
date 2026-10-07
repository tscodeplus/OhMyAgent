/**
 * skills.disclosure decision point (phase-1 M1): multi-hit filter, weak
 * triggers, skip conditions (explicit / strict surface / explicitTools),
 * fallback keep, shadow invariants.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  judgeSkillsDisclosure,
  isWeakTriggerHit,
  SKILLS_DISCLOSURE_POINT_ID,
} from '../../src/judge/decisions/skills-disclosure.js';
import { resolveSkillContext, type ResolvedSkill } from '../../src/skills/skill-router.js';
import type { LoadedSkill } from '../../src/skills/skill-loader.js';
import { JudgeEngine } from '../../src/judge/index.js';
import { JudgeLedger } from '../../src/judge/ledger.js';
import { createMockTier, mockJudgeConfig, type MockTierSpec } from './mock.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'judge-skills-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function fakeSkill(
  id: string,
  name: string,
  triggers: string[],
  surface: 'default' | 'strict' = 'default',
): LoadedSkill {
  return {
    manifest: {
      id,
      name,
      description: `${name} skill`,
      version: '1.0.0',
      triggers,
      priority: 10,
      enabled: true,
    },
    promptContent: '',
    tools: { allowedTools: [], ...(surface === 'strict' ? { surface } : {}) },
    memoryPolicy: { scopes: [] },
    path: `skills/${id}/SKILL.md`,
  } as unknown as LoadedSkill;
}

const KEEP = 0.9;
const DROP = 0.05;

function makeEngine(
  mode: 'active' | 'shadow' | 'off',
  overrides: Partial<MockTierSpec> = {},
): { engine: JudgeEngine; calls: NonNullable<MockTierSpec['calls']> } {
  const calls: NonNullable<MockTierSpec['calls']> = [];
  const tier = createMockTier({ judgeId: 'mock/j1', calls, ...overrides });
  const engine = new JudgeEngine({
    config: mockJudgeConfig(mode === 'active' ? {} : { modes: { default: mode } }),
    resolver: () => ({ tiers: [tier], noKeyRefs: [], unresolvableRefs: [] }),
    ledger: new JudgeLedger({ dir: tmpDir }),
  });
  return { engine, calls };
}

function judge(input: {
  engine: JudgeEngine;
  message: string;
  skills: LoadedSkill[];
  explicitTools?: boolean;
  sessionId?: string;
}) {
  return judgeSkillsDisclosure({
    engine: input.engine,
    message: input.message,
    resolved: resolveSkillContext(input.message, input.skills),
    explicitToolsActive: input.explicitTools === true,
    sessionId: input.sessionId ?? 's1',
  });
}

describe('skills.disclosure filter', () => {
  const researcher = fakeSkill('researcher', 'Researcher', ['research']);
  const docs = fakeSkill('doc-writer', 'Doc Writer', ['docs']);

  it('multi-hit filter: drops candidates at P(keep) <= 0.1, keeps the rest', async () => {
    const { engine, calls } = makeEngine('active', {
      answers: {
        s1: { type: 'noul', probability: KEEP },
        s2: { type: 'noul', probability: DROP },
      },
    });
    const result = await judge({
      engine,
      message: 'help me research and write the docs now',
      skills: [researcher, docs],
    });
    expect(result.asked).toBe(true);
    expect(result.allowIds).toEqual(['researcher']);
    expect(calls).toHaveLength(1);
    const context = calls[0]!.context;
    expect(Object.keys(context.questions)).toEqual(['s1', 's2']);
    expect(context.questions['s2']!.instructions).toBe(
      'is skill Doc Writer relevant to this message?',
    );
    const state = context.state as { messageExcerpt: string; candidates: Array<{ id: string }> };
    expect(state.messageExcerpt.startsWith('help me research')).toBe(true);
    expect(state.candidates.map((c) => c.id)).toEqual(['researcher', 'doc-writer']);
  });

  it('weak single trigger is judged; a strong single trigger is skipped', async () => {
    const sketch = fakeSkill('sketcher', 'Sketcher', ['画']);
    expect(isWeakTriggerHit('画')).toBe(true);
    expect(isWeakTriggerHit('research')).toBe(false);

    const engineSet = makeEngine('active', {
      answers: { s1: { type: 'noul', probability: KEEP } },
    });
    const weak = await judge({
      engine: engineSet.engine,
      message: '画一个快速的东西',
      skills: [sketch],
    });
    expect(weak.asked).toBe(true);
    expect(weak.allowIds).toEqual(['sketcher']);
    engineSet.calls.length = 0;

    // single STRONG trigger: current behavior stands — not even asked
    const strong = await judge({
      engine: engineSet.engine,
      message: 'do research on this',
      skills: [researcher],
    });
    expect(strong).toEqual({ asked: false });
    expect(engineSet.calls).toHaveLength(0);
  });

  it('explicit commands, strict surfaces and explicitTools skip judging entirely', async () => {
    const engineMake = (): { engine: JudgeEngine; calls: NonNullable<MockTierSpec['calls']> } =>
      makeEngine('active', { answers: { s1: { type: 'noul', probability: DROP } } });

    // explicit $skill-id command
    const e1 = engineMake();
    expect(
      await judge({
        engine: e1.engine,
        message: '$researcher summarize this',
        skills: [researcher],
      }),
    ).toEqual({
      asked: false,
    });
    expect(e1.calls).toHaveLength(0);

    // strict surface skill
    const strictSkill = fakeSkill('strictone', 'Strict One', ['strictone'], 'strict');
    const e2 = engineMake();
    expect(
      await judge({
        engine: e2.engine,
        message: 'use strictone mode please',
        skills: [strictSkill],
      }),
    ).toEqual({
      asked: false,
    });
    expect(e2.calls).toHaveLength(0);

    // explicitTools active for the turn
    const e3 = engineMake();
    expect(
      await judge({
        engine: e3.engine,
        message: 'help me research and write the docs',
        skills: [researcher, docs],
        explicitTools: true,
      }),
    ).toEqual({ asked: false });
    expect(e3.calls).toHaveLength(0);
  });

  it('fallback keeps all hits (service failure) and shadow never filters', async () => {
    const failed = makeEngine('active', {
      failWith: { stopReason: 'error' as const, errorMessage: 'down' },
    });
    const fallback = await judge({
      engine: failed.engine,
      message: 'help me research and write the docs',
      skills: [researcher, docs],
    });
    expect(fallback.asked).toBe(true);
    expect(fallback.allowIds).toBeUndefined(); // current behavior: keep all
    const lines = failed.engine.ledger.recent(1);
    expect(lines[0]!.source).toBe('fallback');

    const shadow = makeEngine('shadow', {
      answers: {
        s1: { type: 'noul', probability: DROP },
        s2: { type: 'noul', probability: DROP },
      },
    });
    const shadowResult = await judge({
      engine: shadow.engine,
      message: 'help me research and write the docs',
      skills: [researcher, docs],
    });
    expect(shadowResult.asked).toBe(true);
    expect(shadowResult.allowIds).toBeUndefined(); // ZERO behavior change in shadow
    const shadowLines = shadow.engine.ledger.recent(5);
    expect(shadowLines.length).toBe(1);
    expect(shadowLines[0]!.pointId).toBe(SKILLS_DISCLOSURE_POINT_ID);
  });

  it('off and no-engine are strict no-ops (no calls, no ledger)', async () => {
    const off = makeEngine('off', { answers: { s1: { type: 'noul', probability: DROP } } });
    const offResult = await judge({
      engine: off.engine,
      message: 'help me research and write the docs',
      skills: [researcher, docs],
    });
    expect(offResult).toEqual({ asked: false });
    expect(off.calls).toHaveLength(0);
    expect(off.engine.ledger.recent(1).length).toBe(0);

    const noEngine = await judgeSkillsDisclosure({
      message: 'help me research and write the docs',
      resolved: resolveSkillContext('help me research and write the docs', [
        researcher,
        docs,
      ]) as ResolvedSkill[],
      explicitToolsActive: false,
      sessionId: 's1',
    });
    expect(noEngine).toEqual({ asked: false });
  });

  it('evicting every judged candidate yields an empty allow-set (active semantics)', async () => {
    const { engine } = makeEngine('active', {
      answers: {
        s1: { type: 'noul', probability: DROP },
        s2: { type: 'noul', probability: DROP },
      },
    });
    const result = await judge({
      engine,
      message: 'help me research and write the docs',
      skills: [researcher, docs],
    });
    expect(result.allowIds).toEqual([]); // activateSkill then activates nothing
  });
});
