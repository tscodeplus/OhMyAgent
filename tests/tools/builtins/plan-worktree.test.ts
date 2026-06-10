// ---------------------------------------------------------------------------
// Tests for plan mode and worktree tool definitions
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from 'vitest';
import { createEnterPlanModeToolDefinition } from '../../../src/tools/builtins/session/enter-plan-definition.js';
import { createExitPlanModeToolDefinition } from '../../../src/tools/builtins/session/exit-plan-definition.js';
import { sessionMetadata } from '../../../src/tools/builtins/session/shared-metadata.js';
import { extractToolText, expectToolResultContains } from '../../helpers/tool-result.js';
import type { ToolExecutionContext } from '../../../src/tools/platform/tool-context.js';

const enterPlanDef = createEnterPlanModeToolDefinition();
const exitPlanDef = createExitPlanModeToolDefinition();

function minimalCtx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    cwd: '/tmp',
    sessionId: 'test-session',
    agentId: 'agent-1',
    policyScope: { agentId: 'agent-1' } as any,
    services: {} as any,
    ...overrides,
  };
}

describe('plan_mode tools', () => {
  beforeEach(() => {
    sessionMetadata.clear();
  });

  describe('enter_plan_mode', () => {
    it('sets planMode flag in session metadata', async () => {
      const result = await enterPlanDef.execute({}, minimalCtx());
      expect(result.isError).toBeFalsy();
      expectToolResultContains(result, 'Entered plan mode');
      const meta = sessionMetadata.get('test-session');
      expect(meta).toBeDefined();
      expect(meta!.planMode).toBe(true);
    });

    it('preserves existing metadata when entering plan mode', async () => {
      sessionMetadata.set('test-session', { existingKey: 'existing-value' });
      const result = await enterPlanDef.execute({}, minimalCtx());
      expect(result.isError).toBeFalsy();
      const meta = sessionMetadata.get('test-session');
      expect(meta!.existingKey).toBe('existing-value');
      expect(meta!.planMode).toBe(true);
    });
  });

  describe('exit_plan_mode', () => {
    it('clears planMode flag in session metadata', async () => {
      sessionMetadata.set('test-session', { planMode: true });
      const result = await exitPlanDef.execute({}, minimalCtx());
      expect(result.isError).toBeFalsy();
      expectToolResultContains(result, 'Exited plan mode');
      const meta = sessionMetadata.get('test-session');
      expect(meta!.planMode).toBe(false);
    });

    it('returns a message when not in plan mode', async () => {
      const result = await exitPlanDef.execute({}, minimalCtx());
      expect(result.isError).toBeFalsy();
      expectToolResultContains(result, 'Not in plan mode');
    });
  });
});
