import { describe, it, expect } from 'vitest';
import { FrontmatterSchema } from '../../src/skills/skill-loader.js';

describe('FrontmatterSchema', () => {
  const validFrontmatter = {
    name: 'test-skill',
    description: 'A test skill for validation',
  };

  it('accepts a valid minimal frontmatter', () => {
    const result = FrontmatterSchema.parse(validFrontmatter);
    expect(result.name).toBe('test-skill');
    expect(result.description).toBe('A test skill for validation');
  });

  it('accepts a full frontmatter with all optional fields', () => {
    const full = {
      name: 'my-skill',
      description: 'Does useful things',
      license: 'MIT',
      compatibility: 'requires python3',
      metadata: { version: '1.0.0', author: 'alice', tags: ['test'] },
      'allowed-tools': 'shell file-read',
    };
    const result = FrontmatterSchema.parse(full);
    expect(result.name).toBe('my-skill');
    expect(result.license).toBe('MIT');
    expect(result.metadata).toEqual({ version: '1.0.0', author: 'alice', tags: ['test'] });
    expect(result['allowed-tools']).toBe('shell file-read');
  });

  it('rejects missing name', () => {
    expect(() => FrontmatterSchema.parse({ description: 'no name' })).toThrow();
  });

  it('rejects name over 64 characters', () => {
    expect(() => FrontmatterSchema.parse({
      name: 'a'.repeat(65),
      description: 'valid description',
    })).toThrow();
  });

  it('rejects missing description', () => {
    expect(() => FrontmatterSchema.parse({ name: 'test' })).toThrow();
  });

  it('rejects description over 1024 characters', () => {
    expect(() => FrontmatterSchema.parse({
      name: 'test',
      description: 'x'.repeat(1025),
    })).toThrow();
  });

  it('allows unknown fields via passthrough', () => {
    const result = FrontmatterSchema.parse({
      ...validFrontmatter,
      'some-future-field': 'value',
      anotherField: 42,
    });
    expect(result.name).toBe('test-skill');
  });

  it('allows empty metadata', () => {
    const result = FrontmatterSchema.parse({
      ...validFrontmatter,
      metadata: {},
    });
    expect(result.metadata).toEqual({});
  });

  it('allows no allowed-tools', () => {
    const result = FrontmatterSchema.parse(validFrontmatter);
    expect(result['allowed-tools']).toBeUndefined();
  });
});
