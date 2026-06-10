import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToTypeBox } from '../../src/tools/tool-adapter';

describe('zodToTypeBox', () => {
  it('converts string schema', () => {
    const zodSchema = z.string();
    const tbSchema = zodToTypeBox(zodSchema);
    expect(tbSchema).toBeDefined();
    expect(tbSchema.type).toBe('string');
  });

  it('converts number schema', () => {
    const zodSchema = z.number();
    const tbSchema = zodToTypeBox(zodSchema);
    expect(tbSchema.type).toBe('number');
  });

  it('converts boolean schema', () => {
    const zodSchema = z.boolean();
    const tbSchema = zodToTypeBox(zodSchema);
    expect(tbSchema.type).toBe('boolean');
  });

  it('converts object schema', () => {
    const zodSchema = z.object({
      name: z.string(),
      age: z.number(),
    });
    const tbSchema = zodToTypeBox(zodSchema);
    expect(tbSchema.type).toBe('object');
    expect(tbSchema.properties).toBeDefined();
    expect(tbSchema.properties.name).toBeDefined();
    expect(tbSchema.properties.age).toBeDefined();
  });

  it('converts array schema', () => {
    const zodSchema = z.array(z.string());
    const tbSchema = zodToTypeBox(zodSchema);
    expect(tbSchema.type).toBe('array');
  });

  it('converts optional fields', () => {
    const zodSchema = z.object({
      name: z.string(),
      nickname: z.string().optional(),
    });
    const tbSchema = zodToTypeBox(zodSchema);
    expect(tbSchema.required).toContain('name');
  });

  it('converts nested objects', () => {
    const zodSchema = z.object({
      user: z.object({
        name: z.string(),
        email: z.string().email(),
      }),
    });
    const tbSchema = zodToTypeBox(zodSchema);
    expect(tbSchema.properties.user).toBeDefined();
    expect(tbSchema.properties.user.type).toBe('object');
  });

  it('converts enum', () => {
    const zodSchema = z.enum(['a', 'b', 'c']);
    const tbSchema = zodToTypeBox(zodSchema);
    expect(tbSchema.enum || tbSchema.anyOf).toBeDefined();
  });
});
