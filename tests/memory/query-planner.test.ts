import { describe, it, expect } from 'vitest';
import {
  planMemoryQueries,
  planStructuredQueries,
  extractEntities,
  extractSpeaker,
  augmentSlotQueries,
} from '../../src/memory/query-planner.js';

describe('extractEntities', () => {
  it('extracts capitalized names and filters question words', () => {
    expect(extractEntities('What martial arts has John done?')).toEqual(['John']);
  });

  it('extracts two names for commonality questions', () => {
    expect(extractEntities('How do Jon and Gina both like to destress?')).toEqual(['Jon', 'Gina']);
  });

  it('filters month/weekday capitalized tokens', () => {
    expect(extractEntities('What did Maria do on Monday in May?')).toEqual(['Maria']);
  });

  it('caps at maxEntities', () => {
    expect(extractEntities('Alice and Bob and Carol and Dave met', 2)).toEqual(['Alice', 'Bob']);
  });

  it('treats consecutive capitalized words as one multi-word name', () => {
    expect(extractEntities('What did John Smith say?')).toEqual(['John Smith']);
  });
});

describe('planStructuredQueries — intent classification', () => {
  it('classifies commonality with >=2 entities', () => {
    const plan = planStructuredQueries('How do Jon and Gina both like to destress?');
    expect(plan.intent).toBe('commonality');
    expect(plan.entities).toEqual(['Jon', 'Gina']);
    // one entity slot per name + a shared slot
    const entitySlots = plan.slots.filter(s => s.kind === 'entity');
    expect(entitySlots.map(s => s.targetSpeaker)).toEqual(['Jon', 'Gina']);
    expect(plan.slots.some(s => s.kind === 'shared')).toBe(true);
  });

  it('downgrades "both"-style to generic when fewer than 2 entities', () => {
    const plan = planStructuredQueries('What do we both have in common?');
    expect(plan.intent).toBe('generic');
  });

  it('classifies single-entity attribute lookups', () => {
    const plan = planStructuredQueries('What martial arts has John done?');
    expect(plan.intent).toBe('attribute');
    expect(plan.entities).toEqual(['John']);
    const entitySlot = plan.slots.find(s => s.kind === 'entity');
    expect(entitySlot?.targetSpeaker).toBe('John');
    expect(plan.slots.some(s => s.kind === 'base')).toBe(true);
  });

  it('classifies temporal questions', () => {
    expect(planStructuredQueries('When did Maria start volunteering?').intent).toBe('temporal');
  });

  it('classifies open-domain inference', () => {
    expect(planStructuredQueries("What might John's financial status be?").intent).toBe('open_domain');
  });

  it('falls back to single base slot for generic queries', () => {
    const plan = planStructuredQueries('Tell me about the dance studio');
    expect(plan.intent).toBe('generic');
    expect(plan.slots).toHaveLength(1);
    expect(plan.slots[0].kind).toBe('base');
  });

  it('respects disabled config', () => {
    const plan = planStructuredQueries('How do Jon and Gina both relax?', { enabled: false, maxEntities: 4 });
    expect(plan.intent).toBe('generic');
    expect(plan.entities).toEqual([]);
  });
});

describe('planMemoryQueries — regression lock', () => {
  it('keeps original-first ordering and reasons', () => {
    const planned = planMemoryQueries('What martial arts has John done?');
    expect(planned[0]).toEqual({ query: 'What martial arts has John done?', reason: 'original' });
    expect(planned.some(p => p.reason === 'entity_terms')).toBe(true);
  });
});

describe('extractSpeaker', () => {
  it('reads speaker from metadata', () => {
    expect(extractSpeaker('anything', '{"speaker":"Gina"}')).toBe('Gina');
  });

  it('parses "X said:" from content', () => {
    expect(extractSpeaker('Dataset: LoCoMo. John said: I do kickboxing.')).toBe('John');
  });

  it('returns undefined when no speaker found', () => {
    expect(extractSpeaker('no speaker here')).toBeUndefined();
  });
});


describe('augmentSlotQueries', () => {
  it('returns slot.queries unchanged when no variants (non-regression)', () => {
    const slot = { slotId: 'entity:John', kind: 'entity' as const, targetSpeaker: 'John', queries: ['John martial arts', 'John'] };
    expect(augmentSlotQueries(slot, [])).toEqual(['John martial arts', 'John']);
  });

  it('scopes variants to the target speaker for entity slots', () => {
    const slot = { slotId: 'entity:John', kind: 'entity' as const, targetSpeaker: 'John', queries: ['John'] };
    const out = augmentSlotQueries(slot, ['kickboxing training', 'karate']);
    expect(out).toContain('John kickboxing training');
    expect(out).toContain('John karate');
  });

  it('uses variants directly for shared/base slots', () => {
    const slot = { slotId: 'shared', kind: 'shared' as const, queries: ['volunteering'] };
    const out = augmentSlotQueries(slot, ['food bank donations']);
    expect(out).toContain('food bank donations');
  });

  it('caps the number of variants', () => {
    const slot = { slotId: 'base', kind: 'base' as const, queries: ['q'] };
    const out = augmentSlotQueries(slot, ['a', 'b', 'c', 'd', 'e'], 2);
    expect(out).toEqual(['q', 'a', 'b']);
  });

  it('dedups case-insensitively against existing queries', () => {
    const slot = { slotId: 'shared', kind: 'shared' as const, queries: ['Volunteering'] };
    const out = augmentSlotQueries(slot, ['volunteering', 'donations']);
    expect(out).toEqual(['Volunteering', 'donations']);
  });
});
