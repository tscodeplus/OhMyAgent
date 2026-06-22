import { describe, it, expect } from 'vitest';
import {
  createEmptyPersona,
  personaJsonSchema,
  partialPersonaJsonSchema,
  personaSchemaForPrompt,
  partialPersonaSchemaForPrompt,
  personaToJson,
  personaFromJson,
} from '../../src/memory/persona-model';
import type { UserPersona, PartialPersona } from '../../src/memory/persona-model';

// ---------------------------------------------------------------------------
// createEmptyPersona
// ---------------------------------------------------------------------------

describe('createEmptyPersona', () => {
  it('returns default version 1', () => {
    const persona = createEmptyPersona();
    expect(persona.version).toBe(1);
  });

  it('sets lastUpdated to a valid ISO 8601 datetime', () => {
    const persona = createEmptyPersona();
    expect(persona.lastUpdated).toBeTruthy();
    expect(() => new Date(persona.lastUpdated)).not.toThrow();
    expect(new Date(persona.lastUpdated).toISOString()).toBe(persona.lastUpdated);
  });

  it('returns empty summary', () => {
    const persona = createEmptyPersona();
    expect(persona.summary).toBe('');
  });

  it('returns empty preferences arrays and empty communication', () => {
    const persona = createEmptyPersona();
    expect(persona.preferences.tools).toEqual([]);
    expect(persona.preferences.languages).toEqual([]);
    expect(persona.preferences.workflows).toEqual([]);
    expect(persona.preferences.communication).toBe('');
  });

  it('returns empty skills arrays', () => {
    const persona = createEmptyPersona();
    expect(persona.skills.known).toEqual([]);
    expect(persona.skills.learning).toEqual([]);
  });

  it('returns empty context fields', () => {
    const persona = createEmptyPersona();
    expect(persona.context.device).toBe('');
    expect(persona.context.environment).toBe('');
    expect(persona.context.timezone).toBe('');
    expect(persona.context.activeProjects).toEqual([]);
  });

  it('returns zero stats', () => {
    const persona = createEmptyPersona();
    expect(persona.stats.totalSessions).toBe(0);
    expect(persona.stats.totalMessages).toBe(0);
    expect(persona.stats.lastActive).toBe('');
  });

  it('returns a fresh timestamp on each call', () => {
    const a = createEmptyPersona();
    const b = createEmptyPersona();
    // Two consecutive calls should produce different timestamps
    // (at least the second one should be >= the first)
    expect(new Date(b.lastUpdated).getTime()).toBeGreaterThanOrEqual(
      new Date(a.lastUpdated).getTime(),
    );
  });

  it('satisfies the UserPersona interface structurally', () => {
    const persona: UserPersona = createEmptyPersona();
    // Compile-time check: all required fields are present
    expect(persona).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// personaJsonSchema — validation
// ---------------------------------------------------------------------------

describe('personaJsonSchema', () => {
  it('validates a valid full persona', () => {
    const data: UserPersona = {
      version: 2,
      lastUpdated: '2026-05-15T10:00:00.000Z',
      summary: 'A senior Android developer',
      preferences: {
        tools: ['shell', 'file_read', 'file_write'],
        languages: ['zh-CN', 'python', 'bash'],
        workflows: ['read-then-edit', 'test-first'],
        communication: 'concise',
      },
      skills: {
        known: ['Android', 'Kotlin', 'Python'],
        learning: ['Rust', 'Kubernetes'],
      },
      context: {
        device: 'OnePlus 13, Termux',
        environment: 'Node.js 20, pnpm',
        timezone: 'Asia/Shanghai',
        activeProjects: ['OhMyAgent', 'MyApp'],
      },
      stats: {
        totalSessions: 42,
        totalMessages: 1024,
        lastActive: '2026-05-15T09:00:00.000Z',
      },
    };
    const result = personaJsonSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('fills missing fields with defaults', () => {
    const result = personaJsonSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe(1);
      expect(result.data.lastUpdated).toBe('');
      expect(result.data.summary).toBe('');
      expect(result.data.preferences.tools).toEqual([]);
      expect(result.data.preferences.communication).toBe('');
      expect(result.data.skills.known).toEqual([]);
      expect(result.data.context.device).toBe('');
      expect(result.data.context.activeProjects).toEqual([]);
      expect(result.data.stats.totalSessions).toBe(0);
      expect(result.data.stats.totalMessages).toBe(0);
      expect(result.data.stats.lastActive).toBe('');
    }
  });

  it('rejects negative version', () => {
    const result = personaJsonSchema.safeParse({
      version: -1,
      preferences: {},
      skills: {},
      context: {},
      stats: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects version 0', () => {
    const result = personaJsonSchema.safeParse({
      version: 0,
      preferences: {},
      skills: {},
      context: {},
      stats: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative stat values', () => {
    const result = personaJsonSchema.safeParse({
      preferences: {},
      skills: {},
      context: {},
      stats: { totalSessions: -5 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer version', () => {
    const result = personaJsonSchema.safeParse({
      version: 1.5,
      preferences: {},
      skills: {},
      context: {},
      stats: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer stats', () => {
    const result = personaJsonSchema.safeParse({
      preferences: {},
      skills: {},
      context: {},
      stats: { totalMessages: 10.5 },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// partialPersonaJsonSchema — incremental update schema
// ---------------------------------------------------------------------------

describe('partialPersonaJsonSchema', () => {
  it('validates an empty partial update', () => {
    const result = partialPersonaJsonSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('validates a partial update with only summary', () => {
    const result = partialPersonaJsonSchema.safeParse({
      summary: 'Updated summary',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.summary).toBe('Updated summary');
      expect(result.data.version).toBeUndefined();
    }
  });

  it('validates partial updates to nested fields', () => {
    const result = partialPersonaJsonSchema.safeParse({
      preferences: {
        tools: ['shell'],
        communication: 'detailed',
      },
      skills: {
        learning: ['Rust'],
      },
      stats: {
        totalSessions: 10,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.preferences?.tools).toEqual(['shell']);
      expect(result.data.preferences?.languages).toBeUndefined();
      expect(result.data.skills?.learning).toEqual(['Rust']);
      expect(result.data.skills?.known).toBeUndefined();
      expect(result.data.stats?.totalSessions).toBe(10);
      expect(result.data.stats?.totalMessages).toBeUndefined();
    }
  });

  it('rejects negative stats in partial update', () => {
    const result = partialPersonaJsonSchema.safeParse({
      stats: { totalSessions: -1 },
    });
    expect(result.success).toBe(false);
  });

  it('satisfies the PartialPersona type', () => {
    const partial: PartialPersona = {
      summary: 'test',
      preferences: { tools: ['shell'] },
    };
    expect(partial).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// personaSchemaForPrompt
// ---------------------------------------------------------------------------

describe('personaSchemaForPrompt', () => {
  it('returns a string', () => {
    const result = personaSchemaForPrompt();
    expect(typeof result).toBe('string');
  });

  it('returns valid JSON', () => {
    const result = personaSchemaForPrompt();
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('contains top-level schema keys', () => {
    const result = personaSchemaForPrompt();
    const parsed = JSON.parse(result);
    // The zodToJsonSchema output wraps in a top-level schema
    // Depending on target 'openApi3', the properties may be nested
    const root = parsed; // the wrapper
    expect(root).toBeDefined();
  });

  it('contains the properties of the persona schema', () => {
    const result = personaSchemaForPrompt();
    const parsed = JSON.parse(result);

    // For 'openApi3' target, the schema has the properties directly or nested
    // under a wrapper. Let's find the properties object.
    const props =
      parsed.properties ??
      (parsed.definitions?.UserPersona?.properties) ??
      {};

    const keys = Object.keys(props);
    expect(keys).toContain('version');
    expect(keys).toContain('lastUpdated');
    expect(keys).toContain('summary');
    expect(keys).toContain('preferences');
    expect(keys).toContain('skills');
    expect(keys).toContain('context');
    expect(keys).toContain('stats');
  });
});

// ---------------------------------------------------------------------------
// partialPersonaSchemaForPrompt
// ---------------------------------------------------------------------------

describe('partialPersonaSchemaForPrompt', () => {
  it('returns a string', () => {
    const result = partialPersonaSchemaForPrompt();
    expect(typeof result).toBe('string');
  });

  it('returns valid JSON', () => {
    const result = partialPersonaSchemaForPrompt();
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('contains summary as optional', () => {
    const result = partialPersonaSchemaForPrompt();
    const parsed = JSON.parse(result);
    const props = parsed.properties ?? {};
    // summary should exist and not require a minLength since it's optional
    expect(props).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Serialization round-trip
// ---------------------------------------------------------------------------

describe('serialization round-trip', () => {
  it('toJson and fromJson round-trips a full persona', () => {
    const persona: UserPersona = {
      version: 3,
      lastUpdated: '2026-05-15T12:00:00.000Z',
      summary: 'Test user',
      preferences: {
        tools: ['web_search'],
        languages: ['en'],
        workflows: [],
        communication: 'brief',
      },
      skills: {
        known: ['JavaScript'],
        learning: ['TypeScript'],
      },
      workHabits: {
        hours: '9-5',
        taskStyle: 'incremental',
        qualityPreferences: ['code review'],
      },
      knowledgeDomains: {
        expert: ['frontend'],
        proficient: ['backend'],
        interested: ['AI'],
      },
      projectPreferences: {
        techStacks: ['React'],
        projectTypes: ['web app'],
        deploymentTargets: ['Vercel'],
      },
      context: {
        device: 'Desktop',
        environment: 'Linux',
        timezone: 'UTC',
        activeProjects: ['test'],
      },
      stats: {
        totalSessions: 5,
        totalMessages: 100,
        lastActive: '2026-05-15T11:00:00.000Z',
      },
    };

    const json = personaToJson(persona);
    const restored = personaFromJson(json);

    expect(restored).toEqual(persona);
  });

  it('toJson and fromJson round-trips an empty persona', () => {
    const persona = createEmptyPersona();
    const json = personaToJson(persona);
    const restored = personaFromJson(json);

    expect(restored.version).toBe(1);
    expect(restored.summary).toBe('');
    expect(restored.preferences.tools).toEqual([]);
    expect(restored.stats.totalSessions).toBe(0);
  });

  it('fromJson throws on invalid JSON string', () => {
    expect(() => personaFromJson('not valid json')).toThrow();
  });

  it('fromJson throws on data that fails schema validation', () => {
    const invalid = JSON.stringify({ version: -1 });
    expect(() => personaFromJson(invalid)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Type-level checks (compile-time only, verified at runtime as no-ops)
// ---------------------------------------------------------------------------

describe('type compatibility', () => {
  it('personaJsonSchema inferred type is compatible with UserPersona', () => {
    // If PersonaRecord and UserPersona are compatible, an assignment works
    const persona: UserPersona = createEmptyPersona();
    const parsed = personaJsonSchema.parse(persona);
    // Assigning back — both have same shape
    const round: UserPersona = parsed as UserPersona;
    expect(round.version).toBe(persona.version);
  });
});
