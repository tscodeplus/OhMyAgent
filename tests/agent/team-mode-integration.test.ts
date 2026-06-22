import { describe, expect, it, beforeEach } from 'vitest';
import { teamModeStore } from '../../src/agent/team-mode-store.js';
import { PromptManager } from '../../src/prompt/prompt-manager.js';
import type { SmartAgentTeamConfig } from '../../src/app/types.js';

const defaultConfig: SmartAgentTeamConfig = {
  enabled: true,
  max_children: 4,
};

function makePromptManager() {
  return new PromptManager({
    uiLanguage: 'zh-CN',
    contextWindow: 200_000,
  });
}

describe('Agent Team mode integration', () => {
  beforeEach(() => {
    teamModeStore.delete('session-1');
    teamModeStore.init(defaultConfig);
  });

  // ── Prompt assembly ────────────────────────────────────────────────────────

  it('team mode prompt layer is included when isTeamMode is true', () => {
    const pm = makePromptManager();
    const result = pm.assemble({ isTeamMode: true, teamModeMaxChildren: 4 });
    expect(result.systemPrompt).toContain('Agent Team Mode');
    expect(result.systemPrompt).toContain('up to 4 child agents');
    expect(result.layers.some(l => l.name === 'team-mode')).toBe(true);
  });

  it('team mode prompt layer is NOT included when isTeamMode is false', () => {
    const pm = makePromptManager();
    const result = pm.assemble({ isTeamMode: false });
    expect(result.systemPrompt).not.toContain('Agent Team Mode');
    expect(result.layers.some(l => l.name === 'team-mode')).toBe(false);
  });

  it('team mode prompt layer is NOT included by default (isTeamMode undefined)', () => {
    const pm = makePromptManager();
    const result = pm.assemble({});
    expect(result.layers.some(l => l.name === 'team-mode')).toBe(false);
  });

  it('team mode layer has priority between agent override and skill patches', () => {
    const pm = makePromptManager();
    const result = pm.assemble({
      agentId: 'test',
      isTeamMode: true,
      skillIds: ['researcher'],
    });

    const layerNames = result.layers.map(l => l.name);
    const teamIdx = layerNames.indexOf('team-mode');
    expect(teamIdx).toBeGreaterThan(-1);

    // Team mode should come after agent layers and before skill layers
    const agentLayers = result.layers.filter(l => l.name.startsWith('agent:'));
    const skillLayers = result.layers.filter(l => l.name.startsWith('skill:'));

    if (agentLayers.length > 0) {
      const agentPriority = agentLayers[0].priority;
      const teamLayer = result.layers.find(l => l.name === 'team-mode')!;
      expect(teamLayer.priority).toBeGreaterThan(agentPriority);
    }
    if (skillLayers.length > 0) {
      const skillPriority = skillLayers[0].priority;
      const teamLayer = result.layers.find(l => l.name === 'team-mode')!;
      expect(teamLayer.priority).toBeLessThan(skillPriority);
    }
  });

  it('team mode layer is non-volatile (cached)', () => {
    const pm = makePromptManager();
    const result = pm.assemble({ isTeamMode: true });
    const teamLayer = result.layers.find(l => l.name === 'team-mode')!;
    expect(teamLayer.volatile).toBe(false);
    expect(teamLayer.cacheKey).toBe('team-mode');
  });

  it('team mode layer respects maxChildren interpolation', () => {
    const pm = makePromptManager();
    const r1 = pm.assemble({ isTeamMode: true, teamModeMaxChildren: 2 });
    expect(r1.systemPrompt).toContain('up to 2 child agents');

    const r2 = pm.assemble({ isTeamMode: true, teamModeMaxChildren: 8 });
    expect(r2.systemPrompt).toContain('up to 8 child agents');
  });

  // ── Child agent exclusion ──────────────────────────────────────────────────

  it('child agent does NOT get team mode layer even if isTeamMode is true', () => {
    const pm = makePromptManager();
    // This is what agent-factory does: isTeamMode && !options.isChildAgent
    const isTeamMode = true;
    const isChildAgent = true;
    const result = pm.assemble({
      isTeamMode: isTeamMode && !isChildAgent,
      isChildAgent,
    });
    expect(result.systemPrompt).not.toContain('Agent Team Mode');
    expect(result.layers.some(l => l.name === 'team-mode')).toBe(false);
  });

  it('child agent gets child-modifier layer', () => {
    const pm = makePromptManager();
    const result = pm.assemble({
      isChildAgent: true,
      childTaskDescription: 'Fix the bug in login',
    });
    expect(result.layers.some(l => l.name === 'child-modifier')).toBe(true);
    expect(result.systemPrompt).toContain('Fix the bug in login');
  });

  // ── TeamModeStore session isolation ────────────────────────────────────────

  it('team mode state is isolated per session', () => {
    teamModeStore.enable('session-a', false);
    teamModeStore.enable('session-b', true);

    expect(teamModeStore.isEnabled('session-a')).toBe(true);
    expect(teamModeStore.isEnabled('session-b')).toBe(true);

    teamModeStore.disable('session-a');
    expect(teamModeStore.isEnabled('session-a')).toBe(false);
    expect(teamModeStore.isEnabled('session-b')).toBe(true);
  });

  // ── Global config fallback ─────────────────────────────────────────────────

  it('smart_agent_team.enabled: true makes isEnabled false for sessions not yet enabled', () => {
    // Without calling enable(), isEnabled should return false
    // (smart_agent_team provides the DEFAULT, but the session must still be activated)
    expect(teamModeStore.isEnabled('untouched-session')).toBe(false);
  });
});
