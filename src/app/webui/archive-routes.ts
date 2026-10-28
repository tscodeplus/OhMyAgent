/**
 * Archive API Routes
 *
 * The WebUI lists active conversations in two trees: project chats
 * (`/api/projects/:projectId/sessions`) and the IM inbox (`/api/inbox`). Both
 * answer 归档 the same way — the row keeps its `project_id`/`channel`, gains
 * `archived_at`, and disappears from its own list. This module owns the
 * archive's own listing and the batch flag write.
 *
 * Design notes:
 *   - Archive is a WebUI list-visibility fact only. Memory retrieval, unified
 *     search, the knowledge graph and IM delivery all ignore `archived_at`, so
 *     archiving a conversation can never make the agent forget it.
 *   - The archive list is grouped by the owner the row had *before* archiving
 *     (project name, or channel + bot name), which is what the sidebar renders:
 *     finding an archived conversation still follows the old mental map.
 *   - Ordering is by `archived_at` DESC — newest archive first — because within
 *     an owner bucket "what did I just put away" is the useful order.
 *   - Auto-restore lives elsewhere: when an archived conversation receives a new
 *     turn, `SessionRepository.clearArchive()` drops the flag (see
 *     AgentService). There is no "silently swallow new messages" mode.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { SessionRepository } from '../../memory/repositories/session-repository.js';
import { resolveBotNames, type BotNameResolver } from './bot-names.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Upper bound on a single batch write — the sidebar selects at most a page. */
const MAX_BATCH_IDS = 500;

/** Clamp `limit` to 1..MAX_LIMIT, falling back to the default when unparsable. */
function parseLimit(raw: string | undefined): number {
  const parsed = parseInt(raw ?? String(DEFAULT_LIMIT), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, parsed), MAX_LIMIT);
}

/** `before` is an exclusive epoch-ms cursor; anything unparsable means "no cursor". */
function parseBefore(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `kind` filter: anything other than the two known trees is a client bug. */
function parseKind(raw: string | undefined): 'project' | 'inbox' | undefined | null {
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'project' || raw === 'inbox') return raw;
  return null;
}

export function registerArchiveRoutes(
  app: FastifyInstance,
  db: Database.Database,
  /** Same resolver the inbox uses, so both trees label a channel identically. */
  getBotName?: BotNameResolver,
): void {
  const sessionRepository = new SessionRepository(db);

  // Archived conversations, paged. Both trees in one list; `kind` narrows it.
  app.get('/api/archive', async (request, reply) => {
    const {
      kind: kindParam,
      limit: limitParam,
      before: beforeParam,
    } = request.query as { kind?: string; limit?: string; before?: string };

    const kind = parseKind(kindParam);
    if (kind === null) {
      return reply
        .status(400)
        .send({ error: 'Bad Request', message: `Unknown kind: ${String(kindParam)}` });
    }

    const limit = parseLimit(limitParam);
    const before = parseBefore(beforeParam);

    // One extra row decides `hasMore` without a second COUNT query.
    const rows = sessionRepository.listArchived({ kind, limit: limit + 1, before });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    const owners = sessionRepository.countArchivedByOwner();
    // Only inbox owners carry a channel, so only those need a bot name.
    const botNames = await resolveBotNames(
      getBotName,
      owners.filter((owner) => owner.kind === 'inbox').map((owner) => owner.channel ?? 'unknown'),
    );

    return reply.send({
      items,
      hasMore,
      owners: owners.map((owner) => {
        if (owner.kind !== 'inbox' || !owner.channel) return owner;
        const botName = botNames.get(owner.channel);
        return botName ? { ...owner, bot_name: botName } : owner;
      }),
    });
  });

  // Archive (`archived: true`, the default) or restore a batch of conversations.
  // Ids from both trees are accepted: the flag is row-scoped, so the caller does
  // not have to say which list a conversation came from.
  app.post('/api/archive', async (request, reply) => {
    const body = (request.body ?? {}) as { ids?: unknown; archived?: unknown };
    const { ids } = body;
    const archived = body.archived === undefined ? true : body.archived;

    if (typeof archived !== 'boolean') {
      return reply
        .status(400)
        .send({ error: 'Bad Request', message: 'archived must be a boolean' });
    }
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

    const updated = sessionRepository.setArchived(validIds, archived);
    // `updated` counts rows that actually changed: re-archiving an archived
    // conversation (or restoring an active one) is a no-op, not an error, so the
    // UI can send a selection that a concurrent device already moved.
    return reply.send({ ok: true, updated });
  });
}
