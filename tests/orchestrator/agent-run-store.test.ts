import { describe, it, expect } from 'vitest';
import { InMemoryAgentRunStore } from '../../src/orchestrator/agent-run-store.js';
import type { CreateAgentRunInput } from '../../src/orchestrator/types.js';
import { DEFAULT_POLICY_SCOPE } from '../../src/policy/types.js';

function makeInput(overrides?: Partial<CreateAgentRunInput>): CreateAgentRunInput {
  return {
    agentId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    rootSessionId: 'session-test-1',
    role: 'primary',
    scope: DEFAULT_POLICY_SCOPE,
    prompt: 'test prompt',
    ...overrides,
  };
}

describe('InMemoryAgentRunStore', () => {
  it('create stores an AgentRun and returns it', () => {
    const store = new InMemoryAgentRunStore();
    const input = makeInput();
    const run = store.create(input);

    expect(run.agentId).toBe(input.agentId);
    expect(run.rootSessionId).toBe('session-test-1');
    expect(run.role).toBe('primary');
    expect(run.status).toBe('pending');
    expect(run.createdAt).toBeGreaterThan(0);
    expect(run.parentAgentId).toBeUndefined();
  });

  it('create accepts optional parentAgentId', () => {
    const store = new InMemoryAgentRunStore();
    const input = makeInput({ parentAgentId: 'parent-1', role: 'child' });
    const run = store.create(input);

    expect(run.parentAgentId).toBe('parent-1');
    expect(run.role).toBe('child');
  });

  it('get returns undefined for unknown agentId', () => {
    const store = new InMemoryAgentRunStore();
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('get returns the stored AgentRun', () => {
    const store = new InMemoryAgentRunStore();
    const input = makeInput();
    const created = store.create(input);
    const retrieved = store.get(created.agentId);

    expect(retrieved).toBeDefined();
    expect(retrieved!.agentId).toBe(created.agentId);
    expect(retrieved!.status).toBe('pending');
  });

  it('update patches fields and returns the updated run', () => {
    const store = new InMemoryAgentRunStore();
    const run = store.create(makeInput());
    const updated = store.update(run.agentId, { status: 'running', startedAt: Date.now() });

    expect(updated).toBeDefined();
    expect(updated!.status).toBe('running');
    expect(updated!.startedAt).toBeGreaterThan(0);
    expect(updated!.createdAt).toBe(run.createdAt);
  });

  it('update returns undefined for unknown agentId', () => {
    const store = new InMemoryAgentRunStore();
    expect(store.update('nonexistent', { status: 'running' })).toBeUndefined();
  });

  it('supports status transition from pending -> running -> completed', () => {
    const store = new InMemoryAgentRunStore();
    const run = store.create(makeInput());

    expect(run.status).toBe('pending');

    store.update(run.agentId, { status: 'running', startedAt: Date.now() });
    expect(store.get(run.agentId)!.status).toBe('running');

    store.update(run.agentId, { status: 'completed', finishedAt: Date.now(), statusDetail: 'done' });
    const final = store.get(run.agentId)!;
    expect(final.status).toBe('completed');
    expect(final.statusDetail).toBe('done');
    expect(final.finishedAt).toBeGreaterThan(0);
  });

  it('listBySession returns only runs for the given session', () => {
    const store = new InMemoryAgentRunStore();
    const s1 = 'session-a';
    const s2 = 'session-b';

    store.create(makeInput({ agentId: 'a1', rootSessionId: s1 }));
    store.create(makeInput({ agentId: 'a2', rootSessionId: s1 }));
    store.create(makeInput({ agentId: 'b1', rootSessionId: s2 }));

    expect(store.listBySession(s1)).toHaveLength(2);
    expect(store.listBySession(s2)).toHaveLength(1);
  });

  it('listByParent returns only children of the given parent', () => {
    const store = new InMemoryAgentRunStore();
    store.create(makeInput({ agentId: 'parent-1', rootSessionId: 's' }));
    store.create(makeInput({ agentId: 'child-1', parentAgentId: 'parent-1', role: 'child', rootSessionId: 's' }));
    store.create(makeInput({ agentId: 'child-2', parentAgentId: 'parent-1', role: 'child', rootSessionId: 's' }));
    store.create(makeInput({ agentId: 'other', parentAgentId: 'parent-2', role: 'child', rootSessionId: 's' }));

    expect(store.listByParent('parent-1')).toHaveLength(2);
    expect(store.listByParent('parent-2')).toHaveLength(1);
    expect(store.listByParent('nonexistent')).toHaveLength(0);
  });

  it('delete removes the run and returns true', () => {
    const store = new InMemoryAgentRunStore();
    const run = store.create(makeInput());
    expect(store.get(run.agentId)).toBeDefined();
    expect(store.delete(run.agentId)).toBe(true);
    expect(store.get(run.agentId)).toBeUndefined();
  });

  it('delete returns false for nonexistent agentId', () => {
    const store = new InMemoryAgentRunStore();
    expect(store.delete('nonexistent')).toBe(false);
  });
});
