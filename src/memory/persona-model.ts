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

  /** Work habits and task management patterns. */
  workHabits: {
    /** Typical working hours description (e.g. "morning person, 9am-6pm"). */
    hours: string;
    /** Task management approach (e.g. "incremental", "big-bang", "exploratory"). */
    taskStyle: string;
    /** Quality/code review preferences. */
    qualityPreferences: string[];
  };

  /** Knowledge domains — areas where the user has demonstrated expertise. */
  knowledgeDomains: {
    /** Areas of deep expertise. */
    expert: string[];
    /** Areas of working knowledge. */
    proficient: string[];
    /** Areas of active learning/interest. */
    interested: string[];
  };

  /** Project-level preferences. */
  projectPreferences: {
    /** Preferred tech stacks (e.g. "TypeScript + React", "Python + FastAPI"). */
    techStacks: string[];
    /** Types of projects the user gravitates toward. */
    projectTypes: string[];
    /** Preferred deployment targets. */
    deploymentTargets: string[];
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
  workHabits: z.object({
    hours: z.string().default(''),
    taskStyle: z.string().default(''),
    qualityPreferences: z.array(z.string()).default([]),
  }).default({}),
  knowledgeDomains: z.object({
    expert: z.array(z.string()).default([]),
    proficient: z.array(z.string()).default([]),
    interested: z.array(z.string()).default([]),
  }).default({}),
  projectPreferences: z.object({
    techStacks: z.array(z.string()).default([]),
    projectTypes: z.array(z.string()).default([]),
    deploymentTargets: z.array(z.string()).default([]),
  }).default({}),
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
  workHabits: z.object({
    hours: z.string().optional(),
    taskStyle: z.string().optional(),
    qualityPreferences: z.array(z.string()).optional(),
  }).optional(),
  knowledgeDomains: z.object({
    expert: z.array(z.string()).optional(),
    proficient: z.array(z.string()).optional(),
    interested: z.array(z.string()).optional(),
  }).optional(),
  projectPreferences: z.object({
    techStacks: z.array(z.string()).optional(),
    projectTypes: z.array(z.string()).optional(),
    deploymentTargets: z.array(z.string()).optional(),
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
    workHabits: {
      hours: '',
      taskStyle: '',
      qualityPreferences: [],
    },
    knowledgeDomains: {
      expert: [],
      proficient: [],
      interested: [],
    },
    projectPreferences: {
      techStacks: [],
      projectTypes: [],
      deploymentTargets: [],
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
    workHabits: { ...base.workHabits },
    knowledgeDomains: { ...base.knowledgeDomains },
    projectPreferences: { ...base.projectPreferences },
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

  if (partial.workHabits) {
    if (partial.workHabits.hours !== undefined) result.workHabits.hours = partial.workHabits.hours;
    if (partial.workHabits.taskStyle !== undefined) result.workHabits.taskStyle = partial.workHabits.taskStyle;
    if (partial.workHabits.qualityPreferences !== undefined) result.workHabits.qualityPreferences = [...partial.workHabits.qualityPreferences];
  }

  if (partial.knowledgeDomains) {
    if (partial.knowledgeDomains.expert !== undefined) result.knowledgeDomains.expert = [...partial.knowledgeDomains.expert];
    if (partial.knowledgeDomains.proficient !== undefined) result.knowledgeDomains.proficient = [...partial.knowledgeDomains.proficient];
    if (partial.knowledgeDomains.interested !== undefined) result.knowledgeDomains.interested = [...partial.knowledgeDomains.interested];
  }

  if (partial.projectPreferences) {
    if (partial.projectPreferences.techStacks !== undefined) result.projectPreferences.techStacks = [...partial.projectPreferences.techStacks];
    if (partial.projectPreferences.projectTypes !== undefined) result.projectPreferences.projectTypes = [...partial.projectPreferences.projectTypes];
    if (partial.projectPreferences.deploymentTargets !== undefined) result.projectPreferences.deploymentTargets = [...partial.projectPreferences.deploymentTargets];
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
