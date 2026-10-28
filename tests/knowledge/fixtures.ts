/**
 * Shared fixture for the knowledge tests.
 *
 * The database is built by the real `openDatabase(':memory:')`, i.e. the real
 * migration chain, so the tests exercise the schema production runs — hand-rolled
 * DDL would let v14 drift from what the repository expects without a failure.
 *
 * Citation targets are seeded here because they are the anti-hallucination
 * gate's real inputs: a `memory`/`message`/`session` row must exist before a page
 * may cite it.
 */

import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db.js';
import { KnowledgeRepository } from '../../src/memory/knowledge/repository.js';
import {
  createKnowledgeService,
  type KnowledgeServiceDeps,
} from '../../src/memory/knowledge/service.js';
import type { KnowledgeService } from '../../src/memory/knowledge/service-contract.js';
import type { KnowledgeSourceInput } from '../../src/memory/knowledge/types.js';

export const SESSION_ID = 'session-knowledge-1';
export const MESSAGE_ID = 'message-knowledge-1';
export const MEMORY_A = 'memory-knowledge-a';
export const MEMORY_B = 'memory-knowledge-b';
export const MEMORY_C = 'memory-knowledge-c';

/** Two memories, a message and a session — enough for the ≥2-sources rule. */
export const TWO_MEMORY_SOURCES: KnowledgeSourceInput[] = [
  { kind: 'memory', id: MEMORY_A },
  { kind: 'memory', id: MEMORY_B },
];

const NOW = 1_780_000_000_000;

export function openSeededDatabase(): Database.Database {
  const db = openDatabase(':memory:');
  const at = String(NOW);

  db.prepare(
    `INSERT INTO sessions (id, chat_id, user_id, channel, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(SESSION_ID, 'chat-knowledge', 'user-knowledge', 'webui', at, at);

  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, created_at)
     VALUES (?, ?, 'user', ?, ?)`,
  ).run(MESSAGE_ID, SESSION_ID, 'Excel 里我们用 Power Query 清洗数据', at);

  const insertMemory = db.prepare(
    `INSERT INTO memories (id, scope, scope_key, kind, content, confidence, created_at, updated_at)
     VALUES (?, 'user', 'user-knowledge', 'fact', ?, 0.9, ?, ?)`,
  );
  insertMemory.run(MEMORY_A, 'Power Query 替代了手工 VLOOKUP', at, at);
  insertMemory.run(MEMORY_B, 'Excel ETL 走 Power Query + Python', at, at);
  insertMemory.run(MEMORY_C, '只在一条记忆里出现过的事实', at, at);

  return db;
}

export function knowledgeRepository(db: Database.Database): KnowledgeRepository {
  return new KnowledgeRepository(db);
}

export function knowledgeService(
  db: Database.Database,
  config?: KnowledgeServiceDeps['config'],
): KnowledgeService {
  return createKnowledgeService({ db, config });
}
