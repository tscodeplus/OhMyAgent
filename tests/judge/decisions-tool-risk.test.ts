/**
 * tool.risk — spec + tighten-only safety hook (impl doc §4.8, kernel M3).
 *
 * ONE-WAY FUSE assertions: the judged verdict may only TIGHTEN approval
 * (force the approval card on a risky-but-policy-allowed command). Every skip
 * path — engine absent, mode off/shadow, low-risk command, judge failure,
 * gray, judged "the user asked" — keeps the current allow flow: the judgment
 * can never auto-approve or weaken an approval requirement.
 */

import { describe, expect, it } from 'vitest';
import {
  NOT_ASKED_PROBABILITY,
  TOOL_RISK_COMMAND_MAX,
  TOOL_RISK_POINT_ID,
  judgeToolRisk,
  toolRiskSpec,
} from '../../src/judge/decisions/tool-risk.js';
import { DECISION_POINTS, DECISION_SPECS } from '../../src/judge/decisions/registry.js';
import { maybeTightenShellApproval } from '../../src/judge/hooks/safety-tool-risk.js';
import type { JudgeEngine } from '../../src/judge/index.js';
import { makeEngine } from './decisions-helpers.js';

const RISKY = 'rm -rf /tmp/build-cache'; // assessCommandRisk → high
const LOW_RISK = 'ls -la';

function policyAnswer(probability: number): Parameters<typeof toolRiskSpec.policy>[0] {
  return { 'risk.asked': { type: 'noul', probability } } as never;
}

describe('tool.risk registration', () => {
  it('appends the spec to the decision-point registry; catalog marks it implemented', () => {
    expect(DECISION_SPECS[TOOL_RISK_POINT_ID]).toBe(toolRiskSpec);
    expect(TOOL_RISK_POINT_ID).toBe('tool.risk');
    const point = DECISION_POINTS.find((p) => p.id === TOOL_RISK_POINT_ID);
    expect(point?.implemented).toBe(true);
  });

  it('fallback keeps the current flow (never blocks, never approves by itself)', () => {
    expect(toolRiskSpec.fallback).toEqual({ action: 'none' });
  });
});

describe('tool.risk spec policy (one-way fuse)', () => {
  it('tightens only at P(asked) <= NOT_ASKED_PROBABILITY', () => {
    expect(toolRiskSpec.policy?.(policyAnswer(NOT_ASKED_PROBABILITY - 0.01), ctx())).toEqual({
      action: 'ask',
    });
    expect(toolRiskSpec.policy?.(policyAnswer(NOT_ASKED_PROBABILITY), ctx())).toEqual({
      action: 'ask',
    });
  });

  it('never tightens when the user plausibly asked — no auto-approval direction exists', () => {
    for (const probability of [NOT_ASKED_PROBABILITY + 0.01, 0.5, 0.84, 0.85, 0.95, 1]) {
      expect(toolRiskSpec.policy?.(policyAnswer(probability), ctx())).toEqual({ action: 'none' });
    }
  });

  it('non-noul or missing answers keep the current flow', () => {
    expect(
      toolRiskSpec.policy?.(
        { 'risk.asked': { type: 'choice', choice: 'x', probabilities: { x: 1 }, confidence: 1 } },
        ctx(),
      ),
    ).toEqual({ action: 'none' });
    expect(toolRiskSpec.policy?.({}, ctx())).toEqual({ action: 'none' });
  });
});

function ctx(): Parameters<NonNullable<typeof toolRiskSpec.policy>>[1] {
  return { mode: 'active', input: { state: { command: RISKY, taskHint: '' } } };
}

describe('tool.risk buildState caps', () => {
  it('caps command to 300 chars and taskHint to 200; unwraps the DecisionInput', () => {
    const built = toolRiskSpec.buildState?.({
      state: {
        taskHint: 't'.repeat(300),
        command: 'c'.repeat(TOOL_RISK_COMMAND_MAX + 100),
      },
    });
    expect(built).toEqual({
      taskHint: 't'.repeat(200),
      command: 'c'.repeat(TOOL_RISK_COMMAND_MAX),
    });
  });
});

describe('judgeToolRisk hook (real engine + mock judge)', () => {
  it('mode off / engine absent → strict no-op, no judge call', async () => {
    const off = makeEngine('off');
    expect(await judgeToolRisk({ engine: off.engine, command: RISKY })).toEqual({ asked: false });
    expect(off.calls).toHaveLength(0);
  });

  it('shadow asks and ledger-writes but never tightens (zero behavior change)', async () => {
    const { engine, calls } = makeEngine('shadow', {
      answers: { 'risk.asked': { type: 'noul', probability: 0.05 } },
    });
    const result = await judgeToolRisk({ engine, command: RISKY, taskHint: 'cleanup' });
    expect(result).toEqual({ asked: true });
    expect(result.tighten).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.context.questions['risk.asked']?.type).toBe('bool');
  });

  it('active + judged "most likely not asked" → tighten (force the approval card)', async () => {
    const { engine } = makeEngine('active', {
      answers: { 'risk.asked': { type: 'noul', probability: 0.1 } },
    });
    const result = await judgeToolRisk({ engine, command: RISKY, taskHint: 'cleanup' });
    expect(result).toEqual({ asked: true, tighten: true });
  });

  it('active + judged "the user asked" → tighten stays UNDEFINED (never exempts, never auto-approves)', async () => {
    const { engine, calls } = makeEngine('active', {
      answers: { 'risk.asked': { type: 'noul', probability: 0.95 } },
    });
    const result = await judgeToolRisk({ engine, command: RISKY });
    expect(result.tighten).toBeUndefined();
    expect(calls[0]!.context.state).toMatchObject({ command: RISKY });
  });

  it('active + judge failure → fallback keeps the allow flow (no tighten, no fail-open tightening)', async () => {
    const { engine, calls } = makeEngine('active', {
      failWith: { stopReason: 'error', errorMessage: 'network down' },
    });
    const result = await judgeToolRisk({ engine, command: RISKY });
    expect(result).toEqual({ asked: true });
    expect(result.tighten).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('active + gray answer cascades to fallback → no tighten', async () => {
    const { engine } = makeEngine('active', {
      answers: { 'risk.asked': { type: 'noul', probability: 0.5 } },
    });
    const result = await judgeToolRisk({ engine, command: RISKY });
    expect(result.tighten).toBeUndefined();
  });

  it('state carries the task hint and capped command text', async () => {
    const { engine, calls } = makeEngine('active', {
      answers: { 'risk.asked': { type: 'noul', probability: 0.1 } },
    });
    await judgeToolRisk({
      engine,
      command: 'rm -rf ' + 'x'.repeat(TOOL_RISK_COMMAND_MAX + 50),
      taskHint: 'clean the build cache',
    });
    expect(calls[0]!.context.state).toMatchObject({ taskHint: 'clean the build cache' });
    expect((calls[0]!.context.state as { command: string }).command.length).toBeLessThanOrEqual(
      TOOL_RISK_COMMAND_MAX,
    );
  });
});

describe('maybeTightenShellApproval hook (before-tool-call gating)', () => {
  it('non-shell tools and engine-absent getters are strict no-ops', async () => {
    const { engine, calls } = makeEngine('active', {
      answers: { 'risk.asked': { type: 'noul', probability: 0.1 } },
    });
    expect(await maybeTightenShellApproval({ engine, toolName: 'web_fetch', command: RISKY })).toBe(
      false,
    );
    expect(await maybeTightenShellApproval({ toolName: 'shell', command: RISKY })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('off mode or low-risk commands skip the judge without a call', async () => {
    const off = makeEngine('off');
    expect(
      await maybeTightenShellApproval({ engine: off.engine, toolName: 'shell', command: RISKY }),
    ).toBe(false);
    expect(off.calls).toHaveLength(0);

    const active = makeEngine('active');
    expect(
      await maybeTightenShellApproval({
        engine: active.engine,
        toolName: 'shell',
        command: LOW_RISK,
      }),
    ).toBe(false);
    expect(active.calls).toHaveLength(0);
  });

  it('engine getter form (deps.judgeGet) drives the judge and tightens on "not asked"', async () => {
    const { engine, calls } = makeEngine('active', {
      answers: { 'risk.asked': { type: 'noul', probability: 0.1 } },
    });
    const tightened = await maybeTightenShellApproval({
      engine: () => engine,
      toolName: 'shell',
      command: RISKY,
    });
    expect(tightened).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('judged "asked" and judge failure both keep the allow flow', async () => {
    const asked = makeEngine('active', {
      answers: { 'risk.asked': { type: 'noul', probability: 0.9 } },
    });
    expect(
      await maybeTightenShellApproval({ engine: asked.engine, toolName: 'shell', command: RISKY }),
    ).toBe(false);

    const broken = makeEngine('active', {
      failWith: { stopReason: 'error', errorMessage: 'boom' },
    });
    expect(
      await maybeTightenShellApproval({ engine: broken.engine, toolName: 'shell', command: RISKY }),
    ).toBe(false);
  });

  it('a throwing engine getter never breaks the gating path', async () => {
    const throwingGet = (): JudgeEngine | undefined => {
      throw new Error('engine exploded');
    };
    expect(
      await maybeTightenShellApproval({ engine: throwingGet, toolName: 'shell', command: RISKY }),
    ).toBe(false);
  });
});
