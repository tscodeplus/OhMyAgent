/**
 * Persona field provenance — what a persona value is made of.
 *
 * The persona is a single `memories` row (id `__persona__`, kind `persona`); it
 * has no per-field history. Provenance therefore lives on the distillation run
 * (`persona_distillation_runs.input_memory_ids` / `output_diff`, migration v16)
 * and this module is the read side of it:
 *
 *   why('preferences.languages') →
 *     { value: 'TypeScript', status: 'fresh',
 *       memories: [{ id: 'mem_…', content: '用户使用 TypeScript 开发' }] }
 *
 * "fresh" means the memories that justify the value are still open (status
 * `active`, `invalidated_at` NULL); "stale" means at least one of them was
 * closed as superseded, i.e. the persona is still asserting a value whose
 * supporting memory no longer holds — the `stalePreferenceRate` source.
 *
 * The field geometry (paths, value rendering, token matching, diff) lives here
 * too, because the WRITE path needs the identical enumeration: the distiller
 * diffs two personas with `diffPersonaFields()` and closes the memories that
 * carried the old value using the same token matcher. One spelling per concept.
 */

import type Database from 'better-sqlite3';
import type { UserPersona } from '../persona-model.js';
import { parseEpochMs } from '../../shared/timestamp.js';

// ---------------------------------------------------------------------------
// Field geometry
// ---------------------------------------------------------------------------

/** A persona field's value as stored: a string, or a list of strings. */
export type PersonaFieldValue = string | string[];

/** One field's before/after inside a distillation run's `output_diff`. */
export interface PersonaFieldDiff {
  from: PersonaFieldValue;
  to: PersonaFieldValue;
}

/**
 * Field-level changes a distillation run wrote, keyed by dot path.
 * Excludes `version`/`lastUpdated`/`stats` — bookkeeping and derived counters,
 * not persona claims, so they would make every run look like it changed.
 */
export type PersonaOutputDiff = Record<string, PersonaFieldDiff>;

const FIELD_ACCESSORS: Record<string, (persona: UserPersona) => PersonaFieldValue> = {
  summary: (p) => p.summary,
  'preferences.tools': (p) => p.preferences.tools,
  'preferences.languages': (p) => p.preferences.languages,
  'preferences.workflows': (p) => p.preferences.workflows,
  'preferences.communication': (p) => p.preferences.communication,
  'skills.known': (p) => p.skills.known,
  'skills.learning': (p) => p.skills.learning,
  'workHabits.hours': (p) => p.workHabits.hours,
  'workHabits.taskStyle': (p) => p.workHabits.taskStyle,
  'workHabits.qualityPreferences': (p) => p.workHabits.qualityPreferences,
  'knowledgeDomains.expert': (p) => p.knowledgeDomains.expert,
  'knowledgeDomains.proficient': (p) => p.knowledgeDomains.proficient,
  'knowledgeDomains.interested': (p) => p.knowledgeDomains.interested,
  'projectPreferences.techStacks': (p) => p.projectPreferences.techStacks,
  'projectPreferences.projectTypes': (p) => p.projectPreferences.projectTypes,
  'projectPreferences.deploymentTargets': (p) => p.projectPreferences.deploymentTargets,
  'context.device': (p) => p.context.device,
  'context.environment': (p) => p.context.environment,
  'context.timezone': (p) => p.context.timezone,
  'context.activeProjects': (p) => p.context.activeProjects,
};

/** Every traceable persona field, in persona-model order. */
export const PERSONA_FIELD_PATHS: readonly string[] = Object.keys(FIELD_ACCESSORS);

/**
 * Longest value that is still matched literally against memory content. Past
 * this a "value" is prose (a summary), where token containment matches noise —
 * those fields fall back to "the whole run input set is the justification".
 */
const MAX_MATCHABLE_VALUE_CHARS = 60;

/** Read one field's value; `undefined` for an unknown path.
 *
 * Tolerates a nullish/partially-shaped persona: callers hold persona objects
 * straight from a store or a mock that may predate a schema field, and a
 * provenance read must not throw over one missing subtree.
 */
export function personaFieldValue(
  persona: UserPersona | null | undefined,
  field: string,
): PersonaFieldValue | undefined {
  const accessor = FIELD_ACCESSORS[field];
  if (!accessor || !persona) return undefined;
  try {
    return accessor(persona);
  } catch {
    return undefined;
  }
}

/** Render a field value as text (lists join with ', '). */
export function personaFieldText(value: PersonaFieldValue | undefined): string {
  if (value === undefined) return '';
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * Tokens a memory must mention to count as support for `value`.
 * Empty for a value that is empty or too long to be a phrase — see
 * MAX_MATCHABLE_VALUE_CHARS.
 */
export function personaValueTokens(value: PersonaFieldValue | undefined): string[] {
  if (value === undefined) return [];
  const rendered = personaFieldText(value);
  if (rendered.length === 0 || rendered.length > MAX_MATCHABLE_VALUE_CHARS) return [];
  const parts = Array.isArray(value) ? value : rendered.split(/[,，;；/|、\n]+/);
  const tokens: string[] = [];
  for (const part of parts) {
    const token = part.trim().toLowerCase();
    if (token.length >= 2 && !tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

/** True when `content` mentions at least one token of `value`. */
export function memoryMentionsValue(
  content: string,
  value: PersonaFieldValue | undefined,
): boolean {
  const tokens = personaValueTokens(value);
  if (tokens.length === 0) return false;
  const haystack = content.toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

/**
 * Field-level diff between two personas (`before` may be null — a first
 * distillation). Only fields whose value actually changed are returned.
 */
export function diffPersonaFields(
  before: UserPersona | null | undefined,
  after: UserPersona | null | undefined,
): PersonaOutputDiff {
  const diff: PersonaOutputDiff = {};
  if (!after) return diff;
  for (const field of PERSONA_FIELD_PATHS) {
    const from = before ? personaFieldValue(before, field) : undefined;
    const to = personaFieldValue(after, field);
    if (to === undefined) continue;
    // Compare canonically: arrays are order-sensitive claims about a list the
    // LLM re-emits, so ['a','b'] → ['b','a'] is a change worth recording.
    if (before && JSON.stringify(from) === JSON.stringify(to)) continue;
    if (!before && personaFieldText(to).length === 0) continue;
    diff[field] = { from: from ?? emptyLike(to), to };
  }
  return diff;
}

function emptyLike(value: PersonaFieldValue): PersonaFieldValue {
  return Array.isArray(value) ? [] : '';
}

// ---------------------------------------------------------------------------
// why(): read path
// ---------------------------------------------------------------------------

export type PersonaProvenanceStatus = 'fresh' | 'stale' | 'unknown';

/** A memory that justifies a persona value. */
export interface PersonaSourceMemory {
  id: string;
  content: string;
  kind: string;
  status: string;
  created_at: string;
  invalidated_at: string | null;
  /** True when the memory is no longer true (superseded/deleted or invalidated). */
  closed: boolean;
}

export interface PersonaFieldProvenance {
  /** Dot path, e.g. 'preferences.languages'. */
  field: string;
  /** Current persona value rendered as text ('' when empty). */
  value: string;
  status: PersonaProvenanceStatus;
  /** Memories from the latest successful distillation run that mention the value. */
  memories: PersonaSourceMemory[];
  /** Distillation run the provenance was read from. */
  runId: string | null;
  /** When that run started (epoch-ms text, as stored). */
  distilledAt: string | null;
}

export interface PersonaProvenanceQueryOptions {
  /** Reads the live persona (a getter, so a reload/rebuild is picked up). */
  persona: () => UserPersona | null;
  /** Max memories returned per field (default 5). */
  limit?: number;
}

interface DistillationRunRow {
  id: string;
  status: string;
  started_at: string;
  input_memory_ids: string | null;
}

const DEFAULT_LIMIT = 5;

/**
 * Reads persona provenance from `persona_distillation_runs` joined to
 * `memories`. Read-only; never throws on a malformed/unparseable run row.
 */
export class PersonaProvenanceQuery {
  private readonly limit: number;

  constructor(
    private readonly db: Database.Database,
    private readonly options: PersonaProvenanceQueryOptions,
  ) {
    this.limit = options.limit ?? DEFAULT_LIMIT;
  }

  /** Why does the persona hold this field's current value? */
  why(field: string): PersonaFieldProvenance {
    const persona = this.safePersona();
    const value = persona ? personaFieldValue(persona, field) : undefined;
    const rendered = personaFieldText(value);
    const run = this.latestRunWithInputs();

    const empty: PersonaFieldProvenance = {
      field,
      value: rendered,
      status: 'unknown',
      memories: [],
      runId: run?.id ?? null,
      distilledAt: run?.started_at ?? null,
    };
    if (!persona || rendered.length === 0 || !run) return empty;

    const inputIds = parseIdList(run.input_memory_ids);
    if (inputIds.length === 0) return empty;

    const rows = this.loadMemories(inputIds);
    const tokens = personaValueTokens(value);
    // No usable tokens (prose value): the run itself is the justification —
    // every memory it distilled from is what the value was built out of.
    const supports =
      tokens.length === 0 ? rows : rows.filter((row) => memoryMentionsValue(row.content, value));
    const memories = supports.slice(0, this.limit);
    if (memories.length === 0) return empty;

    return {
      field,
      value: rendered,
      status: memories.some((memory) => memory.closed) ? 'stale' : 'fresh',
      memories,
      runId: run.id,
      distilledAt: run.started_at,
    };
  }

  /** Every field that currently holds a value, in persona-model order. */
  whyAll(): PersonaFieldProvenance[] {
    const persona = this.safePersona();
    if (!persona) return [];
    return PERSONA_FIELD_PATHS.filter(
      (field) => personaFieldText(personaFieldValue(persona, field)).length > 0,
    ).map((field) => this.why(field));
  }

  /**
   * Latest run that recorded inputs, preferring a run that succeeded: a failed
   * run wrote nothing, so its input list must not explain a current value.
   */
  private latestRunWithInputs(): DistillationRunRow | null {
    let rows: DistillationRunRow[];
    try {
      rows = this.db
        .prepare(
          `SELECT id, status, started_at, input_memory_ids
             FROM persona_distillation_runs
            WHERE input_memory_ids IS NOT NULL
            ORDER BY CAST(started_at AS INTEGER) DESC
            LIMIT 50`,
        )
        .all() as DistillationRunRow[];
    } catch {
      return null; // table absent (pre-v16 database) — provenance unknown
    }
    if (rows.length === 0) return null;
    // started_at is an epoch-ms digit string by DB default but may be ISO from
    // an app writer, so re-sort through parseEpochMs instead of trusting CAST.
    rows.sort((a, b) => parseEpochMs(b.started_at) - parseEpochMs(a.started_at));
    return rows.find((row) => row.status === 'success') ?? rows[0];
  }

  private loadMemories(ids: string[]): PersonaSourceMemory[] {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT id, content, kind, status, created_at, invalidated_at
           FROM memories
          WHERE id IN (${placeholders})
          ORDER BY CAST(updated_at AS INTEGER) DESC`,
      )
      .all(...ids) as Array<Omit<PersonaSourceMemory, 'closed'>>;
    return rows.map((row) => ({
      ...row,
      closed: row.status !== 'active' || row.invalidated_at !== null,
    }));
  }

  private safePersona(): UserPersona | null {
    try {
      return this.options.persona();
    } catch {
      return null;
    }
  }
}

function parseIdList(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}
