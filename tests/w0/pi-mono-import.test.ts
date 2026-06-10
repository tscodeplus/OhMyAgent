import { describe, it, expect } from 'vitest';
import { getModel, getProviders, stream } from '@earendil-works/pi-ai';
import { Agent } from '@earendil-works/pi-agent-core';

describe('pi-mono source embedding', () => {
  it('can import pi-ai core APIs', () => {
    expect(getModel).toBeTypeOf('function');
    expect(getProviders).toBeTypeOf('function');
    expect(stream).toBeTypeOf('function');
  });

  it('can import pi-agent-core Agent', () => {
    expect(Agent).toBeTypeOf('function');
  });

  it('can list providers', () => {
    const providers = getProviders();
    expect(providers.length).toBeGreaterThan(0);
  });

  it('can get deepseek model', () => {
    const model = getModel('deepseek', 'deepseek-v4-flash');
    expect(model).toBeDefined();
    expect(model.id).toBe('deepseek-v4-flash');
  });
});
