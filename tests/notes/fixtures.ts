/**
 * Fixtures for the notes tests.
 *
 * The database is built by the real `openDatabase(':memory:')`, so the tests run
 * against the real migration chain (v31 included) rather than hand-rolled DDL —
 * a hand-rolled table would let the migration drift from what the repository
 * expects without any test failing.
 */

import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db.js';
import { NotesRepository } from '../../src/notes/repository.js';
import { CapturePipeline } from '../../src/notes/capture.js';
import { createNotesService } from '../../src/notes/service.js';
import type { NotesRuntimeConfig, NotesService } from '../../src/notes/service-contract.js';
import type { DistillOutcome } from '../../src/notes/distill.js';

export const SESSION_ID = 'session-notes-1';
export const CHAT_ID = 'oc_notes_group';
export const PROJECT_ID = 'proj-notes-1';

export const MESSAGE_USER = 'msg-notes-user-1';
export const MESSAGE_ASSISTANT = 'msg-notes-assistant-1';

/** The exchange itself, exported so a recap test can quote it character for character. */
export const USER_CONTENT =
  'vitest 全量跑太慢，怎么只跑改过的？我现在每次改一个文件都要等七十秒，而且并行跑两个 session 的时候机器直接卡住，连编辑器都跟着卡。';
export const ASSISTANT_CONTENT =
  '改动少于 3 个文件时只跑那一个：\n\n```bash\nnpx vitest run tests/agent\n```\n\n并发跑会互相拖慢。';

const NOW = 1_780_000_000_000;

export const RUNTIME_CONFIG: NotesRuntimeConfig = {
  maxNotesPerCapture: 3,
  windowTurns: 5,
  tokenBudget: 4000,
  includeTools: 'off',
  redact: true,
  bodyMaxChars: 1200,
  thinking: 'inherit',
  temperature: 0.2,
  ttlDays: 14,
  logRetentionDays: 90,
  modelRef: '',
};

/** A project + a session with one exchange, i.e. the smallest real capture window. */
export function openSeededDatabase(): Database.Database {
  const db = openDatabase(':memory:');

  db.prepare(
    `INSERT INTO projects (id, name, agent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(PROJECT_ID, 'OhMyAgent', 'default', String(NOW), String(NOW));

  db.prepare(
    `INSERT INTO sessions (id, chat_id, user_id, channel, project_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SESSION_ID,
    CHAT_ID,
    'user-notes',
    'webui',
    PROJECT_ID,
    '笔记测试',
    String(NOW),
    String(NOW),
  );

  const insert = db.prepare(
    `INSERT INTO messages (id, session_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  insert.run(MESSAGE_USER, SESSION_ID, 'user', USER_CONTENT, String(NOW));
  insert.run(MESSAGE_ASSISTANT, SESSION_ID, 'assistant', ASSISTANT_CONTENT, String(NOW + 1000));

  return db;
}

/** One recorded distiller call, so a test can assert on what the model was told. */
export interface DistillationCall {
  windowText: string;
  windowIds: string[];
  maxNotes: number;
  instruction?: string;
  hint?: string;
  /** What a model-reported scope permits — the real validator runs it. */
  scopeIds?: (scope: { turns?: number; chars?: number }) => Set<string>;
}

export function cannedDistill(
  notes: DistillOutcome['notes'],
  calls: DistillationCall[] = [],
  scope?: DistillOutcome['scope'],
): (input: DistillationCall) => Promise<DistillOutcome> {
  return async (input) => {
    calls.push(input);
    return { notes, rejected: [], kindFallbacks: [], rawChars: 0, scope };
  };
}

export interface TestServiceOptions {
  distillNotes?: DistillOutcome['notes'];
  /** What the model reports about the brief's scope, when the test cares. */
  distillScope?: DistillOutcome['scope'];
  config?: Partial<NotesRuntimeConfig>;
}

export function createTestService(
  db: Database.Database,
  options: TestServiceOptions = {},
): { service: NotesService; repository: NotesRepository; distillationCalls: DistillationCall[] } {
  const repository = new NotesRepository(db);
  const distillationCalls: DistillationCall[] = [];
  const config: NotesRuntimeConfig = { ...RUNTIME_CONFIG, ...options.config };
  const pipeline = new CapturePipeline({
    repository,
    db,
    getConfig: () => config,
    // A capture never calls the model in tests: the seam is the distiller itself.
    auxConfig: {},
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as never,
    distill: cannedDistill(
      options.distillNotes ?? [defaultDistilled()],
      distillationCalls,
      options.distillScope,
    ),
  });
  const service = createNotesService({
    repository,
    capture: pipeline,
    getConfig: () => config,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as never,
  });
  return { service, repository, distillationCalls };
}

/** The one draft the canned distiller returns, citing both messages of the fixture. */
export function defaultDistilled(): DistillOutcome['notes'][number] {
  return {
    kind: 'command',
    title: 'vitest 单文件迭代',
    summary: '改哪个文件就跑哪个',
    body: '改动少于 3 个文件时只跑改动的那个：\n\n```bash\nnpx vitest run tests/agent\n```\n\n并发跑会互相拖慢。',
    fields: [{ key: 'command', value: 'npx vitest run tests/agent', mono: true }],
    tags: ['testing', 'vitest'],
    evidence: [MESSAGE_ASSISTANT],
    confidence: 0.82,
  };
}
