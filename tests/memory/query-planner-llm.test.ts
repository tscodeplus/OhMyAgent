import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// Mock the aux LLM call so no network/model is required.
const auxLLMCall = vi.fn();
vi.mock('../../src/memory/aux-llm-client.js', () => ({
  auxLLMCall: (...args: unknown[]) => auxLLMCall(...args),
}));

import { planQueriesLLM } from '../../src/memory/query-planner-llm.js';
import type { LLMPlannerConfig } from '../../src/memory/query-planner-llm.js';

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

function cfg(overrides: Partial<LLMPlannerConfig> = {}): LLMPlannerConfig {
  return {
    enabled: true,
    maxEntities: 4,
    logger,
    auxConfig: { modelRef: 'test-model' },
    ...overrides,
  };
}

beforeEach(() => {
  auxLLMCall.mockReset();
});

describe('planQueriesLLM — disabled / no-model fallbacks', () => {
  it('returns rule-based plan when disabled, without calling the LLM', async () => {
    const plan = await planQueriesLLM('What do Jon and Gina have in common?', cfg({ enabled: false }));
    expect(auxLLMCall).not.toHaveBeenCalled();
    expect(plan.intent).toBe('commonality');
    expect(plan.entities).toEqual(['Jon', 'Gina']);
  });

  it('returns rule-based plan when no aux model is configured', async () => {
    const plan = await planQueriesLLM('What does John like?', cfg({ auxConfig: {} }));
    expect(auxLLMCall).not.toHaveBeenCalled();
    expect(plan.flatQueries.length).toBeGreaterThan(0);
  });
});

describe('planQueriesLLM — LLM path', () => {
  it('uses LLM-decided intent and entities to build slots', async () => {
    auxLLMCall.mockResolvedValue('{"intent":"commonality","entities":["jon","gina"]}');
    const plan = await planQueriesLLM('what do they share?', cfg());
    expect(plan.intent).toBe('commonality');
    expect(plan.entities).toEqual(['jon', 'gina']);
    // commonality with >=2 entities builds one slot per entity + shared
    const entitySlots = plan.slots.filter(s => s.kind === 'entity');
    expect(entitySlots).toHaveLength(2);
  });

  it('strips markdown fences before parsing', async () => {
    auxLLMCall.mockResolvedValue('```json\n{"intent":"attribute","entities":["Carol"]}\n```');
    const plan = await planQueriesLLM('what is her job?', cfg());
    expect(plan.intent).toBe('attribute');
    expect(plan.entities).toEqual(['Carol']);
  });

  it('caps entities at maxEntities', async () => {
    auxLLMCall.mockResolvedValue('{"intent":"commonality","entities":["A","B","C","D","E"]}');
    const plan = await planQueriesLLM('common?', cfg({ maxEntities: 2 }));
    expect(plan.entities).toEqual(['A', 'B']);
  });
});

describe('planQueriesLLM — robustness', () => {
  it('falls back to rule plan on unparseable output', async () => {
    auxLLMCall.mockResolvedValue('I think the intent is commonality, sorry no JSON');
    const plan = await planQueriesLLM('What do Jon and Gina have in common?', cfg());
    // rule-based plan recovers the commonality intent
    expect(plan.intent).toBe('commonality');
    expect(plan.entities).toEqual(['Jon', 'Gina']);
  });

  it('falls back to rule plan when the LLM call throws', async () => {
    auxLLMCall.mockRejectedValue(new Error('network down'));
    const plan = await planQueriesLLM('What does John like?', cfg());
    expect(plan.flatQueries.length).toBeGreaterThan(0);
    expect(logger.info).toHaveBeenCalled();
  });

  it('coerces an unknown intent to generic', async () => {
    auxLLMCall.mockResolvedValue('{"intent":"banana","entities":["John"]}');
    const plan = await planQueriesLLM('something about John', cfg());
    expect(plan.intent).toBe('generic');
  });
});
