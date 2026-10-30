/**
 * Migration v28: redact credentials that are already stored as memories.
 *
 * `MemoryWriter` / `MemoryRepository` now mask a secret on the way in
 * (`redactSecrets`), but a row written before that is replayed forever: it is a
 * `<memory_context>` candidate, an FTS hit, a knowledge-page source and a line in
 * the Obsidian export. The device corpus carried two — a `sk-…` API key stored as
 * a `preference`, and a `Clawvard exam token` JWT in a user-scoped memory that the
 * per-turn injection then quoted back into a model context.
 *
 * Deliberately data-repairing rather than schema-changing, and deliberately
 * narrow:
 *
 *   - **Only `memories`.** `messages` holds the same string in the transcript it
 *     was pasted into. Rewriting a conversation is a different decision (the
 *     transcript is the record of what was said), and the leak there is bounded
 *     to that session, while a memory is replayed into every later one.
 *   - **Redact, never delete.** The sentence around the key still says something
 *     real ("用户使用 API 密钥 … 进行查询"), and deleting the row would take the
 *     `memory_sources` / `knowledge_sources` provenance with it.
 *   - **Cheap probe, exact decision.** The `LIKE` prefilter is only there so the
 *     full table is not walked through six regexes on every open; whether a row
 *     matches is decided by `redactSecrets`, the same function the write path
 *     uses. That is what keeps this idempotent — a masked row redacts to itself,
 *     so the second run of the migration is a no-op.
 *
 * The FTS index is re-synced per row (`syncJiebaFts`), or the masked text would
 * be searchable under the secret's tokens. The stored vector is left alone: the
 * masked text differs by one token, not by a subject, and re-embedding the whole
 * hit set on a phone's first boot is the expensive kind of correct.
 *
 * Runs AFTER `applySchema` (it repairs rows, not the schema) and replays on every
 * open, like v20–v27.
 */

import type Database from 'better-sqlite3';
import { syncJiebaFts } from './fts.js';
import { redactSecrets } from './memory-filter.js';

export interface MigrateV28Result {
  /** Rows the LIKE prefilter produced (0 on a clean database). */
  scanned: number;
  /** Rows actually rewritten by this call (0 on a re-run). */
  redacted: number;
  /** `kind` values of the rewritten rows, for the boot log. */
  kinds: string[];
}

/** Cheap prefilter: the literal prefixes `redactSecrets` looks for. */
const SECRET_HINTS = [
  '%eyJ%',
  '%sk-%',
  '%rk-%',
  '%pk-%',
  '%ghp_%',
  '%github_pat_%',
  '%AKIA%',
  '%xoxb-%',
  '%xoxp-%',
  '%AIza%',
  '%PRIVATE KEY%',
];

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
    .get('table', table) as { name: string } | undefined;
  return row !== undefined;
}

export function migrateV28(db: Database.Database): MigrateV28Result {
  const result: MigrateV28Result = { scanned: 0, redacted: 0, kinds: [] };
  if (!tableExists(db, 'memories')) return result;

  const where = SECRET_HINTS.map((hint) => 'content LIKE ?').join(' OR ');
  const rows = db
    .prepare(`SELECT id, kind, scope, scope_key, content, created_at FROM memories WHERE ${where}`)
    .all(...SECRET_HINTS) as Array<{
    id: string;
    kind: string;
    scope: string;
    scope_key: string | null;
    content: string;
    created_at: string;
  }>;
  result.scanned = rows.length;

  const update = db.prepare('UPDATE memories SET content = ? WHERE id = ?');
  for (const row of rows) {
    const redacted = redactSecrets(row.content);
    if (redacted === row.content) continue;
    update.run(redacted, row.id);
    syncJiebaFts(db, 'update', {
      id: row.id,
      content: redacted,
      kind: row.kind,
      scope: row.scope,
      scope_key: row.scope_key ?? '',
      created_at: row.created_at,
    });
    result.redacted++;
    if (!result.kinds.includes(row.kind)) result.kinds.push(row.kind);
  }
  return result;
}
