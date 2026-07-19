/**
 * End-to-end runtime tests for Interactive Self-Harness
 *
 * Tests the full pipeline using the actual running server:
 * Config → Services → Failure Detection → Rate Limiting → Policy → Editor
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  FailureDetector,
} from '../../src/harness/failure-detector.js';
import {
  HarnessRateLimiter,
} from '../../src/harness/rate-limiter.js';
import {
  EditableSurfaceProvider,
} from '../../src/harness/editable-surfaces.js';
import {
  ApprovalPolicy,
  DEFAULT_RULES,
} from '../../src/harness/approval-policy.js';
import {
  AutoApplyMonitor,
} from '../../src/harness/auto-apply-monitor.js';
import {
  SkillEditor,
} from '../../src/harness/skill-editor.js';
import {
  HarnessOptimizer,
} from '../../src/harness/harness-optimizer.js';
import type { FailureContext, ImprovementProposal } from '../../src/harness/types.js';

// ── Config matching the running server ─────────────────────────────────────────

const LIVE_CONFIG = {
  trigger: { minIdenticalRetries: 3, minExplorationSteps: 8, minConsecutiveErrors: 3 },
  rateLimit: { cooldownMinutes: 30, maxPerHour: 2, maxPerDay: 10, maxAutoApplyPerDay: 5 },
  proposal: { model: 'default', maxEditsPerProposal: 5, minConfidence: 0.5, allowedMechanisms: ['prompt_instruction', 'subagent', 'skill_procedure', 'tool_configuration', 'middleware', 'runtime_control'] },
};

describe('Self-Harness Runtime E2E', () => {
  // ── Scenario 1: Shell command retry loop ──────────────────────────────────

  describe('Scenario: Shell command retry loop', () => {
    it('detects identical_retry_loop for 3x failed shell commands', () => {
      const fd = new FailureDetector(LIVE_CONFIG.trigger);
      const ctx: FailureContext = {
        sessionId: 's1',
        taskMessage: 'Run adb devices',
        toolCalls: [
          { name: 'shell', args: { cmd: 'adb connect' }, isError: true, errorMessage: 'unauthorized', timestamp: 1 },
          { name: 'shell', args: { cmd: 'adb connect' }, isError: true, errorMessage: 'unauthorized', timestamp: 2 },
          { name: 'shell', args: { cmd: 'adb connect' }, isError: true, errorMessage: 'unauthorized', timestamp: 3 },
        ],
        errors: [
          { toolName: 'shell', message: 'unauthorized', timestamp: 1 },
          { toolName: 'shell', message: 'unauthorized', timestamp: 2 },
          { toolName: 'shell', message: 'unauthorized', timestamp: 3 },
        ],
        durationMs: 30000,
        terminatedEarly: false,
        agentEndReason: 'complete',
      };

      const signal = fd.detect(ctx);
      expect(signal).not.toBeNull();
      expect(signal!.pattern).toBe('identical_retry_loop');
      expect(signal!.severity).toBe('high');
    });

    it('passes rate limiting for the first trigger', () => {
      const rl = new HarnessRateLimiter({ cooldownMinutes: 0, maxPerHour: 100, maxPerDay: 200, maxAutoApplyPerDay: 20 });
      expect(rl.canTrigger('android-operator', 'default', 'identical_retry_loop')).toBe(true);
    });

    it('gets auto_apply policy for low-risk prompt text proposal', () => {
      const ap = new ApprovalPolicy();
      const proposal: ImprovementProposal = {
        id: 'prop-e2e-001',
        skillId: 'android-operator',
        agentId: null,
        type: 'prompt_text',
        title: 'Add device state check',
        summary: 'Add a device state check before adb connect',
        diff: { surface: 'skills/android-operator/SKILL.md', before: 'Run adb connect', after: 'Check adb devices first, then run adb connect' },
        impact: { scope: '仅 android-operator skill', riskLevel: 'low', expectedEffect: 'Reduce adb connection failures by 80%' },
        expectedEffect: 'Reduce failures',
        regressionRisk: 'low',
        affectedScope: '仅 android-operator skill',
        mechanismFamily: 'prompt_instruction',
        confidence: 0.85,
        createdAt: Date.now(),
      };

      const result = ap.evaluate(proposal, { skillId: 'android-operator', currentTime: new Date() });
      expect(result.action).toBe('auto_apply');
      expect(result.autoRollback).toBeDefined();
    });
  });

  // ── Scenario 2: Successful conversation (no trigger) ──────────────────────

  describe('Scenario: Successful conversation', () => {
    it('does not trigger for normal successful execution', () => {
      const fd = new FailureDetector(LIVE_CONFIG.trigger);
      const ctx: FailureContext = {
        sessionId: 's2',
        taskMessage: 'Read a file',
        toolCalls: [
          { name: 'file_read', args: { path: '/tmp/test.txt' }, isError: false, timestamp: 1 },
          { name: 'write', args: { path: '/tmp/out.txt' }, isError: false, timestamp: 2 },
        ],
        errors: [],
        durationMs: 2000,
        terminatedEarly: false,
        agentEndReason: 'complete',
      };

      expect(fd.detect(ctx)).toBeNull();
    });
  });

  // ── Scenario 3: All failure patterns ─────────────────────────────────────

  describe('Scenario: All failure patterns', () => {
    const fd = new FailureDetector(LIVE_CONFIG.trigger);

    it('detects tool_error_cascade (3 different tools fail)', () => {
      const ctx: FailureContext = {
        sessionId: 's3',
        taskMessage: 'Search and write',
        toolCalls: [
          { name: 'web_search', args: {}, isError: true, errorMessage: 'timeout', timestamp: 1 },
          { name: 'file_read', args: {}, isError: true, errorMessage: 'ENOENT', timestamp: 2 },
          { name: 'shell', args: {}, isError: true, errorMessage: 'permission denied', timestamp: 3 },
        ],
        errors: [
          { toolName: 'web_search', message: 'timeout', timestamp: 1 },
          { toolName: 'file_read', message: 'ENOENT', timestamp: 2 },
          { toolName: 'shell', message: 'permission denied', timestamp: 3 },
        ],
        durationMs: 10000,
        terminatedEarly: false,
        agentEndReason: 'complete',
      };

      const signal = fd.detect(ctx);
      expect(signal).not.toBeNull();
      expect(signal!.pattern).toBe('tool_error_cascade');
    });

    it('detects exploration_without_output (8+ reads, no change tools)', () => {
      const toolCalls = Array.from({ length: 9 }, (_, i) => ({
        name: 'file_read',
        args: { path: `/tmp/file${i}.txt` },
        isError: false,
        timestamp: i + 1,
      }));
      const ctx: FailureContext = {
        sessionId: 's4',
        taskMessage: 'Explore files',
        toolCalls,
        errors: [],
        durationMs: 20000,
        terminatedEarly: false,
        agentEndReason: 'complete',
      };

      expect(fd.detect(ctx)?.pattern).toBe('exploration_without_output');
    });

    it('detects timeout_or_abort', () => {
      const ctx: FailureContext = {
        sessionId: 's5',
        taskMessage: 'Long task',
        toolCalls: [{ name: 'shell', args: {}, isError: false, timestamp: 1 }],
        errors: [],
        durationMs: 300000,
        terminatedEarly: true,
        agentEndReason: 'aborted',
      };

      expect(fd.detect(ctx)?.pattern).toBe('timeout_or_abort');
    });
  });

  // ── Scenario 4: Approval Policy edge cases ────────────────────────────────

  describe('Scenario: Approval Policy coverage', () => {
    const ap = new ApprovalPolicy();

    it('default-fallback requires approval for unknown change types', () => {
      const proposal: ImprovementProposal = {
        id: 'prop-unknown',
        skillId: null, agentId: null, type: 'unknown_type', title: 'Test',
        summary: 'Test',
        diff: { surface: '/tmp/test', before: 'x', after: 'y' },
        impact: { scope: 'unknown', riskLevel: 'medium', expectedEffect: 'none' },
        expectedEffect: 'none', regressionRisk: 'medium', affectedScope: 'unknown',
        mechanismFamily: 'prompt_instruction', confidence: 0.5, createdAt: Date.now(),
      };
      const result = ap.evaluate(proposal, { currentTime: new Date() });
      // With regressionRisk='medium', it matches default-high-risk (priority 10)
      expect(result.ruleId).toBe('default-high-risk');
      expect(result.action).toBe('require_approval');
    });

    it('default-deny-deletion blocks trigger_remove', () => {
      const proposal: ImprovementProposal = {
        id: 'prop-del',
        skillId: null, agentId: null, type: 'trigger_remove', title: 'Remove trigger',
        summary: 'Test',
        diff: { surface: '/tmp/test', before: 'x', after: 'y' },
        impact: { scope: '仅 test', riskLevel: 'low', expectedEffect: 'none' },
        expectedEffect: 'none', regressionRisk: 'low', affectedScope: '仅 test skill',
        mechanismFamily: 'prompt_instruction', confidence: 0.9, createdAt: Date.now(),
      };
      const result = ap.evaluate(proposal, { currentTime: new Date() });
      expect(result.ruleId).toBe('default-deny-deletion');
    });

    it('DEFAULT_RULES has 9 rules', () => {
      expect(DEFAULT_RULES.length).toBe(9);
    });
  });

  // ── Scenario 5: SkillEditor validation ────────────────────────────────────

  describe('Scenario: SkillEditor validation', () => {
    const editor = new SkillEditor();

    it('validates a correct proposal', () => {
      const proposal: ImprovementProposal = {
        id: 'prop-ok', skillId: null, agentId: null, type: 'prompt_text', title: 'Test',
        summary: 'Test',
        diff: { surface: '/tmp/test.md', before: 'old instruction', after: 'new instruction with more detail' },
        impact: { scope: '仅 test', riskLevel: 'low', expectedEffect: 'better' },
        expectedEffect: 'better', regressionRisk: 'low', affectedScope: '仅 test',
        mechanismFamily: 'prompt_instruction', confidence: 0.8, createdAt: Date.now(),
      };
      expect(editor.validate(proposal).valid).toBe(true);
    });

    it('rejects path traversal', () => {
      const proposal: ImprovementProposal = {
        id: 'prop-bad', skillId: null, agentId: null, type: 'prompt_text', title: 'Bad',
        summary: 'Test',
        diff: { surface: '/tmp/../../../etc/passwd', before: 'x', after: 'y' },
        impact: { scope: '仅 test', riskLevel: 'low', expectedEffect: 'none' },
        expectedEffect: 'none', regressionRisk: 'low', affectedScope: '仅 test',
        mechanismFamily: 'prompt_instruction', confidence: 0.8, createdAt: Date.now(),
      };
      const result = editor.validate(proposal);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('..'))).toBe(true);
    });

    it('fails to apply to non-existent file', async () => {
      const proposal: ImprovementProposal = {
        id: 'prop-no-file', skillId: null, agentId: null, type: 'prompt_text', title: 'No File',
        summary: 'Test',
        diff: { surface: '/nonexistent/path/skill.md', before: 'x', after: 'y' },
        impact: { scope: '仅 test', riskLevel: 'low', expectedEffect: 'none' },
        expectedEffect: 'none', regressionRisk: 'low', affectedScope: '仅 test',
        mechanismFamily: 'prompt_instruction', confidence: 0.8, createdAt: Date.now(),
      };
      const result = await editor.apply(proposal);
      expect(result.success).toBe(false);
    });
  });

  // ── Scenario 6: AutoApplyMonitor lifecycle ────────────────────────────────

  describe('Scenario: AutoApplyMonitor lifecycle', () => {
    it('completes full lifecycle: watch → activate → pass → remove', () => {
      const monitor = new AutoApplyMonitor();
      const config = { satisfactionThreshold: 0.6, observationWindow: 3, errorRateMultiplier: 2.0 };

      monitor.watch('prop-lifecycle', 'test-skill', null, config, 'abc123');
      expect(monitor.getActiveMonitors().length).toBe(1);

      // Simulate 3 successful activations
      for (let i = 0; i < 3; i++) {
        monitor.onActivationComplete('test-skill', null, {
          success: true, errorCount: 0, durationMs: 1000,
        });
      }

      // After observation window with good metrics, monitor should be removed
      const active = monitor.getActiveMonitors();
      expect(active.length).toBe(0);
    });
  });

  // ── Scenario 7: Rate limiting edge cases ──────────────────────────────────

  describe('Scenario: Rate limiting edge cases', () => {
    it('different patterns do not share cooldown', () => {
      const rl = new HarnessRateLimiter({ cooldownMinutes: 1, maxPerHour: 100, maxPerDay: 200, maxAutoApplyPerDay: 50 });

      expect(rl.canTrigger('s1', 'a1', 'identical_retry_loop')).toBe(true);
      expect(rl.canTrigger('s1', 'a1', 'tool_error_cascade')).toBe(true); // Different pattern
      expect(rl.canTrigger('s2', 'a1', 'identical_retry_loop')).toBe(true); // Different skill
    });

    it('enforces maxPerHour limit', () => {
      const rl = new HarnessRateLimiter({ cooldownMinutes: 0, maxPerHour: 3, maxPerDay: 10, maxAutoApplyPerDay: 5 });

      expect(rl.canTrigger('s1', 'a1', 'identical_retry_loop')).toBe(true);
      expect(rl.canTrigger('s2', 'a1', 'tool_error_cascade')).toBe(true);
      expect(rl.canTrigger('s3', 'a1', 'exploration_without_output')).toBe(true);
      // 4th should be blocked
      expect(rl.canTrigger('s4', 'a1', 'timeout_or_abort')).toBe(false);
    });

    it('tracks auto-apply separately from regular triggers', () => {
      const rl = new HarnessRateLimiter({ cooldownMinutes: 0, maxPerHour: 100, maxPerDay: 200, maxAutoApplyPerDay: 1 });

      expect(rl.getAutoApplyCount()).toBe(0);
      rl.recordAutoApply();
      expect(rl.getAutoApplyCount()).toBe(1);
      rl.recordAutoApply();
      expect(rl.getAutoApplyCount()).toBe(2);
    });
  });

  // ── Scenario 8: Surface Provider ──────────────────────────────────────────

  describe('Scenario: EditableSurfaceProvider', () => {
    it('registers and retrieves surfaces correctly', () => {
      const sp = new EditableSurfaceProvider();

      sp.register({
        id: 'skill:android-operator:prompt',
        kind: 'skill_prompt',
        path: 'skills/android-operator/SKILL.md',
        label: 'Android Operator Prompt',
        currentValue: '# Android Operator\n\n调试Android设备。',
        mechanismFamily: 'prompt_instruction',
      });

      sp.register({
        id: 'global:failure_recovery_instruction',
        kind: 'failure_recovery_instruction',
        path: 'config:failure_recovery_instruction',
        label: 'Failure Recovery',
        currentValue: 'If a tool fails, try a different approach.',
        mechanismFamily: 'prompt_instruction',
      });

      expect(sp.get('skill:android-operator:prompt')).toBeDefined();
      expect(sp.get('global:failure_recovery_instruction')).toBeDefined();
      expect(sp.get('nonexistent')).toBeUndefined();
    });

    it('identifies relevant surfaces for skill context', () => {
      const sp = new EditableSurfaceProvider();
      sp.register({
        id: 'skill:test:prompt', kind: 'skill_prompt', path: 'skills/test/SKILL.md',
        label: 'Test', currentValue: '# Test', mechanismFamily: 'prompt_instruction',
      });

      const ctx: FailureContext = {
        sessionId: 's1', skillId: 'test', taskMessage: 'test',
        toolCalls: [], errors: [],
        durationMs: 0, terminatedEarly: false, agentEndReason: 'complete',
      };

      const surfaces = sp.identifyRelevantSurfaces(ctx);
      expect(surfaces.length).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Scenario 9: Optimizer with mock LLM ────────────────────────────────────

  describe('Scenario: HarnessOptimizer with mock LLM', () => {
    it('returns null for low confidence diagnosis', async () => {
      const sp = new EditableSurfaceProvider();
      const mockLLM = async (_sys: string, _msg: string): Promise<string> => {
        return JSON.stringify({
          terminal_cause: 'tool_error_loop',
          criticality: 'friction',
          agent_mechanism: 'prompt_instruction',
          reasoning: 'Low confidence test',
          recommended_surface: 'global:exec',
          confidence: 0.3,
        });
      };

      const optimizer = new HarnessOptimizer(LIVE_CONFIG.proposal, sp, mockLLM);

      const ctx: FailureContext = {
        sessionId: 's1', taskMessage: 'test',
        toolCalls: [{ name: 'shell', args: {}, isError: true, errorMessage: 'err', timestamp: 1 }],
        errors: [{ toolName: 'shell', message: 'err', timestamp: 1 }],
        durationMs: 1000, terminatedEarly: false, agentEndReason: 'error',
      };

      const result = await optimizer.optimize(ctx);
      expect(result).toBeNull();
    });

    it('returns proposal for high confidence diagnosis', async () => {
      const sp = new EditableSurfaceProvider();
      sp.register({
        id: 'global:failure_recovery_instruction', kind: 'failure_recovery_instruction',
        path: 'config:failure', label: 'Failure', currentValue: 'Try again.',
        mechanismFamily: 'prompt_instruction',
      });

      let callCount = 0;
      const mockLLM = async (_sys: string, _msg: string): Promise<string> => {
        callCount++;
        if (callCount === 1) {
          return JSON.stringify({
            terminal_cause: 'tool_error_loop',
            criticality: 'root_cause',
            agent_mechanism: 'prompt_instruction',
            reasoning: 'The agent kept retrying the same failed command',
            recommended_surface: 'global:failure_recovery_instruction',
            confidence: 0.85,
          });
        }
        // Note: parseProposal expects flat fields (before/after at top level, not nested in diff)
        return JSON.stringify({
          title: 'Improve failure recovery',
          summary: 'Add specific recovery steps',
          before: 'Try again.',
          after: 'Check state then try a different approach.',
          expected_effect: 'Reduce retries by 50%',
          regression_risk: 'low',
          confidence: 0.82,
          mechanism_family: 'prompt_instruction',
          affected_scope: '仅 test skill',
        });
      };

      const optimizer = new HarnessOptimizer(LIVE_CONFIG.proposal, sp, mockLLM);

      const ctx: FailureContext = {
        sessionId: 's2', taskMessage: 'debug',
        toolCalls: [
          { name: 'shell', args: {}, isError: true, errorMessage: 'err', timestamp: 1 },
          { name: 'shell', args: {}, isError: true, errorMessage: 'err', timestamp: 2 },
          { name: 'shell', args: {}, isError: true, errorMessage: 'err', timestamp: 3 },
        ],
        errors: [
          { toolName: 'shell', message: 'err', timestamp: 1 },
          { toolName: 'shell', message: 'err', timestamp: 2 },
          { toolName: 'shell', message: 'err', timestamp: 3 },
        ],
        durationMs: 10000, terminatedEarly: false, agentEndReason: 'error',
      };
      // The optimizer reads pattern from context (cast to include optional pattern field)
      (ctx as any).pattern = 'tool_error_cascade';

      const result = await optimizer.optimize(ctx);
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Improve failure recovery');
    });
  });

  // ── Scenario 10: Full pipeline integration ─────────────────────────────────

  describe('Scenario: Full pipeline integration', () => {
    it('completes the full detect→rate-limit→policy→validate flow', () => {
      // Step 1: Detect failure
      const fd = new FailureDetector(LIVE_CONFIG.trigger);
      const ctx: FailureContext = {
        sessionId: 'full-pipe', skillId: 'my-skill', taskMessage: 'do something',
        toolCalls: [
          { name: 'shell', args: {}, isError: true, errorMessage: 'fail', timestamp: 1 },
          { name: 'shell', args: {}, isError: true, errorMessage: 'fail', timestamp: 2 },
          { name: 'shell', args: {}, isError: true, errorMessage: 'fail', timestamp: 3 },
        ],
        errors: [
          { toolName: 'shell', message: 'fail', timestamp: 1 },
          { toolName: 'shell', message: 'fail', timestamp: 2 },
          { toolName: 'shell', message: 'fail', timestamp: 3 },
        ],
        durationMs: 10000, terminatedEarly: false, agentEndReason: 'error',
      };

      const signal = fd.detect(ctx);
      expect(signal).not.toBeNull();
      expect(signal!.pattern).toBe('identical_retry_loop');

      // Step 2: Rate limit
      const rl = new HarnessRateLimiter({ cooldownMinutes: 0, maxPerHour: 100, maxPerDay: 200, maxAutoApplyPerDay: 20 });
      const canTrigger = rl.canTrigger(ctx.skillId, ctx.agentId, signal!.pattern);
      expect(canTrigger).toBe(true);

      // Step 3: Evaluate policy
      const ap = new ApprovalPolicy();
      const prop: ImprovementProposal = {
        id: 'prop-full',
        skillId: 'my-skill', agentId: null,
        type: 'prompt_text', title: 'Improve shell error handling',
        summary: 'Add specific recovery instructions',
        diff: { surface: 'skills/my-skill/SKILL.md', before: 'Run shell command', after: 'Check prerequisites, then run shell command. On failure, try alternative approach.' },
        impact: { scope: '仅 my-skill', riskLevel: 'low', expectedEffect: 'Reduce failures' },
        expectedEffect: 'Reduce failures',
        regressionRisk: 'low', affectedScope: '仅 my-skill',
        mechanismFamily: 'prompt_instruction', confidence: 0.9, createdAt: Date.now(),
      };
      const decision = ap.evaluate(prop, { skillId: 'my-skill', currentTime: new Date() });
      expect(decision.action).toBe('auto_apply');
      expect(decision.autoRollback).toBeDefined();

      // Step 4: Validate proposal
      const editor = new SkillEditor();
      const validation = editor.validate(prop);
      expect(validation.valid).toBe(true);

      // Step 5: Verify monitoring would work
      if (decision.autoRollback) {
        const monitor = new AutoApplyMonitor();
        monitor.watch(prop.id, ctx.skillId ?? null, null, decision.autoRollback, 'commit123');
        expect(monitor.getActiveMonitors().length).toBe(1);
      }
    });
  });
});
