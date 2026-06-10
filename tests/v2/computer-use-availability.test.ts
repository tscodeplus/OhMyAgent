import { describe, it, expect, vi } from 'vitest';
import dotenv from 'dotenv';
dotenv.config();

import { PROFILE_TOOLS } from '../../src/agent/agent-manager.js';
import { ToolVisibilityPolicyImpl } from '../../src/policy/tool-visibility.js';
import type { AgentPolicyScope } from '../../src/policy/types.js';

describe('computer_use channel availability', () => {
  const visibility = new ToolVisibilityPolicyImpl();

  function makeScope(profile: string): AgentPolicyScope {
    return {
      toolsProfile: profile as any,
      readRoots: [],
      writeRoots: [],
      deniedPatterns: [],
      shellExecMode: 'balanced',
      sessionApprovals: [],
      appApprovals: [],
      readOnly: false,
      computerUseEnabled: true,
    };
  }

  it('computer_use is NOT tied to any profile in PROFILE_TOOLS', () => {
    expect(PROFILE_TOOLS.advanced).not.toContain('computer_use');
    expect(PROFILE_TOOLS.standard).not.toContain('computer_use');
    expect(PROFILE_TOOLS.minimal).not.toContain('computer_use');
  });

  it('ToolVisibilityPolicy allows computer_use for standard scope when computerUseEnabled is true', () => {
    expect(visibility.isVisible('computer_use', makeScope('standard'))).toBe(true);
  });

  it('ToolVisibilityPolicy allows computer_use for advanced scope when computerUseEnabled is true', () => {
    expect(visibility.isVisible('computer_use', makeScope('advanced'))).toBe(true);
  });

  it('ToolVisibilityPolicy allows computer_use for minimal scope when computerUseEnabled is true', () => {
    expect(visibility.isVisible('computer_use', makeScope('minimal'))).toBe(true);
  });

  it('ToolVisibilityPolicy rejects computer_use when computerUseEnabled is false regardless of profile', () => {
    const scope = makeScope('advanced');
    scope.computerUseEnabled = false;
    expect(visibility.isVisible('computer_use', scope)).toBe(false);
  });
});
