import type Database from 'better-sqlite3';
import { parseEpochMs } from '../../shared/timestamp.js';

export interface Session {
  id: string;
  chat_id: string;
  thread_id: string | null;
  user_id: string;
  /** Set by migration v9; NULL on rows written by older releases. */
  channel: string | null;
  /** Transport handle when it differs from `id` (WebUI ids are uuids). */
  external_chat_id: string | null;
  /** Plain title column; `metadata.title` remains the source of truth for old rows. */
  title: string | null;
  created_at: string;
  updated_at: string;
  metadata: string | null;
}

export interface CreateSessionInput {
  id: string;
  chat_id: string;
  thread_id?: string | null;
  user_id: string;
  metadata?: string | null;
  channel?: string | null;
  external_chat_id?: string | null;
  title?: string | null;
}

export interface UpdateSessionInput {
  chat_id?: string;
  thread_id?: string | null;
  user_id?: string;
  metadata?: string | null;
  channel?: string | null;
  external_chat_id?: string | null;
  title?: string | null;
}

/** One inbox row: an IM session plus the summary fields the list needs. */
export interface InboxSessionSummary {
  id: string;
  channel: string | null;
  external_chat_id: string | null;
  title: string | null;
  /** Epoch milliseconds, NOT the raw TEXT column value — the WebUI sorts and
   *  formats these directly and `new Date('1791372138000')` is Invalid Date. */
  updated_at: number;
  created_at: number;
  message_count: number;
  /** Newest message content, truncated by the caller-facing projection. */
  preview: string;
}

export interface ListInboxOptions {
  /** Restrict to one channel; omit for every IM channel. */
  channel?: string;
  limit: number;
  /** Exclusive `updated_at` cursor — only sessions strictly older than this. */
  before?: number;
  /**
   * Tie-breaker for `before`: the id of the cursor row itself.
   *
   * `updated_at` is not unique — a batch write stamps several rows with the
   * same millisecond — so a cursor that compares the timestamp alone skips every
   * row that shares it once the page boundary falls inside that group. Supplying
   * the id turns the cursor into the pair `(updated_at, id)`, which is unique.
   * Omitted means "match the timestamp strictly", i.e. the older single-field
   * behaviour, kept for callers that do not track ids.
   */
  beforeId?: string;
  /**
   * Include archived conversations. Default false: the inbox lists what is
   * active, and archived rows live under `listArchived` / `GET /api/archive`.
   */
  includeArchived?: boolean;
}

/** One archived conversation, with the owner it should be grouped under. */
export interface ArchivedSessionRow {
  id: string;
  /** Which sidebar tree the row came from. */
  kind: 'project' | 'inbox';
  project_id: string | null;
  /** Project name for `kind: 'project'` rows (NULL once the project is gone). */
  project_name: string | null;
  channel: string | null;
  external_chat_id: string | null;
  title: string | null;
  /** Epoch ms (see `parseEpochMs`); the row's own last-activity time. */
  updated_at: number;
  /** Epoch ms; when the conversation was archived (not what the list orders by). */
  archived_at: number;
  message_count: number;
  preview: string;
}

export interface ListArchivedOptions {
  limit: number;
  /** Exclusive `updated_at` cursor — only conversations last active before this. */
  before?: number;
  /** Tie-breaker for `before` (see `ListInboxOptions.beforeId`). */
  beforeId?: string;
  kind?: 'project' | 'inbox';
}

/** One page of a project's own chats (对话 list). */
export interface ListProjectSessionsOptions {
  projectId: string;
  /** Page size; the caller passes `limit + 1` to detect `hasMore` in one query. */
  limit: number;
  /** Exclusive `updated_at` cursor — only conversations last active before this. */
  before?: number;
  /** Tie-breaker for `before` (see `ListInboxOptions.beforeId`). */
  beforeId?: string;
  /**
   * Include archived conversations. Default false — same rule as the inbox:
   * archived rows belong to `listArchived` / `GET /api/archive`.
   */
  includeArchived?: boolean;
  /** Narrow the page to one known session (used to resolve an open chat's title). */
  id?: string;
}

/** Owner bucket for the archive sidebar's group headers. */
export interface ArchivedOwnerCount {
  kind: 'project' | 'inbox';
  project_id: string | null;
  project_name: string | null;
  channel: string | null;
  count: number;
}

/** Longest preview the inbox list renders (truncated in TS, not in SQL). */
const PREVIEW_MAX_CHARS = 120;

/**
 * Cursor predicate for the paged session lists, i.e. "everything after the row
 * the client last saw" under `ORDER BY updated_at DESC, id DESC`.
 *
 * Two things make this more than `updated_at < ?`:
 *
 *   - `updated_at` is not unique. `setArchived` stamps a whole batch with one
 *     `Date.now()`, and several sessions can be created in the same millisecond,
 *     so a boundary that falls inside such a group would silently drop the rest
 *     of it. The id completes the key: `(updated_at, id)` is unique, and since
 *     both lists sort ids DESC the residual group is walked in the same
 *     direction.
 *   - the column is TEXT holding epoch-ms digit strings, so the cursor is bound
 *     as text too. Binding a number makes SQLite compare across storage classes
 *     and lets the cursor row itself through on the next page.
 *
 * Returns `null` when there is no cursor. Mirrored by the two WebUI lists
 * (收件箱 / 归档), which send the last row's `updated_at` *and* `id`.
 */
function sessionCursorWhere(
  options: { before?: number; beforeId?: string },
  params: Record<string, unknown>,
): string | null {
  if (options.before === undefined) return null;
  params.before = String(options.before);
  if (options.beforeId === undefined || options.beforeId === '') {
    // Legacy single-field cursor: strictly older, ties beyond the boundary lost.
    return 's.updated_at < @before';
  }
  params.beforeId = options.beforeId;
  return '(s.updated_at < @before OR (s.updated_at = @before AND s.id < @beforeId))';
}

/**
 * Activity cutoff for auto-archive: sessions untouched before this are eligible.
 * Exported so the job, the preview route and their tests compute it one way.
 */
export function autoArchiveCutoff(days: number, now: number = Date.now()): number {
  return now - days * 86_400_000;
}

/**
 * Exemption clause for both auto-archive queries. The bound parameter is the same
 * cutoff used for `updated_at`: an exemption lives for one more inactivity window
 * (see `setArchived`'s `exemptUntil`), so "exempt until X" and "active after X"
 * are the same instant and a restored conversation ages into eligibility exactly
 * like any other.
 */
const AUTO_ARCHIVE_EXEMPT_FILTER =
  '(archive_exempt_until IS NULL OR CAST(archive_exempt_until AS INTEGER) < ?)';

export class SessionRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(input: CreateSessionInput): Session {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, chat_id, thread_id, user_id, metadata, channel, external_chat_id, title)
      VALUES (@id, @chat_id, @thread_id, @user_id, @metadata, @channel, @external_chat_id, @title)
    `);
    stmt.run({
      id: input.id,
      chat_id: input.chat_id,
      thread_id: input.thread_id ?? null,
      user_id: input.user_id,
      metadata: input.metadata ?? null,
      channel: input.channel ?? null,
      external_chat_id: input.external_chat_id ?? null,
      title: input.title ?? null,
    });
    return this.findById(input.id)!;
  }

  findById(id: string): Session | undefined {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    const row = stmt.get(id) as Session | undefined;
    return row ?? undefined;
  }

  findByChatId(chatId: string): Session[] {
    const stmt = this.db.prepare(
      'SELECT * FROM sessions WHERE chat_id = ? ORDER BY created_at DESC',
    );
    return stmt.all(chatId) as Session[];
  }

  update(id: string, input: UpdateSessionInput): Session | undefined {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    if (input.chat_id !== undefined) {
      fields.push('chat_id = @chat_id');
      values.chat_id = input.chat_id;
    }
    if (input.thread_id !== undefined) {
      fields.push('thread_id = @thread_id');
      values.thread_id = input.thread_id;
    }
    if (input.user_id !== undefined) {
      fields.push('user_id = @user_id');
      values.user_id = input.user_id;
    }
    if (input.metadata !== undefined) {
      fields.push('metadata = @metadata');
      values.metadata = input.metadata;
    }
    if (input.channel !== undefined) {
      fields.push('channel = @channel');
      values.channel = input.channel;
    }
    if (input.external_chat_id !== undefined) {
      fields.push('external_chat_id = @external_chat_id');
      values.external_chat_id = input.external_chat_id;
    }
    if (input.title !== undefined) {
      fields.push('title = @title');
      values.title = input.title;
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    fields.push("updated_at = cast(strftime('%s','now') as integer) * 1000");
    const sql = `UPDATE sessions SET ${fields.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(values);
    return this.findById(id);
  }

  delete(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /** Update the updated_at timestamp without changing other fields. */
  touch(id: string): void {
    this.db
      .prepare(
        "UPDATE sessions SET updated_at = cast(strftime('%s','now') as integer) * 1000 WHERE id = ?",
      )
      .run(id);
  }

  /**
   * Record the channel once, for rows created before v9 (or before the
   * gateway knew its channel). Never overwrites an existing channel and never
   * bumps `updated_at` — a metadata fix must not reorder the inbox.
   */
  setChannelIfMissing(id: string, channel: string, externalChatId?: string | null): void {
    this.db
      .prepare(
        `UPDATE sessions
            SET channel = @channel,
                external_chat_id = COALESCE(external_chat_id, @external_chat_id)
          WHERE id = @id AND channel IS NULL`,
      )
      .run({ id, channel, external_chat_id: externalChatId ?? null });
  }

  /** Write the session title column (metadata.title is kept for compatibility). */
  setTitle(id: string, title: string): void {
    this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id);
  }

  /** List sessions ordered by most recent activity. */
  listRecent(limit: number = 10): Session[] {
    const stmt = this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?');
    return stmt.all(limit) as Session[];
  }

  /**
   * A project's own chats (the 对话 list in the sidebar), newest activity first.
   *
   * Paged with the same `(updated_at, id)` cursor as the inbox and archive:
   * three lists sorted by "last activity" with three different paging schemes
   * would drift, and this one is the one nobody thinks to re-check.
   */
  listByProject(options: ListProjectSessionsOptions): Session[] {
    const where: string[] = ['s.project_id = @projectId'];
    const params: Record<string, unknown> = { projectId: options.projectId, limit: options.limit };

    if (!options.includeArchived) {
      where.push('s.archived_at IS NULL');
    }
    if (options.id !== undefined) {
      // A lookup for one known session ignores the cursor on purpose: the caller
      // asked for a row by id, not for a window of a list.
      where.push('s.id = @id');
      params.id = options.id;
    } else {
      const cursor = sessionCursorWhere(options, params);
      if (cursor) where.push(cursor);
    }

    return this.db
      .prepare(
        `SELECT s.* FROM sessions s
          WHERE ${where.join(' AND ')}
          ORDER BY s.updated_at DESC, s.id DESC
          LIMIT @limit`,
      )
      .all(params) as Session[];
  }

  /**
   * IM inbox listing: sessions without a project (project chats are listed by
   * project-scoped routes), newest activity first. `message_count` and
   * `preview` are correlated subqueries so one page costs two scans of
   * idx_messages_session instead of N+1 round trips.
   */
  listInbox(options: ListInboxOptions): InboxSessionSummary[] {
    const where: string[] = ['s.project_id IS NULL'];
    const params: Record<string, unknown> = { limit: options.limit };

    if (!options.includeArchived) {
      where.push('s.archived_at IS NULL');
    }

    if (options.channel !== undefined) {
      where.push('s.channel = @channel');
      params.channel = options.channel;
    }
    const cursor = sessionCursorWhere(options, params);
    if (cursor) where.push(cursor);

    const rows = this.db
      .prepare(
        `SELECT s.id                AS id,
                s.channel           AS channel,
                s.external_chat_id  AS external_chat_id,
                s.title             AS title,
                s.updated_at        AS updated_at,
                s.created_at        AS created_at,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
                (SELECT content FROM messages m WHERE m.session_id = s.id
                  ORDER BY created_at DESC LIMIT 1) AS preview
           FROM sessions s
          WHERE ${where.join(' AND ')}
          ORDER BY s.updated_at DESC, s.id DESC
          LIMIT @limit`,
      )
      .all(params) as Array<
      Omit<InboxSessionSummary, 'preview' | 'updated_at' | 'created_at'> & {
        preview: string | null;
        updated_at: string | number;
        created_at: string | number;
      }
    >;

    return rows.map((row) => ({
      ...row,
      // The columns are TEXT holding epoch-ms digit strings (see the cursor
      // comment above); the projection above is what the WebUI consumes, so
      // normalise to numbers here rather than shipping a string that
      // `new Date(...)` cannot parse.
      updated_at: parseEpochMs(row.updated_at),
      created_at: parseEpochMs(row.created_at),
      preview: row.preview === null ? '' : String(row.preview).slice(0, PREVIEW_MAX_CHARS),
    }));
  }

  /** Per-channel session counts for the inbox tab badges. */ countByChannel(
    options: { includeArchived?: boolean } = {},
  ): Array<{
    channel: string;
    count: number;
  }> {
    const archivedFilter = options.includeArchived ? '' : 'AND archived_at IS NULL';
    return this.db
      .prepare(
        `SELECT COALESCE(channel, 'unknown') AS channel, COUNT(*) AS count
           FROM sessions
          WHERE project_id IS NULL ${archivedFilter}
          GROUP BY COALESCE(channel, 'unknown')
          ORDER BY count DESC`,
      )
      .all() as Array<{ channel: string; count: number }>;
  }

  /**
   * Archive or unarchive a batch of conversations (project chats and IM
   * transcripts alike — the flag does not care which list a row came from).
   *
   * `updated_at` is deliberately left alone: archiving is a housekeeping fact,
   * not activity, and bumping the timestamp would reorder the very list the row
   * is leaving.
   *
   * Unarchiving takes `exemptUntil` (epoch ms, optional): the auto-archive sweep
   * skips the row until then. Without it, a hand-restored conversation would be
   * swept straight back into 归档 by the next run — it is old by definition, which
   * is why it was archived — and restoring it would achieve nothing.
   *
   * Rows already in the requested state are not counted, so the number returned
   * is "rows this call actually changed".
   */
  setArchived(ids: string[], archived: boolean, exemptUntil?: number): number {
    if (ids.length === 0) return 0;
    // The two statements bind a different number of parameters, so the binding
    // tuple is built alongside rather than assuming one shape.
    const stmt = this.db.prepare(
      archived
        ? 'UPDATE sessions SET archived_at = ? WHERE id = ? AND archived_at IS NULL'
        : exemptUntil === undefined
          ? 'UPDATE sessions SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL'
          : 'UPDATE sessions SET archived_at = NULL, archive_exempt_until = ? WHERE id = ? AND archived_at IS NOT NULL',
    );
    const archivedAt = String(Date.now());
    const exemptAt = exemptUntil === undefined ? undefined : String(exemptUntil);
    const run = this.db.transaction((list: string[]) => {
      let changed = 0;
      for (const id of list) {
        const params: unknown[] = archived
          ? [archivedAt, id]
          : exemptAt === undefined
            ? [id]
            : [exemptAt, id];
        changed += stmt.run(...(params as [string])).changes;
      }
      return changed;
    });
    return run(ids);
  }

  /**
   * Drop the archive flag for one session, if it is set.
   *
   * Called when a conversation becomes active again (a new incoming turn): an
   * archived IM chat that receives a message must reappear in the inbox rather
   * than silently swallow it. Never bumps `updated_at`.
   */
  clearArchive(id: string): boolean {
    const result = this.db
      .prepare('UPDATE sessions SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL')
      .run(id);
    return result.changes > 0;
  }

  /**
   * Archive listing: every session with `archived_at` set, carrying the owner
   * (project name or channel) the sidebar groups by.
   *
   * Ordered by `updated_at` DESC — last activity first — not by `archived_at`.
   * The archive sidebar shows that same timestamp per row ("when was this
   * conversation alive"), and a list whose visible time runs out of order inside
   * its own group reads like a sorting bug. It also makes an archived row keep
   * the position it would have had in the live list.
   *
   * Both cursor and ordering column are TEXT holding epoch-ms digit strings
   * (13 chars, so lexicographic == numeric), and the cursor is bound as text:
   * comparing the column against a bound INTEGER would mix storage classes and
   * let the cursor row through again (same trap as the inbox cursor). Ordering
   * and cursor are built together by `sessionCursorWhere`, so paging cannot
   * drift from the sort.
   */
  listArchived(options: ListArchivedOptions): ArchivedSessionRow[] {
    const where: string[] = ['s.archived_at IS NOT NULL'];
    const params: Record<string, unknown> = { limit: options.limit };

    if (options.kind === 'project') {
      where.push('s.project_id IS NOT NULL');
    } else if (options.kind === 'inbox') {
      where.push('s.project_id IS NULL');
    }
    const cursor = sessionCursorWhere(options, params);
    if (cursor) where.push(cursor);

    const rows = this.db
      .prepare(
        `SELECT s.id                AS id,
                CASE WHEN s.project_id IS NULL THEN 'inbox' ELSE 'project' END AS kind,
                s.project_id        AS project_id,
                p.name              AS project_name,
                s.channel           AS channel,
                s.external_chat_id  AS external_chat_id,
                s.title             AS title,
                s.updated_at        AS updated_at,
                s.archived_at       AS archived_at,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
                (SELECT content FROM messages m WHERE m.session_id = s.id
                  ORDER BY created_at DESC LIMIT 1) AS preview
           FROM sessions s
           LEFT JOIN projects p ON p.id = s.project_id
          WHERE ${where.join(' AND ')}
          ORDER BY s.updated_at DESC, s.id DESC
          LIMIT @limit`,
      )
      .all(params) as Array<
      Omit<ArchivedSessionRow, 'kind' | 'preview' | 'updated_at' | 'archived_at'> & {
        kind: 'project' | 'inbox';
        preview: string | null;
        updated_at: string | number;
        archived_at: string | number;
      }
    >;

    return rows.map((row) => ({
      ...row,
      updated_at: parseEpochMs(row.updated_at),
      archived_at: parseEpochMs(row.archived_at),
      preview: row.preview === null ? '' : String(row.preview).slice(0, PREVIEW_MAX_CHARS),
    }));
  }

  /**
   * Conversations the auto-archive job would flag right now.
   *
   * Same predicate as `listAutoArchiveCandidates` on purpose: the settings card
   * shows this count before the operator flips the switch, and a preview that
   * can disagree with what the job actually does is worse than no preview.
   *
   * `updated_at` is TEXT holding epoch-ms digit strings, so it is cast before
   * the comparison — a lexical `<` over mixed-length digit strings would silently
   * compare the wrong way round once a row predates the 13-digit format.
   *
   * Conversations a manual restore exempted (`archive_exempt_until`) are excluded
   * until that instant passes, otherwise the next sweep would undo the restore.
   */
  countAutoArchiveCandidates(days: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM sessions
          WHERE archived_at IS NULL
            AND CAST(updated_at AS INTEGER) < ?
            AND ${AUTO_ARCHIVE_EXEMPT_FILTER}`,
      )
      .get(autoArchiveCutoff(days), autoArchiveCutoff(days)) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /**
   * The ids that `countAutoArchiveCandidates` counts, oldest activity first so a
   * capped batch takes the least recently touched conversations.
   */
  listAutoArchiveCandidates(days: number, limit: number): string[] {
    const cutoff = autoArchiveCutoff(days);
    const rows = this.db
      .prepare(
        `SELECT id
           FROM sessions
          WHERE archived_at IS NULL
            AND CAST(updated_at AS INTEGER) < ?
            AND ${AUTO_ARCHIVE_EXEMPT_FILTER}
          ORDER BY CAST(updated_at AS INTEGER) ASC
          LIMIT ?`,
      )
      .all(cutoff, cutoff, limit) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /**
   * Record that a conversation was just restored by hand, so auto-archive leaves
   * it alone until `until` (epoch ms). Null clears the exemption.
   */
  setArchiveExemption(id: string, until: number | null): void {
    this.db
      .prepare('UPDATE sessions SET archive_exempt_until = ? WHERE id = ?')
      .run(until === null ? null : String(until), id);
  }

  /**
   * Per-owner archive counts, for the archive sidebar's group headers. One row
   * per project (kind `project`) or per channel (kind `inbox`) that still owns
   * at least one archived conversation.
   */
  countArchivedByOwner(): ArchivedOwnerCount[] {
    return this.db
      .prepare(
        `SELECT CASE WHEN s.project_id IS NULL THEN 'inbox' ELSE 'project' END AS kind,
                s.project_id AS project_id,
                p.name       AS project_name,
                CASE WHEN s.project_id IS NULL THEN COALESCE(s.channel, 'unknown') END AS channel,
                COUNT(*)     AS count
           FROM sessions s
           LEFT JOIN projects p ON p.id = s.project_id
          WHERE s.archived_at IS NOT NULL
          GROUP BY kind, s.project_id, channel
          ORDER BY count DESC, s.project_id, channel`,
      )
      .all() as ArchivedOwnerCount[];
  }
}
