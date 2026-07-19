/**
 * Realistic end-to-end simulation of the Self-Harness pipeline.
 * Simulates real agent sessions and tests the full detect→rate-limit→optimize→policy→validate→monitor flow.
 */
import { describe, it, expect } from 'vitest';
import { FailureDetector } from '../../src/harness/failure-detector.js';
import { HarnessRateLimiter } from '../../src/harness/rate-limiter.js';
import { EditableSurfaceProvider } from '../../src/harness/editable-surfaces.js';
import { ApprovalPolicy } from '../../src/harness/approval-policy.js';
import { AutoApplyMonitor } from '../../src/harness/auto-apply-monitor.js';
import { SkillEditor } from '../../src/harness/skill-editor.js';
import { HarnessOptimizer } from '../../src/harness/harness-optimizer.js';
import type { FailureContext, FailureSignal, ImprovementProposal, ToolCallRecord } from '../../src/harness/types.js';

const CONFIG = {
  trigger: { minIdenticalRetries: 3, minExplorationSteps: 8, minConsecutiveErrors: 3 },
  rateLimit: { cooldownMinutes: 0, maxPerHour: 100, maxPerDay: 200, maxAutoApplyPerDay: 20 },
  proposal: { model: 'default', maxEditsPerProposal: 5, minConfidence: 0.5, allowedMechanisms: ['prompt_instruction', 'subagent', 'skill_procedure', 'tool_configuration', 'middleware', 'runtime_control'] },
};

describe('Self-Harness Simulation', () => {
  // ── Scenario 1: Android adb retry loop → full pipeline ───────────────────

  describe('Scenario 1: Android Debugging - adb retry loop', () => {
    it('detects identical_retry_loop (4x same failed adb connect)', () => {
      const fd = new FailureDetector(CONFIG.trigger);
      const ctx: FailureContext = {
        sessionId: 'sim-001', skillId: 'android-operator', agentId: 'default',
        taskMessage: '帮我调试Android设备',
        toolCalls: [
          { name: 'file_read', args: { path: '/tmp/task.txt' }, isError: false, timestamp: 1000 },
          { name: 'shell', args: { cmd: 'adb connect 192.168.1.100' }, isError: true, errorMessage: 'unauthorized', timestamp: 2000 },
          { name: 'shell', args: { cmd: 'adb devices' }, isError: false, timestamp: 3000 },
          { name: 'shell', args: { cmd: 'adb connect 192.168.1.100' }, isError: true, errorMessage: 'unauthorized', timestamp: 4000 },
          { name: 'shell', args: { cmd: 'adb connect 192.168.1.100' }, isError: true, errorMessage: 'unauthorized', timestamp: 5000 },
          { name: 'shell', args: { cmd: 'adb connect 192.168.1.100' }, isError: true, errorMessage: 'unauthorized', timestamp: 6000 },
        ],
        errors: [
          { toolName: 'shell', message: 'unauthorized', timestamp: 2000 },
          { toolName: 'shell', message: 'unauthorized', timestamp: 4000 },
          { toolName: 'shell', message: 'unauthorized', timestamp: 5000 },
          { toolName: 'shell', message: 'unauthorized', timestamp: 6000 },
        ],
        durationMs: 6000, terminatedEarly: false, agentEndReason: 'complete',
      };

      const signal = fd.detect(ctx);
      expect(signal).not.toBeNull();
      expect(signal!.pattern).toBe('identical_retry_loop');
      expect(signal!.severity).toBe('high');
      expect(signal!.reason).toContain('4 times');
    });

    it('passes rate limiting for first trigger', () => {
      const rl = new HarnessRateLimiter(CONFIG.rateLimit);
      expect(rl.canTrigger('android-operator', 'default', 'identical_retry_loop')).toBe(true);
    });

    it('generates a proposal via mock LLM', async () => {
      const surfaces = new EditableSurfaceProvider();
      surfaces.register({
        id: 'skill:android-operator:prompt', kind: 'skill_prompt',
        path: 'skills/android-operator/SKILL.md', label: 'Android Operator',
        currentValue: '# Android Operator\n1. 使用adb连接设备\n2. 查看日志\n3. 分析问题',
        mechanismFamily: 'prompt_instruction',
      });
      surfaces.register({
        id: 'global:failure_recovery_instruction', kind: 'failure_recovery_instruction',
        path: 'config:failure', label: 'Failure Recovery',
        currentValue: 'If a tool fails, inspect the error and try again.',
        mechanismFamily: 'prompt_instruction',
      });

      let callCount = 0;
      const mockLLM = async (_sys: string, _msg: string): Promise<string> => {
        callCount++;
        if (callCount === 1) {
          return JSON.stringify({
            terminal_cause: 'identical_retry_loop', criticality: 'root_cause',
            agent_mechanism: 'prompt_instruction',
            reasoning: 'Agent retried adb connect 4x despite unauthorized errors.',
            recommended_surface: 'skill:android-operator:prompt', confidence: 0.88,
          });
        }
        return JSON.stringify({
          title: '添加设备授权状态检查',
          summary: '在 adb connect 之前检查设备授权状态。',
          before: '1. 使用adb连接设备',
          after: '1. 先执行 adb devices 检查授权\n2. 如 unauthorized 则提示用户确认\n3. 确认后再 adb connect',
          expected_effect: '减少 adb unauthorized 重试 85%',
          regression_risk: 'low', confidence: 0.85, affected_scope: '仅 android-operator skill',
        });
      };

      const optimizer = new HarnessOptimizer(CONFIG.proposal, surfaces, mockLLM);
      const ctx: FailureContext = {
        sessionId: 'sim-001', skillId: 'android-operator', taskMessage: 'debug',
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
        durationMs: 3000, terminatedEarly: false, agentEndReason: 'complete',
      };
      (ctx as any).pattern = 'identical_retry_loop';

      const proposal = await optimizer.optimize(ctx);
      expect(proposal).not.toBeNull();
      expect(proposal!.title).toContain('授权');
      expect(proposal!.confidence).toBeGreaterThan(0.8);
    });

    it('evaluates to auto_apply policy for low-risk single-skill change', () => {
      const ap = new ApprovalPolicy();
      const proposal: ImprovementProposal = {
        id: 'prop-sim-001', skillId: 'android-operator', agentId: null,
        type: 'prompt_text', title: '添加设备检查',
        summary: 'Add device authorization check before adb connect.',
        diff: { surface: 'skills/android-operator/SKILL.md', before: '使用adb连接', after: '先检查授权再连接' },
        impact: { scope: '仅 android-operator skill', riskLevel: 'low', expectedEffect: '减少错误85%' },
        expectedEffect: '减少错误85%', regressionRisk: 'low',
        affectedScope: '仅 android-operator skill', mechanismFamily: 'prompt_instruction',
        confidence: 0.85, createdAt: Date.now(),
      };
      const result = ap.evaluate(proposal, { skillId: 'android-operator', currentTime: new Date() });
      expect(result.action).toBe('auto_apply');
      expect(result.autoRollback).toBeDefined();
    });

    it('completes observation window → monitor cleared', () => {
      const monitor = new AutoApplyMonitor();
      monitor.watch('prop-sim-001', 'android-operator', null, {
        satisfactionThreshold: 0.6, observationWindow: 3, errorRateMultiplier: 2.0,
      }, 'commitsim001');

      for (let i = 0; i < 3; i++) {
        monitor.onActivationComplete('android-operator', null, {
          success: true, errorCount: 0, durationMs: 2000,
        });
      }
      expect(monitor.getActiveMonitors().length).toBe(0);
    });
  });

  // ── Scenario 2: Successful session → no trigger ──────────────────────────

  describe('Scenario 2: Successful File Operations', () => {
    it('does not trigger for normal successful execution', () => {
      const fd = new FailureDetector(CONFIG.trigger);
      const ctx: FailureContext = {
        sessionId: 'sim-002', taskMessage: '读取配置生成报告',
        toolCalls: [
          { name: 'file_read', args: { path: '/etc/config.yaml' }, isError: false, timestamp: 1000 },
          { name: 'file_read', args: { path: '/tmp/data.json' }, isError: false, timestamp: 2000 },
          { name: 'write', args: { path: '/tmp/report.md' }, isError: false, timestamp: 3000 },
          { name: 'shell', args: { cmd: 'wc -l /tmp/report.md' }, isError: false, timestamp: 4000 },
        ],
        errors: [], durationMs: 4000, terminatedEarly: false, agentEndReason: 'complete',
      };
      expect(fd.detect(ctx)).toBeNull();
    });
  });

  // ── Scenario 3: Tool error cascade ───────────────────────────────────────

  describe('Scenario 3: Tool Error Cascade', () => {
    it('detects 4 consecutive tool errors across different tools', () => {
      const fd = new FailureDetector(CONFIG.trigger);
      const ctx: FailureContext = {
        sessionId: 'sim-003', taskMessage: '搜索并写入',
        toolCalls: [
          { name: 'web_search', args: { query: 'news' }, isError: true, errorMessage: 'rate limit', timestamp: 1000 },
          { name: 'web_fetch', args: { url: 'https://x.com' }, isError: true, errorMessage: 'refused', timestamp: 2000 },
          { name: 'shell', args: { cmd: 'curl x.com' }, isError: true, errorMessage: 'no host', timestamp: 3000 },
          { name: 'file_read', args: { path: '/tmp/x.txt' }, isError: true, errorMessage: 'ENOENT', timestamp: 4000 },
        ],
        errors: [
          { toolName: 'web_search', message: 'rate limit', timestamp: 1000 },
          { toolName: 'web_fetch', message: 'refused', timestamp: 2000 },
          { toolName: 'shell', message: 'no host', timestamp: 3000 },
          { toolName: 'file_read', message: 'ENOENT', timestamp: 4000 },
        ],
        durationMs: 4000, terminatedEarly: false, agentEndReason: 'error',
      };
      const signal = fd.detect(ctx);
      expect(signal).not.toBeNull();
      expect(signal!.pattern).toBe('tool_error_cascade'); // 4 consecutive different tool errors
    });
  });

  // ── Scenario 4: Exploration without output ───────────────────────────────

  describe('Scenario 4: Exploration Without Output', () => {
    it('detects 9 exploration steps with zero change steps', () => {
      const fd = new FailureDetector(CONFIG.trigger);
      const tools: ToolCallRecord[] = [
        'file_read', 'glob', 'grep', 'codegraph_explore', 'file_read',
        'web_search', 'ls', 'find', 'cat',
      ].map((name, i) => ({
        name, args: {}, isError: false, timestamp: (i + 1) * 1000,
      }));

      const ctx: FailureContext = {
        sessionId: 'sim-004', taskMessage: '分析项目',
        toolCalls: tools, errors: [],
        durationMs: 9000, terminatedEarly: false, agentEndReason: 'complete',
      };
      const signal = fd.detect(ctx);
      expect(signal).not.toBeNull();
      expect(signal!.pattern).toBe('exploration_without_output');
    });

    it('does NOT trigger with 7 explore + 1 change step', () => {
      const fd = new FailureDetector(CONFIG.trigger);
      const tools: ToolCallRecord[] = [
        ...Array.from({ length: 7 }, (_, i) => ({
          name: 'file_read', args: {}, isError: false, timestamp: (i + 1) * 1000,
        })),
        { name: 'write', args: { path: '/tmp/out.txt' }, isError: false, timestamp: 8000 },
      ];

      const ctx: FailureContext = {
        sessionId: 'sim-005', taskMessage: 'read then write',
        toolCalls: tools, errors: [],
        durationMs: 8000, terminatedEarly: false, agentEndReason: 'complete',
      };
      expect(fd.detect(ctx)).toBeNull();
    });
  });

  // ── Scenario 5: User dissatisfied → immediate high severity ──────────────

  describe('Scenario 5: User Dissatisfied', () => {
    it('detects user_explicit_dissatisfied even with only 1 tool call', () => {
      const fd = new FailureDetector(CONFIG.trigger);
      const ctx: FailureContext = {
        sessionId: 'sim-006', taskMessage: 'do something',
        toolCalls: [{ name: 'shell', args: {}, isError: false, timestamp: 1000 }],
        errors: [],
        userFeedback: 'dissatisfied',
        durationMs: 1000, terminatedEarly: false, agentEndReason: 'complete',
      };
      const signal = fd.detect(ctx);
      expect(signal).not.toBeNull();
      expect(signal!.pattern).toBe('user_explicit_dissatisfied');
      expect(signal!.severity).toBe('high');
    });
  });
});
