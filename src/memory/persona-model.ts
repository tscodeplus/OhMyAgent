import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// ---------------------------------------------------------------------------
// UserPersona interface
// ---------------------------------------------------------------------------

export interface UserPersona {
  version: number;
  lastUpdated: string; // ISO 8601
  summary: string;

  preferences: {
    tools: string[];
    languages: string[];
    workflows: string[];
    communication: string;
  };

  skills: {
    known: string[];
    learning: string[];
  };

  context: {
    device: string;
    environment: string;
    timezone: string;
    activeProjects: string[];
  };

  stats: {
    totalSessions: number;
    totalMessages: number;
    lastActive: string; // ISO 8601
  };
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const preferencesSchema = z.object({
  tools: z.array(z.string()).default([]),
  languages: z.array(z.string()).default([]),
  workflows: z.array(z.string()).default([]),
  communication: z.string().default(''),
});

const skillsSchema = z.object({
  known: z.array(z.string()).default([]),
  learning: z.array(z.string()).default([]),
});

const contextSchema = z.object({
  device: z.string().default(''),
  environment: z.string().default(''),
  timezone: z.string().default(''),
  activeProjects: z.array(z.string()).default([]),
});

const statsSchema = z.object({
  totalSessions: z.number().int().nonnegative().default(0),
  totalMessages: z.number().int().nonnegative().default(0),
  lastActive: z.string().default(''),
});

/**
 * Full JSON Schema for UserPersona (zod object).
 * Used for validation and as the basis for LLM structured output definitions.
 */
export const personaJsonSchema = z.object({
  version: z.number().int().positive().default(1),
  lastUpdated: z.string().default(''),
  summary: z.string().default(''),
  preferences: preferencesSchema.default({}),
  skills: skillsSchema.default({}),
  context: contextSchema.default({}),
  stats: statsSchema.default({}),
});

/** Inferred type from personaJsonSchema — structurally equivalent to UserPersona. */
export type PersonaRecord = z.infer<typeof personaJsonSchema>;

/**
 * Partial schema for incremental distillation.
 * All fields are optional so the LLM only returns changed fields.
 */
export const partialPersonaJsonSchema = z.object({
  version: z.number().int().positive().optional(),
  lastUpdated: z.string().optional(),
  summary: z.string().optional(),
  preferences: z.object({
    tools: z.array(z.string()).optional(),
    languages: z.array(z.string()).optional(),
    workflows: z.array(z.string()).optional(),
    communication: z.string().optional(),
  }).optional(),
  skills: z.object({
    known: z.array(z.string()).optional(),
    learning: z.array(z.string()).optional(),
  }).optional(),
  context: z.object({
    device: z.string().optional(),
    environment: z.string().optional(),
    timezone: z.string().optional(),
    activeProjects: z.array(z.string()).optional(),
  }).optional(),
  stats: z.object({
    totalSessions: z.number().int().nonnegative().optional(),
    totalMessages: z.number().int().nonnegative().optional(),
    lastActive: z.string().optional(),
  }).optional(),
});

/** Inferred type from partialPersonaJsonSchema — all fields optional. */
export type PartialPersona = z.infer<typeof partialPersonaJsonSchema>;

// ---------------------------------------------------------------------------
// Factory & helpers
// ---------------------------------------------------------------------------

/**
 * Create an empty UserPersona with default values.
 * - version = 1
 * - lastUpdated = current ISO datetime
 * - All string fields = ''
 * - All array fields = []
 * - All numeric stats = 0
 */
export function createEmptyPersona(): UserPersona {
  return {
    version: 1,
    lastUpdated: new Date().toISOString(),
    summary: '',
    preferences: {
      tools: [],
      languages: [],
      workflows: [],
      communication: '',
    },
    skills: {
      known: [],
      learning: [],
    },
    context: {
      device: '',
      environment: '',
      timezone: '',
      activeProjects: [],
    },
    stats: {
      totalSessions: 0,
      totalMessages: 0,
      lastActive: '',
    },
  };
}

/**
 * Serialize a UserPersona to a JSON string.
 */
export function personaToJson(persona: UserPersona): string {
  return JSON.stringify(persona);
}

/**
 * Deserialize a JSON string back to a validated UserPersona.
 * Throws if the JSON is malformed or fails schema validation.
 */
export function personaFromJson(json: string): UserPersona {
  return personaJsonSchema.parse(JSON.parse(json)) as UserPersona;
}

/**
 * Convert the persona zod schema to a JSON Schema string suitable for
 * LLM system prompt injection. The LLM uses this schema to know which
 * fields to return when generating or updating a persona.
 */
export function personaSchemaForPrompt(): string {
  const jsonSchema = zodToJsonSchema(personaJsonSchema, { target: 'openApi3' });
  return JSON.stringify(jsonSchema, null, 2);
}

/**
 * Merge a PartialPersona into a base UserPersona, returning a new UserPersona.
 * Only the fields explicitly present in `partial` overwrite those in `base`.
 * The original `base` and `partial` objects are not mutated.
 */
export function mergePartialPersona(base: UserPersona, partial: PartialPersona): UserPersona {
  const result: UserPersona = {
    ...base,
    preferences: { ...base.preferences },
    skills: { ...base.skills },
    context: { ...base.context },
    stats: { ...base.stats },
  };

  if (partial.version !== undefined) result.version = partial.version;
  if (partial.lastUpdated !== undefined) result.lastUpdated = partial.lastUpdated;
  if (partial.summary !== undefined) result.summary = partial.summary;

  if (partial.preferences) {
    if (partial.preferences.tools !== undefined) result.preferences.tools = [...partial.preferences.tools];
    if (partial.preferences.languages !== undefined) result.preferences.languages = [...partial.preferences.languages];
    if (partial.preferences.workflows !== undefined) result.preferences.workflows = [...partial.preferences.workflows];
    if (partial.preferences.communication !== undefined) result.preferences.communication = partial.preferences.communication;
  }

  if (partial.skills) {
    if (partial.skills.known !== undefined) result.skills.known = [...partial.skills.known];
    if (partial.skills.learning !== undefined) result.skills.learning = [...partial.skills.learning];
  }

  if (partial.context) {
    if (partial.context.device !== undefined) result.context.device = partial.context.device;
    if (partial.context.environment !== undefined) result.context.environment = partial.context.environment;
    if (partial.context.timezone !== undefined) result.context.timezone = partial.context.timezone;
    if (partial.context.activeProjects !== undefined) result.context.activeProjects = [...partial.context.activeProjects];
  }

  if (partial.stats) {
    if (partial.stats.totalSessions !== undefined) result.stats.totalSessions = partial.stats.totalSessions;
    if (partial.stats.totalMessages !== undefined) result.stats.totalMessages = partial.stats.totalMessages;
    if (partial.stats.lastActive !== undefined) result.stats.lastActive = partial.stats.lastActive;
  }

  return result;
}

/**
 * Convert the partial persona zod schema to a JSON Schema string.
 * Useful when the LLM should only return changed fields (incremental update).
 */
export function partialPersonaSchemaForPrompt(): string {
  const jsonSchema = zodToJsonSchema(partialPersonaJsonSchema, { target: 'openApi3' });
  return JSON.stringify(jsonSchema, null, 2);
}
