/**
 * Batch Session Delete
 *
 * The sidebar lists conversations in three places — a project's session list, the
 * IM inbox, and 归档 — and all three offer 删除, both on a single row and on a
 * multi-select. Rather than three delete endpoints with three chances to drift,
 * this module owns one batch write: `POST /api/sessions/delete` takes ids from
 * any of the trees and routes each row to the delete path its kind needs.
 *
 * Two paths, because the two kinds differ in one way that matters:
 *   - Project chat: `deleteSessionCascade` — the row and all its children go.
 *   - IM transcript: `ConversationSessions.forget` — same cascade, plus a new
 *     generation of the chat's transcript, so incoming messages cannot silently
 *     resume the conversation that was just removed.
 *
 * A batch is *partial by design*. Deleting 20 selected rows must not fail as a
 * whole because one of them is mid-reply or was already deleted on another
 * device: the response reports what was deleted and what was skipped, with a
 * machine-readable reason, and the UI states the difference instead of hiding it.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { ConversationSessions } from '../../memory/conversation-sessions.js';
import { deleteSessionCascade } from '../../memory/session-delete.js';

/** Upper bound on a single batch write — the sidebar selects at most a page. */
const MAX_BATCH_IDS = 500;

/** Why a selected id was not deleted. Keys, not prose: the UI localizes them. */
export type DeleteSkipReason = 'not_found' | 'running' | 'failed';

export interface SessionDeleteHooks {
  /** A turn in flight would keep writing into the row being deleted. */
  isRunning?: (sessionId: string) => boolean;
  /**
   * The agent holds the transcript in memory; deleting the rows has to drop that
   * too, or the next reply answers from history the operator deleted.
   */
  destroyRuntime?: (sessionId: string) => void;
}

export interface SkippedSession {
  id: string;
  reason: DeleteSkipReason;
}

export interface DeleteSessionsResult {
  ok: true;
  deleted: number;
  skipped: SkippedSession[];
  /**
   * Replacement transcript opened for a deleted IM conversation that was the
   * chat's current one, keyed by the deleted id. Lets the inbox keep the pane on
   * the same chat instead of jumping to whatever row happens to be newest.
   */
  replacements: Record<string, string | null>;
}

export function registerSessionDeleteRoutes(
  app: FastifyInstance,
  db: Database.Database,
  hooks?: SessionDeleteHooks,
): void {
  const conversations = new ConversationSessions(db);

  app.post('/api/sessions/delete', async (request, reply) => {
    const body = (request.body ?? {}) as { ids?: unknown };
    const { ids } = body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return reply
        .status(400)
        .send({ error: 'Bad Request', message: 'ids must be a non-empty array' });
    }
    if (ids.length > MAX_BATCH_IDS) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: `ids must contain at most ${MAX_BATCH_IDS} entries`,
      });
    }
    const validIds: string[] = [];
    for (const id of ids) {
      if (typeof id !== 'string' || id.length === 0) {
        return reply
          .status(400)
          .send({ error: 'Bad Request', message: 'ids must be non-empty strings' });
      }
      validIds.push(id);
    }

    const lookup = db.prepare('SELECT id, project_id FROM sessions WHERE id = ?');
    const skipped: SkippedSession[] = [];
    const replacements: Record<string, string | null> = {};
    let deleted = 0;

    // Deduplicated: a selection that lists an id twice must not delete (or, worse,
    // try to forget the same IM slot) twice.
    for (const id of new Set(validIds)) {
      const row = lookup.get(id) as { id: string; project_id: string | null } | undefined;
      if (!row) {
        skipped.push({ id, reason: 'not_found' });
        continue;
      }
      if (hooks?.isRunning?.(id)) {
        skipped.push({ id, reason: 'running' });
        continue;
      }

      try {
        if (row.project_id === null) {
          const result = conversations.forget(id);
          if (!result.deleted) {
            skipped.push({ id, reason: 'not_found' });
            continue;
          }
          replacements[id] = result.replacementId;
        } else {
          deleteSessionCascade(db, id);
        }
        deleted += 1;
        // After the rows are gone, so a failure here cannot leave a live runtime
        // pointing at a transcript that still exists.
        hooks?.destroyRuntime?.(id);
      } catch (err) {
        // One bad row must not abandon the rest of the batch; surface it as a
        // skip the operator can see rather than a 500 that reads as "nothing
        // happened" while some rows are already gone.
        request.log.warn({ err, sessionId: id }, 'batch delete: session failed');
        skipped.push({ id, reason: 'failed' });
      }
    }

    const result: DeleteSessionsResult = { ok: true, deleted, skipped, replacements };
    return reply.send(result);
  });
}
