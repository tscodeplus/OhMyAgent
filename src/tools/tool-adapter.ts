import { Type, type TSchema } from 'typebox';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodSchema } from 'zod';

/**
 * Convert a zod schema to a TypeBox schema.
 * Uses zod-to-json-schema as intermediate representation,
 * then wraps with Type.Unsafe().
 */
export function zodToTypeBox(schema: ZodSchema): TSchema {
  const jsonSchema = zodToJsonSchema(schema, { target: 'openApi3' });
  return Type.Unsafe(jsonSchema);
}
