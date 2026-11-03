import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToTypeBox as convertZodToTypeBox } from '../../src/tools/tool-adapter';
import { validateToolArguments } from '../../src/pi-mono/ai/utils/validation.js';

type SchemaView = {
  type?: string;
  properties?: Record<string, SchemaView>;
  required?: string[];
  enum?: unknown[];
  anyOf?: unknown[];
  $ref?: string;
};

const zodToTypeBox = (schema: Parameters<typeof convertZodToTypeBox>[0]): SchemaView =>
  convertZodToTypeBox(schema) as SchemaView;

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
    expect(tbSchema.properties!.name).toBeDefined();
    expect(tbSchema.properties!.age).toBeDefined();
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
    expect(tbSchema.properties!.user).toBeDefined();
    expect(tbSchema.properties!.user!.type).toBe('object');
  });

  it('converts enum', () => {
    const zodSchema = z.enum(['a', 'b', 'c']);
    const tbSchema = zodToTypeBox(zodSchema);
    expect(tbSchema.enum || tbSchema.anyOf).toBeDefined();
  });
});

describe('zodToTypeBox + pi-schema validation (v1.5.0)', () => {
  // zod-to-json-schema (openApi3 target) de-duplicates a reused sub-schema as a
  // JSON-pointer $ref into its own root ("#/properties/a"), and a recursive one
  // as the self reference "#". pi-schema compiles tool schemas with
  // `unresolvedRefs: "reject"`, so a resolver that only knows $defs would reject
  // every call of such a tool.
  const leaf = z.object({ x: z.number() }).describe('Leaf');
  const reused = z.object({ a: leaf, b: leaf });
  const recursive: z.ZodType<{ name: string; children?: unknown[] }> = z.lazy(() =>
    z.object({ name: z.string(), children: z.array(recursive).optional() }),
  ) as z.ZodType<{ name: string; children?: unknown[] }>;

  it('emits a root-pointer $ref for a reused sub-schema', () => {
    const schema = zodToTypeBox(reused) as unknown as { properties: Record<string, SchemaView> };
    expect(schema.properties.b!.$ref ?? 'none').toBe('#/properties/a');
  });

  it('resolves that $ref instead of rejecting it as dangling', () => {
    const parameters = zodToTypeBox(reused);
    const parsed = validateToolArguments(
      { name: 'reused', parameters } as never,
      { name: 'reused', arguments: { a: { x: '3' }, b: { x: 4 } } } as never,
    );
    // coercion through the $ref'd sub-schema, not a pass-through
    expect(parsed).toEqual({ a: { x: 3 }, b: { x: 4 } });
  });

  it('still rejects a wrong type reached through the $ref', () => {
    const parameters = zodToTypeBox(reused);
    expect(() =>
      validateToolArguments(
        { name: 'reused', parameters } as never,
        { name: 'reused', arguments: { a: { x: 3 }, b: { x: 'no' } } } as never,
      ),
    ).toThrow(/b.x/u);
  });

  it('resolves a recursive self $ref', () => {
    const parameters = zodToTypeBox(recursive);
    const parsed = validateToolArguments(
      { name: 'recursive', parameters } as never,
      { name: 'recursive', arguments: { name: 'root', children: [{ name: 'leaf' }] } } as never,
    );
    expect(parsed).toEqual({ name: 'root', children: [{ name: 'leaf' }] });
  });
});
