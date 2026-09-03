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
    expect(PROFILE_TOOLS.full).not.toContain('computer_use'); // full is an empty allowlist; computer_use is scope-gated
    expect(PROFILE_TOOLS.restricted).not.toContain('computer_use');
    expect(PROFILE_TOOLS.standard).not.toContain('computer_use');
  });

  it('ToolVisibilityPolicy allows computer_use for standard scope when computerUseEnabled is true', () => {
    expect(visibility.isVisible('computer_use', makeScope('standard'))).toBe(true);
  });

  it('ToolVisibilityPolicy allows computer_use for full scope when computerUseEnabled is true', () => {
    expect(visibility.isVisible('computer_use', makeScope('full'))).toBe(true);
  });

  it('ToolVisibilityPolicy allows computer_use for restricted scope when computerUseEnabled is true', () => {
    expect(visibility.isVisible('computer_use', makeScope('restricted'))).toBe(true);
  });

  it('ToolVisibilityPolicy rejects computer_use when computerUseEnabled is false regardless of profile', () => {
    const scope = makeScope('full');
    scope.computerUseEnabled = false;
    expect(visibility.isVisible('computer_use', scope)).toBe(false);
  });
});
