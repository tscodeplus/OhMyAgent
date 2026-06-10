// ---------------------------------------------------------------------------
// Threshold gate tests
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { Type } from 'typebox';
import { estimateTokens, shouldActivate } from '../../../src/tools/tool-search/threshold.js';
import type { ToolSearchConfig } from '../../../src/tools/tool-search/config.js';
import type { AgentTool } from '../../../src/pi-mono/agent/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agentTool(name: string, description: string = 'A test tool', numParams: number = 0): AgentTool {
  const props: Record<string, any> = {};
  for (let i = 0; i < numParams; i++) {
    props[`param_${i}`] = Type.String();
  }
  return {
    name,
    label: name,
    description,
    parameters: Type.Object(props),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  };
}

function defaultConfig(overrides: Partial<ToolSearchConfig> = {}): ToolSearchConfig {
  return {
    enabled: 'auto',
    thresholdPct: 10,
    searchDefaultLimit: 5,
    maxSearchLimit: 20,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  it('returns 0 for empty tools array', () => {
    expect(estimateTokens([])).toBe(0);
  });

  it('returns a positive number for a single tool', () => {
    const t = agentTool('test_tool', 'A tool for testing');
    expect(estimateTokens([t])).toBeGreaterThan(0);
  });

  it('scales roughly linearly with number of tools', () => {
    const one = [agentTool('a', 'desc')];
    const ten = Array.from({ length: 10 }, (_, i) => agentTool(`tool_${i}`, `description for tool ${i}`));
    const oneEst = estimateTokens(one);
    const tenEst = estimateTokens(ten);
    // ten tools should estimate at least 5× one tool
    expect(tenEst).toBeGreaterThan(oneEst * 5);
  });

  it('complex params increase token estimate', () => {
    const simple = agentTool('simple', 'desc', 0);
    const complex = agentTool('complex', 'desc', 10);
    expect(estimateTokens([complex])).toBeGreaterThan(estimateTokens([simple]));
  });
});

// ---------------------------------------------------------------------------
// shouldActivate
// ---------------------------------------------------------------------------

describe('shouldActivate', () => {
  it('returns false when enabled is "off"', () => {
    const cfg = defaultConfig({ enabled: 'off' });
    expect(shouldActivate(cfg, 1_000_000, 200_000)).toBe(false);
  });

  it('returns false when deferrableTokens is 0', () => {
    const cfg = defaultConfig({ enabled: 'on' });
    expect(shouldActivate(cfg, 0, 200_000)).toBe(false);
  });

  it('returns false when deferrableTokens is negative', () => {
    const cfg = defaultConfig({ enabled: 'on' });
    expect(shouldActivate(cfg, -1, 200_000)).toBe(false);
  });

  it('returns true when enabled is "on" and there are deferrable tools', () => {
    const cfg = defaultConfig({ enabled: 'on' });
    expect(shouldActivate(cfg, 100, 200_000)).toBe(true);
  });

  it('auto: below threshold returns false', () => {
    const cfg = defaultConfig({ enabled: 'auto', thresholdPct: 10 });
    // 5% of 200K = 10_000 tokens. 5_000 < 10_000 → skip
    expect(shouldActivate(cfg, 5_000, 200_000)).toBe(false);
  });

  it('auto: at threshold returns true', () => {
    const cfg = defaultConfig({ enabled: 'auto', thresholdPct: 10 });
    // 10% of 200K = 20_000 tokens. 20_000 >= 20_000 → activate
    expect(shouldActivate(cfg, 20_000, 200_000)).toBe(true);
  });

  it('auto: above threshold returns true', () => {
    const cfg = defaultConfig({ enabled: 'auto', thresholdPct: 10 });
    expect(shouldActivate(cfg, 50_000, 200_000)).toBe(true);
  });

  it('auto: uses fallback cutoff when contextLength is 0', () => {
    const cfg = defaultConfig({ enabled: 'auto', thresholdPct: 10 });
    // Fallback = 20_000 tokens
    expect(shouldActivate(cfg, 10_000, 0)).toBe(false);
    expect(shouldActivate(cfg, 25_000, 0)).toBe(true);
  });

  it('auto: uses fallback cutoff when contextLength is negative', () => {
    const cfg = defaultConfig({ enabled: 'auto' });
    expect(shouldActivate(cfg, 25_000, -1)).toBe(true);
  });

  it('auto: small threshold percentage lowers the bar', () => {
    const cfg = defaultConfig({ enabled: 'auto', thresholdPct: 5 });
    // 5% of 200K = 10_000 tokens
    expect(shouldActivate(cfg, 12_000, 200_000)).toBe(true);
  });

  it('auto: 100% threshold requires exceeding entire context', () => {
    const cfg = defaultConfig({ enabled: 'auto', thresholdPct: 100 });
    // 100% of 200K = 200_000
    expect(shouldActivate(cfg, 199_000, 200_000)).toBe(false);
    expect(shouldActivate(cfg, 200_000, 200_000)).toBe(true);
  });
});
