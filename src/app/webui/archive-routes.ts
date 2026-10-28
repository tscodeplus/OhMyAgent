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
import {
  SessionRepository,
  autoArchiveCutoff,
} from '../../memory/repositories/session-repository.js';
import { resolveBotNames, type BotNameResolver } from './bot-names.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Upper bound on a single batch write — the sidebar selects at most a page. */
const MAX_BATCH_IDS = 500;
/** Mirrors the maintenance job's batch cap, so "run now" leaves the same backlog. */
const AUTO_ARCHIVE_BATCH_LIMIT = 500;

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

export interface ArchiveAutoSettings {
  enabled: boolean;
  days: number;
}

/** What the auto-archive endpoints need from the rest of the app. */
export interface ArchiveAutoHooks {
  /** Live config read — the settings row is saved to config.yaml, not the DB. */
  getAutoConfig?: () => ArchiveAutoSettings | undefined;
  /** A conversation with a turn in flight is never archived by the sweep. */
  isRunning?: (sessionId: string) => boolean;
}

/** Clamp `days` for the preview: same range the config schema accepts (1..3650). */
function parseDays(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(1, parsed), 3650);
}

export function registerArchiveRoutes(
  app: FastifyInstance,
  db: Database.Database,
  /** Same resolver the inbox uses, so both trees label a channel identically. */
  getBotName?: BotNameResolver,
  autoHooks?: ArchiveAutoHooks,
): void {
  const sessionRepository = new SessionRepository(db);

  /**
   * How many conversations the auto-archive sweep would flag right now.
   *
   * Exists so the settings card can say "turning this on archives N conversations"
   * before the operator flips the switch: enabling the feature on a long-lived
   * install mass-moves the backlog on the first tick, and a batch that size
   * deserves to be visible first. `days` may be passed unsaved (the field is
   * being edited), which is why it overrides the stored value.
   */
  app.get('/api/archive/auto/preview', async (request, reply) => {
    const { days: daysParam } = request.query as { days?: string };
    const configured = autoHooks?.getAutoConfig?.();
    const days = parseDays(daysParam, configured?.days ?? 30);
    return reply.send({
      days,
      enabled: configured?.enabled === true,
      count: sessionRepository.countAutoArchiveCandidates(days),
      cutoff: autoArchiveCutoff(days),
    });
  });

  /**
   * Run the sweep immediately instead of waiting for the hourly tick.
   *
   * Refused while the feature is disabled: the button only makes sense for an
   * enabled setting, and silently archiving a backlog for a feature the operator
   * has not turned on (because they left the form unsaved) is the one surprise
   * this endpoint must not produce.
   */
  app.post('/api/archive/auto/run', async (request, reply) => {
    const configured = autoHooks?.getAutoConfig?.();
    if (!configured?.enabled) {
      return reply.status(409).send({
        error: 'Conflict',
        message: '自动归档未开启（请先保存设置）',
      });
    }

    const ids = sessionRepository
      .listAutoArchiveCandidates(configured.days, AUTO_ARCHIVE_BATCH_LIMIT)
      .filter((id) => !autoHooks?.isRunning?.(id));
    const archived = ids.length > 0 ? sessionRepository.setArchived(ids, true) : 0;

    return reply.send({
      ok: true,
      archived,
      days: configured.days,
      cutoff: autoArchiveCutoff(configured.days),
      remaining: sessionRepository.countAutoArchiveCandidates(configured.days),
      hitCap: ids.length === AUTO_ARCHIVE_BATCH_LIMIT,
    });
  });

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
