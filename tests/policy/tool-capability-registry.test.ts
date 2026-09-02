import { describe, expect, it } from 'vitest';
import {
  approvalRiskForTool,
  getCapabilityForTool,
} from '../../src/policy/tool-capability-registry.js';

describe('getCapabilityForTool', () => {
  it('unknown tools fail closed: mutating + read_write + approval required', () => {
    const cap = getCapabilityForTool('brand_new_tool_nobody_registered');
    expect(cap.readOnly).toBe(false);
    expect(cap.writesFiles).toBe(true);
    expect(cap.pathAccess).toBe('read_write');
    expect(cap.approvalDefault).toBe('mutating');
  });

  it('shell is mutating with shell access', () => {
    const cap = getCapabilityForTool('shell');
    expect(cap.usesShell).toBe(true);
    expect(cap.approvalDefault).toBe('mutating');
  });

  it('send_message with external route is high_risk regardless of base capability', () => {
    const external = getCapabilityForTool('send_message', { route: 'external' });
    expect(external.approvalDefault).toBe('high_risk');
    // internal (default) route keeps the normal descriptor
    const internal = getCapabilityForTool('send_message', { route: 'internal' });
    expect(internal.approvalDefault).not.toBe('high_risk');
    const noArgs = getCapabilityForTool('send_message');
    expect(noArgs.approvalDefault).not.toBe('high_risk');
  });

  it('cronjob remove action is mutating (destructive), other actions are not', () => {
    expect(getCapabilityForTool('cronjob', { action: 'remove' }).approvalDefault).toBe('mutating');
    expect(getCapabilityForTool('cronjob', { action: 'list' }).approvalDefault).not.toBe(
      'mutating',
    );
    expect(getCapabilityForTool('cronjob').approvalDefault).not.toBe('mutating');
  });

  it('registered read-only tools stay read-only with no default approval', () => {
    const cap = getCapabilityForTool('web_fetch');
    expect(cap.readOnly).toBe(true);
    expect(cap.usesNetwork).toBe(true);
    expect(cap.approvalDefault).toBe('none');
  });

  it('computer_use is flagged as computer-use capable', () => {
    expect(getCapabilityForTool('computer_use').usesComputerUse).toBe(true);
  });
});

describe('approvalRiskForTool', () => {
  it('high_risk approvalDefault and computer-use tools map to high', () => {
    expect(approvalRiskForTool('send_message', { route: 'external' })).toBe('high');
    expect(approvalRiskForTool('computer_use')).toBe('high');
  });

  it('mutating or non-read-only tools map to medium', () => {
    expect(approvalRiskForTool('shell')).toBe('medium');
    expect(approvalRiskForTool('file_edit')).toBe('medium');
    // unknown tool → fail-closed descriptor is non-read-only → medium
    expect(approvalRiskForTool('brand_new_tool_nobody_registered')).toBe('medium');
  });

  it('read-only tools map to low', () => {
    expect(approvalRiskForTool('web_fetch')).toBe('low');
  });
});
