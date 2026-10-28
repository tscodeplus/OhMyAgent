/**
 * K4 — the persona loop: provenance round-trip, contradiction closing, the
 * three feedback signals and the fresh/stale boundary.
 *
 * Everything runs against a real in-memory SQLite database (schema.ts + the
 * v16 columns), because the whole point of K4 is that the persona's provenance
 * and its feedback land in EXISTING tables (`persona_distillation_runs`,
 * `memory_observation_events`, `memories.invalidated_at/supersedes_id`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';
import { PERSONA_MEMORY_ID, PersonaStore } from '../../src/memory/persona-store';
import { PersonaDistillationLog } from '../../src/memory/persona/persona-distillation-log';
import { PersonaDistiller, type DistillerLLM } from '../../src/memory/persona-distiller';
import {
  PersonaProvenanceQuery,
  diffPersonaFields,
  personaFieldText,
  personaValueTokens,
} from '../../src/memory/persona/provenance-query';
import {
  PersonaFeedback,
  PERSONA_FEEDBACK_WEIGHTS,
  REJECTION_NOT_REJECTED,
  REJECTION_REJECTED,
} from '../../src/memory/persona/feedback';
import { createEmptyPersona, type UserPersona } from '../../src/memory/persona-model';
import type { JudgeEngine } from '../../src/judge/engine';
import type { DecisionOutcome, JudgeMode } from '../../src/judge/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
}

function personaWithLanguages(languages: string[], summary = ''): UserPersona {
  const persona = createEmptyPersona();
  persona.summary = summary;
  persona.preferences.languages = languages;
  return persona;
}

function llmReturning(persona: UserPersona): DistillerLLM {
  return { call: vi.fn(async () => JSON.stringify(persona)) };
}

/** Minimal JudgeEngine stub: only the two members the feedback path reads. */
function fakeJudgeEngine(mode: JudgeMode, outcome: DecisionOutcome): JudgeEngine {
  return {
    modeFor: () => mode,
    decideMany: async () => ({
      pointId: 'persona.rejection',
      decisionId: 'persona.rejection@v1',
      answers: {},
      judgeId: 'test-judge',
      source: 'judge',
      latencyMs: 1,
      mode,
      outcome,
    }),
  } as unknown as JudgeEngine;
}

function eventRows(
  db: Database.Database,
  event: string,
): Array<{ event: string; details: string | null }> {
  return db
    .prepare('SELECT event, details FROM memory_observation_events WHERE event = ? ORDER BY id')
    .all(event) as Array<{ event: string; details: string | null }>;
}

function detailsOf(row: { details: string | null }): Record<string, unknown> {
  return row.details ? (JSON.parse(row.details) as Record<string, unknown>) : {};
}

interface Harness {
  db: Database.Database;
  repo: MemoryRepository;
  store: PersonaStore;
  log: PersonaDistillationLog;
  feedback: PersonaFeedback;
  provenance: PersonaProvenanceQuery;
}

describe('persona loop (K4)', () => {
  let harness: Harness;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    const repo = new MemoryRepository(db);
    const store = new PersonaStore(repo);
    harness = {
      db,
      repo,
      store,
      log: new PersonaDistillationLog(db),
      feedback: new PersonaFeedback(db, repo, { logger: makeLogger() }),
      provenance: new PersonaProvenanceQuery(db, { persona: () => store.get() }),
    };
  });

  afterEach(() => {
    harness.db.close();
  });

  function seedPreference(id: string, content: string): void {
    harness.repo.create({
      id,
      scope: 'user',
      scope_key: 'session-1',
      kind: 'preference',
      content,
    });
  }

  function makeDistiller(persona: UserPersona): PersonaDistiller {
    return new PersonaDistiller(
      llmReturning(persona),
      harness.repo,
      harness.store,
      makeLogger(),
      {},
      harness.log,
    );
  }

  // -----------------------------------------------------------------------
  // provenance round-trip
  // -----------------------------------------------------------------------

  describe('distillation provenance', () => {
    it('records input_memory_ids and the field-level output_diff on the run', async () => {
      seedPreference('mem-js', '用户偏好使用 JavaScript 开发');
      seedPreference('mem-ts', '用户使用 TypeScript 开发');
      harness.store.save(personaWithLanguages(['JavaScript']));

      const distiller = makeDistiller(personaWithLanguages(['TypeScript']));
      expect(await distiller.rebuildFull()).toBe(true);

      const run = harness.log.getLastRun('rebuild');
      expect(run).toBeDefined();
      expect((JSON.parse(run!.input_memory_ids!) as string[]).sort()).toEqual(['mem-js', 'mem-ts']);
      const diff = JSON.parse(run!.output_diff!) as Record<string, unknown>;
      expect(diff['preferences.languages']).toEqual({
        from: ['JavaScript'],
        to: ['TypeScript'],
      });
      // Only real claims are recorded — never `lastUpdated`/`stats`.
      expect(Object.keys(diff)).toEqual(['preferences.languages']);
    });

    it('records the inputs of a failed run too, with an empty diff', async () => {
      seedPreference('mem-ts', '用户使用 TypeScript 开发');
      harness.store.save(personaWithLanguages(['JavaScript']));

      const llm: DistillerLLM = {
        call: vi.fn(async () => {
          throw new Error('provider down');
        }),
      };
      const distiller = new PersonaDistiller(
        llm,
        harness.repo,
        harness.store,
        makeLogger(),
        {},
        harness.log,
      );

      expect(await distiller.rebuildFull()).toBe(false);
      const run = harness.log.getLastRun('rebuild')!;
      expect(JSON.parse(run.input_memory_ids!)).toEqual(['mem-ts']);
      expect(JSON.parse(run.output_diff!)).toEqual({});
      expect(run.error).toBeTruthy();
    });

    it('records provenance for an incremental distillation run', async () => {
      seedPreference('mem-ts', '用户使用 TypeScript 开发');
      const base = personaWithLanguages(['JavaScript']);
      base.lastUpdated = new Date(0).toISOString();
      harness.store.save(base, { updateLastUpdated: false });

      const distiller = makeDistiller(personaWithLanguages(['TypeScript']));
      const partial = await distiller.distillIncremental();
      expect(partial).not.toEqual({});

      const run = harness.log.getLastRun('incremental')!;
      expect(JSON.parse(run.input_memory_ids!)).toEqual(['mem-ts']);
      const diff = JSON.parse(run.output_diff!) as Record<string, unknown>;
      expect(diff['preferences.languages']).toEqual({
        from: ['JavaScript'],
        to: ['TypeScript'],
      });
    });
  });

  // -----------------------------------------------------------------------
  // contradiction closing
  // -----------------------------------------------------------------------

  describe('contradiction closing', () => {
    it('closes the memory that carried the replaced value and links it to the new one', async () => {
      seedPreference('mem-js', '用户偏好使用 JavaScript 开发');
      seedPreference('mem-ts', '用户使用 TypeScript 开发');
      harness.store.save(personaWithLanguages(['JavaScript']));

      await makeDistiller(personaWithLanguages(['TypeScript'])).rebuildFull();

      const old = harness.repo.findById('mem-js')!;
      expect(old.status).toBe('superseded');
      expect(old.invalidated_at).not.toBeNull();

      const newCarrier = harness.repo.findById('mem-ts')!;
      expect(newCarrier.status).toBe('active');
      expect(newCarrier.supersedes_id).toBe('mem-js');
    });

    it('leaves memories alone when a field did not change', async () => {
      seedPreference('mem-js', '用户偏好使用 JavaScript 开发');
      harness.store.save(personaWithLanguages(['JavaScript']));

      await makeDistiller(personaWithLanguages(['JavaScript'])).rebuildFull();

      const unchanged = harness.repo.findById('mem-js')!;
      expect(unchanged.status).toBe('active');
      expect(unchanged.invalidated_at).toBeNull();
    });

    it('uses the persona row as successor when no memory carries the new value', () => {
      seedPreference('mem-js', '用户偏好使用 JavaScript 开发');
      harness.store.save(personaWithLanguages(['JavaScript']));

      const result = new PersonaFeedback(harness.db, harness.repo).recordManualOverride({
        before: personaWithLanguages(['JavaScript']),
        after: personaWithLanguages(['Rust']),
      });

      expect(result.fields).toEqual(['preferences.languages']);
      expect(result.closedIds).toEqual(['mem-js']);
      expect(harness.repo.findById('mem-js')!.status).toBe('superseded');
      // No preference memory mentions Rust, so the persona row supersedes it.
      expect(harness.repo.findById(PERSONA_MEMORY_ID)!.supersedes_id).toBe('mem-js');
    });

    it('skips closing on a repository that cannot supersede (read-only stub)', async () => {
      const prefs = [
        {
          id: 'mem-js',
          scope: 'user',
          scope_key: 's',
          kind: 'preference',
          content: '用户偏好使用 JavaScript 开发',
          status: 'active',
          metadata: null,
          agent_id: null,
          visibility: 'shared',
          supersedes_id: null,
          source_channel: null,
          source_message_id: null,
          confidence: 1,
          invalidated_at: null,
          created_at: '1',
          updated_at: '1',
        },
      ];
      const readOnlyRepo = { findByScopeKind: () => prefs };
      const distiller = new PersonaDistiller(
        llmReturning(personaWithLanguages(['TypeScript'])),
        readOnlyRepo,
        harness.store,
        makeLogger(),
        {},
        harness.log,
      );

      await expect(distiller.rebuildFull()).resolves.toBe(true);
      // The old carrier is still open — but the run is documented.
      const run = harness.log.getLastRun('rebuild')!;
      expect(JSON.parse(run.output_diff!)).toHaveProperty('preferences.languages');
    });
  });

  // -----------------------------------------------------------------------
  // why(): real memories back
  // -----------------------------------------------------------------------

  describe('why()', () => {
    it('returns the memories that justify a persona field', async () => {
      seedPreference('mem-js', '用户偏好使用 JavaScript 开发');
      seedPreference('mem-ts', '用户使用 TypeScript 开发');
      harness.store.save(personaWithLanguages(['JavaScript']));

      await makeDistiller(personaWithLanguages(['TypeScript'])).rebuildFull();

      const why = harness.provenance.why('preferences.languages');
      expect(why.value).toBe('TypeScript');
      expect(why.status).toBe('fresh');
      expect(why.runId).toBeTruthy();
      expect(why.memories.map((memory) => memory.id)).toEqual(['mem-ts']);
      expect(why.memories[0]!.content).toContain('TypeScript');
    });

    it('reports unknown for a field whose value no memory supports', async () => {
      seedPreference('mem-ts', '用户使用 TypeScript 开发');
      harness.store.save(personaWithLanguages(['TypeScript']));

      await makeDistiller(personaWithLanguages(['TypeScript'])).rebuildFull();

      const why = harness.provenance.why('context.timezone');
      expect(why.status).toBe('unknown');
      expect(why.memories).toEqual([]);
    });

    it('reports unknown when no distillation run recorded provenance', () => {
      harness.store.save(personaWithLanguages(['TypeScript']));
      const why = harness.provenance.why('preferences.languages');
      expect(why.status).toBe('unknown');
      expect(why.memories).toEqual([]);
      expect(why.runId).toBeNull();
    });

    it('flips to stale once the supporting memory is closed', async () => {
      seedPreference('mem-ts', '用户使用 TypeScript 开发');
      seedPreference('mem-js', '用户偏好使用 JavaScript 开发');
      harness.store.save(personaWithLanguages(['JavaScript']));

      await makeDistiller(personaWithLanguages(['TypeScript'])).rebuildFull();
      expect(harness.provenance.why('preferences.languages').status).toBe('fresh');

      // The supporting memory stops being true — the persona value is now stale.
      harness.repo.supersede('mem-ts', 'mem-js');
      const why = harness.provenance.why('preferences.languages');
      expect(why.status).toBe('stale');
      expect(why.memories[0]!.closed).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // feedback signals
  // -----------------------------------------------------------------------

  describe('feedback signals', () => {
    it('records nothing for a rejection when the judge kernel is inert', async () => {
      const result = await harness.feedback.recordRejection({
        userMessage: '不对，我没说过这话',
        judgeGet: () => undefined,
      });
      expect(result).toEqual({ asked: false, recorded: false });
      expect(eventRows(harness.db, 'persona.rejected')).toHaveLength(0);
    });

    it('records nothing for a rejection when the decision point is off', async () => {
      const result = await harness.feedback.recordRejection({
        userMessage: '不是这样',
        engine: fakeJudgeEngine('off', { action: 'none' }),
      });
      expect(result).toEqual({ asked: false, recorded: false });
      expect(eventRows(harness.db, 'persona.rejected')).toHaveLength(0);
    });

    it('records nothing in shadow mode — the verdict is not applied', async () => {
      const result = await harness.feedback.recordRejection({
        userMessage: '不是这样',
        engine: fakeJudgeEngine('shadow', { action: 'none' }),
      });
      expect(result).toEqual({ asked: true, recorded: false });
      expect(eventRows(harness.db, 'persona.rejected')).toHaveLength(0);
    });

    it('records nothing when the judge says the reply is not a rejection', async () => {
      const result = await harness.feedback.recordRejection({
        userMessage: '不是这个意思，我是说用 pnpm',
        engine: fakeJudgeEngine('active', { action: 'route', choice: REJECTION_NOT_REJECTED }),
      });
      expect(result).toEqual({ asked: true, recorded: false });
      expect(eventRows(harness.db, 'persona.rejected')).toHaveLength(0);
    });

    it('records persona.rejected on a judged, active rejection', async () => {
      const result = await harness.feedback.recordRejection({
        userMessage: '不对，我没说过我用 TypeScript',
        assistantText: '你主要用 TypeScript',
        sessionId: 'sess-1',
        engine: fakeJudgeEngine('active', { action: 'route', choice: REJECTION_REJECTED }),
      });
      expect(result).toEqual({ asked: true, recorded: true });

      const rows = eventRows(harness.db, 'persona.rejected');
      expect(rows).toHaveLength(1);
      const details = detailsOf(rows[0]!);
      expect(details.weight).toBe(PERSONA_FEEDBACK_WEIGHTS['persona.rejected']);
      expect(details.sessionId).toBe('sess-1');
      expect(String(details.message)).toContain('我没说过');
      expect(details.judgeId).toBe('test-judge');
    });

    it('records persona.manual_override with the highest weight and the changed fields', () => {
      const result = harness.feedback.recordManualOverride({
        before: personaWithLanguages(['JavaScript']),
        after: personaWithLanguages(['TypeScript']),
      });
      expect(result.recorded).toBe(true);
      expect(result.fields).toEqual(['preferences.languages']);

      const rows = eventRows(harness.db, 'persona.manual_override');
      expect(rows).toHaveLength(1);
      const details = detailsOf(rows[0]!);
      expect(details.weight).toBe(Math.max(...Object.values(PERSONA_FEEDBACK_WEIGHTS)));
      expect(details.fields).toEqual(['preferences.languages']);
      expect(details.diff).toEqual({
        'preferences.languages': { from: ['JavaScript'], to: ['TypeScript'] },
      });
    });

    it('records no manual_override event when the edit changed nothing', () => {
      const result = harness.feedback.recordManualOverride({
        before: personaWithLanguages(['TypeScript']),
        after: personaWithLanguages(['TypeScript']),
      });
      expect(result).toEqual({ fields: [], closedIds: [], recorded: false });
      expect(eventRows(harness.db, 'persona.manual_override')).toHaveLength(0);
    });

    it('records persona.contradicted for a conflicting preference memory', () => {
      expect(
        harness.feedback.recordContradiction({
          memoryId: 'mem-rust',
          content: '用户改用 Rust 写服务',
          field: 'preferences.languages',
          personaValue: 'TypeScript',
        }),
      ).toBe(true);

      const rows = eventRows(harness.db, 'persona.contradicted');
      expect(rows).toHaveLength(1);
      const details = detailsOf(rows[0]!);
      expect(details.weight).toBe(PERSONA_FEEDBACK_WEIGHTS['persona.contradicted']);
      expect(details.memoryId).toBe('mem-rust');
      expect(details.field).toBe('preferences.languages');
      expect(details.personaValue).toBe('TypeScript');
    });

    it('keeps the three signal weights strictly increasing with manual override highest', () => {
      const weights = PERSONA_FEEDBACK_WEIGHTS;
      expect(weights['persona.rejected']).toBeLessThan(weights['persona.contradicted']);
      expect(weights['persona.contradicted']).toBeLessThan(weights['persona.manual_override']);
    });
  });

  // -----------------------------------------------------------------------
  // context injection with provenance
  // -----------------------------------------------------------------------

  describe('toContextString({ withProvenance })', () => {
    it('appends the source memories when asked for them', async () => {
      seedPreference('mem-ts', '用户使用 TypeScript 开发');
      harness.store.save(personaWithLanguages(['TypeScript']));
      await makeDistiller(personaWithLanguages(['TypeScript'])).rebuildFull();

      let store: PersonaStore;
      store = new PersonaStore(
        harness.repo,
        new PersonaProvenanceQuery(harness.db, { persona: () => store.get() }),
      );
      const plain = store.toContextString();
      expect(plain).not.toContain('画像来源');

      const withProvenance = store.toContextString({ withProvenance: true });
      expect(withProvenance).toContain('画像来源');
      expect(withProvenance).toContain('用户使用 TypeScript 开发');
      expect(withProvenance).toContain('mem-ts');
    });

    it('marks a field whose sources were closed as stale', async () => {
      seedPreference('mem-ts', '用户使用 TypeScript 开发');
      seedPreference('mem-js', '用户偏好使用 JavaScript 开发');
      harness.store.save(personaWithLanguages(['JavaScript']));
      await makeDistiller(personaWithLanguages(['TypeScript'])).rebuildFull();
      harness.repo.supersede('mem-ts', 'mem-js');

      let store: PersonaStore;
      store = new PersonaStore(
        harness.repo,
        new PersonaProvenanceQuery(harness.db, { persona: () => store.get() }),
      );
      const text = store.toContextString({ withProvenance: true });
      expect(text).toContain('[stale]');
    });

    it('degrades to the plain snippet when no provenance source is wired', () => {
      harness.store.save(personaWithLanguages(['TypeScript']));
      const text = harness.store.toContextString({ withProvenance: true });
      expect(text).toContain('用户画像');
      expect(text).not.toContain('画像来源');
    });
  });

  // -----------------------------------------------------------------------
  // field geometry
  // -----------------------------------------------------------------------

  describe('field geometry', () => {
    it('diffPersonaFields ignores bookkeeping and reports only real claims', () => {
      const before = personaWithLanguages(['JavaScript']);
      const after = personaWithLanguages(['TypeScript']);
      after.stats.totalMessages = 42;
      after.lastUpdated = '2030-01-01T00:00:00.000Z';

      expect(diffPersonaFields(before, after)).toEqual({
        'preferences.languages': { from: ['JavaScript'], to: ['TypeScript'] },
      });
      expect(diffPersonaFields(after, after)).toEqual({});
    });

    it('renders and tokenizes a field value for memory matching', () => {
      expect(personaFieldText(['TypeScript', 'Rust'])).toBe('TypeScript, Rust');
      expect(personaValueTokens(['TypeScript', 'Rust'])).toEqual(['typescript', 'rust']);
      // Prose is not matchable — it would match noise.
      expect(personaValueTokens('a very long summary '.repeat(10))).toEqual([]);
    });
  });
});
