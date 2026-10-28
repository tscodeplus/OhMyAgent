/**
 * Hard delete of one session and everything hanging off it.
 *
 * Extracted from the project-session DELETE route so the IM inbox can offer the
 * same "delete this conversation" action without a second, subtly different
 * cascade. The order matters and is the reason this is one transaction rather
 * than a cascade declared in the schema:
 *
 *   approval_decisions → approval_requests → (session_key)
 *   messages / episodes / tool_runs / session-scoped memories → sessions(id)
 *
 * FK checks are switched off for the duration: leaf rows are removed explicitly
 * in dependency order, and leaving the pragma on would abort on the first
 * `approval_requests` delete rather than continue down the chain.
 *
 * The FTS index is cleaned here too. It is not a FK child, so nothing else would
 * notice a deleted session — its messages would keep coming back as full-text
 * hits pointing at a transcript that no longer exists.
 */

import type Database from 'better-sqlite3';
import { deleteSessionMessageFts } from './fts.js';

export interface DeletedSessionSummary {
  /** Messages removed with the session (0 for an empty conversation). */
  messages: number;
}

export function deleteSessionCascade(
  db: Database.Database,
  sessionId: string,
): DeletedSessionSummary {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    const run = db.transaction((): DeletedSessionSummary => {
      db.prepare(
        'DELETE FROM approval_decisions WHERE request_id IN (SELECT id FROM approval_requests WHERE session_key = ?)',
      ).run(sessionId);
      db.prepare('DELETE FROM approval_requests WHERE session_key = ?').run(sessionId);
      const messages = db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
      db.prepare('DELETE FROM episodes WHERE session_id = ?').run(sessionId);
      db.prepare('DELETE FROM tool_runs WHERE session_id = ?').run(sessionId);
      db.prepare("DELETE FROM memories WHERE scope = 'session' AND scope_key = ?").run(sessionId);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      // Inside the transaction, after the rows are gone: an index entry without a
      // message is harmless to the reverse case, so the order is chosen so a
      // rolled-back transaction leaves no stale hits either way.
      deleteSessionMessageFts(db, sessionId);
      return { messages: messages.changes };
    });
    return run();
  } finally {
    try {
      db.exec('PRAGMA foreign_keys = ON');
    } catch {
      /* the connection is closing; the pragma is per-connection anyway */
    }
  }
}
