import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistryImpl } from '../../src/tools/registry';

function makeTool(name: string) {
  return {
    name,
    label: name,
    description: `Tool ${name}`,
    parameters: {},
    execute: async () => ({ content: 'ok' }),
  };
}

describe('ToolRegistryImpl', () => {
  let registry: ToolRegistryImpl;

  beforeEach(() => {
    registry = new ToolRegistryImpl();
  });

  it('registers and retrieves a tool', () => {
    const tool = makeTool('test');
    registry.register(tool);
    expect(registry.get('test')).toBe(tool);
  });

  it('overwrites on duplicate registration', () => {
    const tool1 = makeTool('test');
    const tool2 = makeTool('test');
    registry.register(tool1);
    registry.register(tool2);
    expect(registry.get('test')).toBe(tool2);
  });

  it('returns undefined for missing tool', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('lists all tools', () => {
    registry.register(makeTool('a'));
    registry.register(makeTool('b'));
    registry.register(makeTool('c'));
    expect(registry.list()).toHaveLength(3);
  });

  it('has() returns true/false correctly', () => {
    registry.register(makeTool('test'));
    expect(registry.has('test')).toBe(true);
    expect(registry.has('other')).toBe(false);
  });

  it('unregister removes a tool', () => {
    registry.register(makeTool('test'));
    registry.unregister('test');
    expect(registry.has('test')).toBe(false);
    expect(registry.get('test')).toBeUndefined();
  });

  it('names() returns all tool names', () => {
    registry.register(makeTool('alpha'));
    registry.register(makeTool('beta'));
    expect(registry.names()).toEqual(expect.arrayContaining(['alpha', 'beta']));
  });

  it('listAsAgentTools returns same as list', () => {
    registry.register(makeTool('test'));
    expect(registry.listAsAgentTools()).toEqual(registry.list());
  });
});
