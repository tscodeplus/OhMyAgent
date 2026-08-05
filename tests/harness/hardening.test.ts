/**
 * Hardening tests for the Self-Harness system.
 *
 * Covers the review findings:
 *  1. rollback failure must not drop supervision (monitor kept, retried,
 *     then marked rollbackFailed after the attempt limit)
 *  2. SkillEditor partial application when diff.before appears multiple times
 *  3. HarnessOptimizer proposal dedup memory (no repeat proposals)
 *  4. HarnessOptimizer historical-stats injection into the diagnosis prompt
 *
 * git subprocesses are mocked so no test touches the real repository.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { AutoApplyMonitor } from '../../src/harness/auto-apply-monitor.js';
import { SkillEditor } from '../../src/harness/skill-editor.js';
import { HarnessOptimizer } from '../../src/harness/harness-optimizer.js';
import { EditableSurfaceProvider } from '../../src/harness/editable-surfaces.js';
import type { FailureContext, ToolCallRecord } from '../../src/harness/types.js';

// Mock all git subprocess calls in this file (monitor rollback + editor apply).
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const execFileMock = vi.mocked(execFile);

function makeToolCall(name: string, isError: boolean, timestamp: number): ToolCallRecord {
  return {
    name,
    args: {},
    result: isError ? { error: 'command failed' } : { output: 'ok' },
    isError,
    errorMessage: isError ? `${name}: command failed` : undefined,
    timestamp,
  };
}

function makeFailureContext(overrides?: Partial<FailureContext>): FailureContext {
  return {
    sessionId: 's1',
    skillId: 'test-skill',
    taskMessage: 'test',
    toolCalls: [makeToolCall('shell', true, 1)],
    errors: [{ toolName: 'shell', message: 'err', timestamp: 1 }],
    durationMs: 1000,
    terminatedEarly: false,
    agentEndReason: 'error',
    ...overrides,
  };
}

/** Register the standard skill surface used by optimizer tests. */
function makeSurfaceProvider(): EditableSurfaceProvider {
  const provider = new EditableSurfaceProvider();
  provider.register({
    id: 'skill:test-skill:prompt',
    kind: 'skill_prompt',
    path: 'skills/test-skill/SKILL.md',
    label: 'Test Skill Prompt',
    currentValue: 'Do the thing carefully.',
    mechanismFamily: 'prompt_instruction',
  });
  return provider;
}

/** Mock LLM alternating diagnosis / proposal JSON on successive calls. */
function makeAlternatingLlm(container: { capturedUserMessages: string[] }) {
  return vi.fn(async (_sys: string, user: string) => {
    container.capturedUserMessages.push(user);
    const call = container.capturedUserMessages.length;
    if (call % 2 === 1) {
      return JSON.stringify({
        terminal_cause: 'agent retried the same failed command',
        criticality: 'root_cause',
        agent_mechanism: 'prompt_instruction',
        reasoning: 'The agent kept retrying a failing command without adapting.',
        recommended_surface: 'skill:test-skill:prompt',
        confidence: 0.9,
      });
    }
    return JSON.stringify({
      title: 'Add precondition check',
      summary: 'Check preconditions before running the command',
      before: 'Do the thing carefully.',
      after: 'Check the prerequisite first, then do the thing carefully.',
      expected_effect: 'Fewer failed retries',
      regression_risk: 'low',
      confidence: 0.9,
      mechanism_family: 'prompt_instruction',
      change_type: 'prompt_text',
      affected_scope: 'single_skill',
    });
  });
}

// ── 1. Rollback failure keeps the monitor supervised ───────────────────────────

describe('AutoApplyMonitor rollback failure handling', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('keeps the monitor when the git revert fails and retries on next evaluation', async () => {
    // Every git call fails — the revert can never succeed.
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(new Error('revert conflict') as never, '' as never);
    });

    const monitor = new AutoApplyMonitor(
      `/tmp/harness-monitors-${Math.random().toString(36).slice(2)}.json`,
    );
    monitor.watch('prop-rb', 'skill-a', null, {
      satisfactionThreshold: 0.6,
      observationWindow: 1,
      errorRateMultiplier: 2.0,
    }, 'commit1');

    // First failing activation → evaluate → rollback attempt #1 fails.
    monitor.onActivationComplete('skill-a', null, {
      success: false, errorCount: 3, durationMs: 1000,
    });

    // Each evaluation must be awaited before firing the next one: back-to-back
    // activations in the same tick are intentionally coalesced by the in-flight
    // revert guard (a second revert of the same commit would fail anyway).
    await vi.waitFor(() => {
      const active = monitor.getActiveMonitors();
      expect(active.length).toBe(1); // monitor must survive a failed revert
      expect(active[0]!.rollbackAttempts).toBe(1);
      expect(active[0]!.rollbackFailed).toBeUndefined();
    });

    // Two more failing evaluations → attempts reach the limit → rollbackFailed.
    monitor.onActivationComplete('skill-a', null, {
      success: false, errorCount: 3, durationMs: 1000,
    });
    await vi.waitFor(() => {
      expect(monitor.getActiveMonitors()[0]!.rollbackAttempts).toBe(2);
    });

    monitor.onActivationComplete('skill-a', null, {
      success: false, errorCount: 3, durationMs: 1000,
    });
    await vi.waitFor(() => {
      const active = monitor.getActiveMonitors();
      expect(active[0]!.rollbackAttempts).toBe(3);
      expect(active[0]!.rollbackFailed).toBe(true);
    });
    expect(execFileMock).toHaveBeenCalledTimes(3);
    // All three calls were git reverts of the same commit.
    for (const call of execFileMock.mock.calls) {
      expect(call[0]).toBe('git');
      expect(call[1]).toEqual(['revert', 'commit1', '--no-edit']);
    }
  });

  it('does not keep hammering git after the monitor is marked rollbackFailed', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(new Error('revert conflict') as never, '' as never);
    });

    const monitor = new AutoApplyMonitor(
      `/tmp/harness-monitors-${Math.random().toString(36).slice(2)}.json`,
    );
    monitor.watch('prop-rb2', 'skill-a', null, {
      satisfactionThreshold: 0.6,
      observationWindow: 1,
      errorRateMultiplier: 2.0,
    }, 'commit1');

    // Drive 3 failed attempts (awaiting each evaluation so the in-flight
    // revert guard never coalesces two attempts into one).
    for (let i = 1; i <= 3; i++) {
      monitor.onActivationComplete('skill-a', null, {
        success: false, errorCount: 3, durationMs: 1000,
      });
      await vi.waitFor(() => {
        expect(monitor.getActiveMonitors()[0]!.rollbackAttempts).toBe(i);
      });
    }
    await vi.waitFor(() => {
      expect(monitor.getActiveMonitors()[0]!.rollbackFailed).toBe(true);
    });
    expect(execFileMock).toHaveBeenCalledTimes(3);

    // A 4th evaluation must not trigger another revert. Give any stray
    // async call time to surface before asserting the count is unchanged.
    monitor.onActivationComplete('skill-a', null, {
      success: false, errorCount: 3, durationMs: 1000,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it('removes the monitor only after a successful revert', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null as never, '' as never);
    });

    const monitor = new AutoApplyMonitor(
      `/tmp/harness-monitors-${Math.random().toString(36).slice(2)}.json`,
    );
    monitor.watch('prop-ok', 'skill-a', null, {
      satisfactionThreshold: 0.6,
      observationWindow: 1,
      errorRateMultiplier: 2.0,
    }, 'commit1');

    monitor.onActivationComplete('skill-a', null, {
      success: false, errorCount: 3, durationMs: 1000,
    });

    await vi.waitFor(() => {
      expect(monitor.getActiveMonitors().length).toBe(0);
    });
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['revert', 'commit1', '--no-edit'],
      expect.any(Object),
      expect.any(Function),
    );
  });
});

// ── 2. SkillEditor multi-occurrence diff.before ────────────────────────────────

describe('SkillEditor multi-occurrence diff.before', () => {
  let dir: string;

  beforeEach(async () => {
    execFileMock.mockReset();
    // git add / commit / rev-parse all succeed; rev-parse yields a hash.
    execFileMock.mockImplementation((cmd, args, _opts, cb) => {
      if (cmd === 'git' && args[0] === 'rev-parse') {
        cb(null as never, 'deadbeef1234\n' as never);
      } else {
        cb(null as never, '' as never);
      }
    });
    dir = await mkdtemp(join(tmpdir(), 'harness-editor-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('replaces only the first occurrence and returns a warning', async () => {
    const filePath = join(dir, 'SKILL.md');
    await writeFile(filePath, 'old text\nold text\n', 'utf-8');

    const editor = new SkillEditor((id) =>
      id === 'skill:multi:prompt' ? filePath : undefined,
    );
    const result = await editor.apply({
      id: 'prop-multi',
      skillId: null,
      agentId: null,
      type: 'prompt_text',
      title: 'Multi-match test',
      summary: 'before text appears twice',
      diff: { surface: 'skill:multi:prompt', before: 'old text', after: 'new text' },
      impact: { scope: 'single_skill', riskLevel: 'low', expectedEffect: 'x' },
      expectedEffect: 'x',
      regressionRisk: 'low',
      affectedScope: 'single_skill',
      mechanismFamily: 'prompt_instruction',
      confidence: 0.9,
      createdAt: Date.now(),
    });

    expect(result.success).toBe(true);
    expect(result.commitHash).toBe('deadbeef1234');
    expect(result.warning).toContain('2 times');
    expect(result.warning).toContain('only the first occurrence');

    // Only the first occurrence was replaced on disk.
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('new text\nold text\n');
  });

  it('returns no warning for a single occurrence', async () => {
    const filePath = join(dir, 'SKILL.md');
    await writeFile(filePath, 'old text\n', 'utf-8');

    const editor = new SkillEditor((id) =>
      id === 'skill:single:prompt' ? filePath : undefined,
    );
    const result = await editor.apply({
      id: 'prop-single',
      skillId: null,
      agentId: null,
      type: 'prompt_text',
      title: 'Single match test',
      summary: 'before text appears once',
      diff: { surface: 'skill:single:prompt', before: 'old text', after: 'new text' },
      impact: { scope: 'single_skill', riskLevel: 'low', expectedEffect: 'x' },
      expectedEffect: 'x',
      regressionRisk: 'low',
      affectedScope: 'single_skill',
      mechanismFamily: 'prompt_instruction',
      confidence: 0.9,
      createdAt: Date.now(),
    });

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
  });
});

// ── 3. HarnessOptimizer proposal dedup memory ──────────────────────────────────

describe('HarnessOptimizer proposal dedup memory', () => {
  it('returns null for a repeated proposal with an identical failure context', async () => {
    const container: { capturedUserMessages: string[] } = { capturedUserMessages: [] };
    const mockLLM = makeAlternatingLlm(container);
    const memoryPath =
      `/tmp/harness-memory-${Math.random().toString(36).slice(2)}.json`;

    const optimizer = new HarnessOptimizer(
      { model: 'default', maxEditsPerProposal: 5, minConfidence: 0.5, allowedMechanisms: ['prompt_instruction'] },
      makeSurfaceProvider(),
      mockLLM,
      memoryPath,
    );
    const ctx = makeFailureContext();

    // First optimize emits a proposal and remembers it.
    const first = await optimizer.optimize(ctx);
    expect(first).not.toBeNull();

    // Same context + same LLM output → deduplicated, no repeat proposal.
    const second = await optimizer.optimize(ctx);
    expect(second).toBeNull();
    expect(mockLLM).toHaveBeenCalledTimes(4); // diagnose+propose each round
  });

  it('restores the dedup memory from disk across optimizer instances', async () => {
    const container: { capturedUserMessages: string[] } = { capturedUserMessages: [] };
    const memoryPath =
      `/tmp/harness-memory-${Math.random().toString(36).slice(2)}.json`;

    const firstOptimizer = new HarnessOptimizer(
      { model: 'default', maxEditsPerProposal: 5, minConfidence: 0.5, allowedMechanisms: ['prompt_instruction'] },
      makeSurfaceProvider(),
      makeAlternatingLlm(container),
      memoryPath,
    );
    expect(await firstOptimizer.optimize(makeFailureContext())).not.toBeNull();
    // Let the async persist finish before constructing the second instance.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const secondOptimizer = new HarnessOptimizer(
      { model: 'default', maxEditsPerProposal: 5, minConfidence: 0.5, allowedMechanisms: ['prompt_instruction'] },
      makeSurfaceProvider(),
      makeAlternatingLlm(container),
      memoryPath,
    );
    // The remembered proposal from the first instance blocks the same change.
    expect(await secondOptimizer.optimize(makeFailureContext())).toBeNull();
  });
});

// ── 4. HarnessOptimizer historical-stats injection ─────────────────────────────

describe('HarnessOptimizer historical-stats injection', () => {
  it('includes the skill stats block in the diagnosis user message', async () => {
    const container: { capturedUserMessages: string[] } = { capturedUserMessages: [] };
    const optimizer = new HarnessOptimizer(
      { model: 'default', maxEditsPerProposal: 5, minConfidence: 0.5, allowedMechanisms: ['prompt_instruction'] },
      makeSurfaceProvider(),
      makeAlternatingLlm(container),
      `/tmp/harness-memory-${Math.random().toString(36).slice(2)}.json`,
    );

    const ctx = makeFailureContext({
      skillStats: {
        totalActivations: 42,
        successRate: 0.75,
        avgDurationMs: 1234,
        topTools: [{ name: 'shell', count: 5 }, { name: 'file_read', count: 3 }],
      },
    });

    await optimizer.optimize(ctx);

    const diagnosisMessage = container.capturedUserMessages[0]!;
    expect(diagnosisMessage).toContain('Skill historical stats:');
    expect(diagnosisMessage).toContain('Activations: 42');
    expect(diagnosisMessage).toContain('Success rate: 75%');
    expect(diagnosisMessage).toContain('Avg duration: 1234ms');
    expect(diagnosisMessage).toContain('Top tools: shell (5), file_read (3)');
  });

  it('renders "unknown" for missing success rate / duration', async () => {
    const container: { capturedUserMessages: string[] } = { capturedUserMessages: [] };
    const optimizer = new HarnessOptimizer(
      { model: 'default', maxEditsPerProposal: 5, minConfidence: 0.5, allowedMechanisms: ['prompt_instruction'] },
      makeSurfaceProvider(),
      makeAlternatingLlm(container),
      `/tmp/harness-memory-${Math.random().toString(36).slice(2)}.json`,
    );

    const ctx = makeFailureContext({
      skillStats: {
        totalActivations: 3,
        successRate: null,
        avgDurationMs: null,
        topTools: [],
      },
    });

    await optimizer.optimize(ctx);

    const diagnosisMessage = container.capturedUserMessages[0]!;
    expect(diagnosisMessage).toContain('Success rate: unknown');
    expect(diagnosisMessage).toContain('Avg duration: unknown');
    expect(diagnosisMessage).toContain('Top tools: none');
  });

  it('omits the stats block when no skillStats are available', async () => {
    const container: { capturedUserMessages: string[] } = { capturedUserMessages: [] };
    const optimizer = new HarnessOptimizer(
      { model: 'default', maxEditsPerProposal: 5, minConfidence: 0.5, allowedMechanisms: ['prompt_instruction'] },
      makeSurfaceProvider(),
      makeAlternatingLlm(container),
      `/tmp/harness-memory-${Math.random().toString(36).slice(2)}.json`,
    );

    await optimizer.optimize(makeFailureContext());

    const diagnosisMessage = container.capturedUserMessages[0]!;
    expect(diagnosisMessage).not.toContain('Skill historical stats:');
  });
});
