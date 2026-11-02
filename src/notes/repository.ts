/**
 * Persistence for notes: `notes` plus its companions (sources, capture runs,
 * events, relations) and the FTS index they feed.
 *
 * Boundaries this class owns, so callers never think about them:
 *
 * - **One write = one transaction.** Note row, sources, index row and the log
 *   row land together. A note visible in the list but missing from search is a
 *   bug of the "half a feature" kind.
 * - **A create never overwrites.** An active note whose `(normalized_title,
 *   scope, scope_key)` is taken returns `title_conflict` with the existing id, so
 *   the caller can offer "append to that note" instead of clobbering it.
 * - **A body edit must cite the version it read** (plan §4.2-4). Without
 *   `expectedVersion` the update is refused with the current version and body so
 *   the editor can re-merge; pin/status changes are exempt because they cannot
 *   destroy text.
 * - **Citations are soft.** `note_sources` has no foreign key to
 *   `messages`/`sessions` (§4.7); whether a cited row still exists is answered at
 *   read time, which is what lets a note outlive its conversation.
 *
 * Policy (admission, review, distillation) lives in `service.ts` and
 * `capture.ts`; this file answers "what is stored" and "did the write succeed".
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { normalizeTags, normalizeTitle } from './canonical.js';
import { ftsFacetTokens } from './facets.js';
import { NoteRelations, MAX_RELATIONS } from './relations.js';
import { indexNote, noteSearchClause } from './indexer.js';
import { readableScopeSql } from './scope.js';
import {
  isNoteChannel,
  isNoteOrigin,
  isNoteScope,
  isNoteStatus,
  isNoteStatusReason,
  isNoteSourceKind,
  isRelationBasis,
  type CaptureRunInput,
  type CreateNoteInput,
  type NoteChannel,
  type Note,
  type NoteEventAction,
  type NoteEventActor,
  type NoteListQuery,
  type NoteListResult,
  type NoteRow,
  type NoteScopeContext,
  type NoteSource,
  type NoteStatus,
  type NoteStatusReason,
  type SetStatusResult,
  type NoteField,
  type UpdateNoteInput,
} from './types.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
/** Enough excerpt to recognise the message in the review card, not a copy of it. */
const MAX_EXCERPT_CHARS = 200;
/** The tag row shows the busiest tags; the rest stay searchable. */
const MAX_TAG_FACETS = 30;

export type CreateNoteResult =
  { ok: true; note: Note } | { ok: false; code: 'title_conflict'; existingId: string };

export type UpdateNoteResult =
  | { ok: true; note: Note }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'version_mismatch'; currentVersion: number; currentBody: string }
  | { ok: false; code: 'version_required'; currentVersion: number; currentBody: string }
  | { ok: false; code: 'title_conflict'; existingId: string }
  /** A scope that needs a key (`project`/`channel`/`session`) arrived without one. */
  | { ok: false; code: 'invalid_scope' };

/** `?, ?, ?` for an `IN (...)` list — every value stays a bound parameter. */
function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

/** Distinct cited ids of one source kind, out of a page's citations. */
function citedIds(rows: Array<{ kind: string; source_id: string }>, kind: string): string[] {
  return [...new Set(rows.filter((row) => row.kind === kind).map((row) => row.source_id))];
}

function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    // A malformed JSON column is corrupt data, not an empty list — but throwing
    // here would make one bad row take down the whole list render.
    return [];
  }
}

function serializeArray(values: readonly string[] | undefined): string | null {
  if (!values || values.length === 0) return null;
  return JSON.stringify(values);
}

function clampExcerpt(text: string | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_EXCERPT_CHARS ? `${trimmed.slice(0, MAX_EXCERPT_CHARS)}…` : trimmed;
}

export class NotesRepository {
  private readonly db: Database.Database;
  /**
   * Relation writer, sharing this connection so it runs inside the same transaction
   * as the write that triggered it (`create` / `update`). It is not injectable on
   * purpose: unlike the distiller or the clock, a relation has no dependency worth
   * faking — the same rows either exist or they do not, and the tests assert on them.
   */
  private readonly relations: NoteRelations;
  /**
   * Prepared statements, keyed by SQL text.
   *
   * better-sqlite3 prepares on every `db.prepare()` and caches nothing, and this
   * class used to prepare per row: one page of 50 notes issued ~350 statements,
   * ~7 per note (project name, session title, sources, three availability probes,
   * relations). The set of distinct query shapes is bounded by the statements this
   * class writes, so one map removes the whole cost — including for statements
   * carrying an `IN (?, ?, …)` list, which is why the key is the SQL and not a
   * hand-maintained name.
   */
  private readonly statements = new Map<string, Database.Statement>();

  constructor(db: Database.Database) {
    this.db = db;
    this.relations = new NoteRelations(db);
  }

  private prepare(sql: string): Database.Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  // ── row mapping ────────────────────────────────────────────────────

  private mapRow(row: NoteRow): Note {
    const channel = isNoteChannel(row.channel) ? row.channel : null;
    const fields = parseJsonArray<NoteField>(row.fields).filter(
      (field) => typeof field?.key === 'string' && typeof field?.value === 'string',
    );
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      body: row.body,
      fields,
      tags: parseJsonArray<string>(row.tags),
      status: isNoteStatus(row.status) ? row.status : 'archived',
      statusReason: isNoteStatusReason(row.status_reason) ? row.status_reason : null,
      origin: isNoteOrigin(row.origin) ? row.origin : 'user',
      scope: isNoteScope(row.scope) ? row.scope : 'user',
      scopeKey: row.scope_key ?? '',
      sessionId: row.session_id,
      channel,
      pinned: row.pinned === 1,
      confidence: row.confidence,
      version: row.version,
      captureId: row.capture_id,
      viewCount: row.view_count,
      lastViewedAt: row.last_viewed_at,
      reviewedAt: row.reviewed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sources: [],
      related: [],
    };
  }

  private rawRow(id: string): NoteRow | undefined {
    return this.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
  }

  /**
   * Facets that are resolved rather than stored: the project's current name and
   * the origin conversation's title (plan §4.6 — a rename must show everywhere).
   *
   * Resolved for the whole page in one query each, so the cost is one statement
   * per facet regardless of how many notes the page holds.
   */
  private projectNames(notes: Note[]): Map<string, string> {
    const ids = [
      ...new Set(
        notes.filter((note) => note.scope === 'project' && note.scopeKey).map((n) => n.scopeKey),
      ),
    ];
    if (ids.length === 0) return new Map();
    const rows = this.prepare(
      `SELECT id, name FROM projects WHERE id IN (${placeholders(ids.length)})`,
    ).all(...ids) as Array<{ id: string; name: string }>;
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  private sessionTitles(notes: Note[]): Map<string, string | null> {
    const ids = [
      ...new Set(notes.map((note) => note.sessionId).filter((id): id is string => !!id)),
    ];
    if (ids.length === 0) return new Map();
    const rows = this.prepare(
      `SELECT id, title, external_chat_id FROM sessions WHERE id IN (${placeholders(ids.length)})`,
    ).all(...ids) as Array<{ id: string; title: string | null; external_chat_id: string | null }>;
    return new Map(rows.map((row) => [row.id, row.title ?? row.external_chat_id ?? null]));
  }

  /**
   * Sources with their availability resolved against `messages`/`sessions`.
   *
   * One query for the page's citations, then at most one per source kind for the
   * availability probes, grouped back by note id. The per-note version answered
   * "does this citation still resolve" with a statement of its own for every
   * citation on the page, which is where most of the old ~350 came from.
   */
  private sourcesFor(noteIds: string[]): Map<string, NoteSource[]> {
    const grouped = new Map<string, NoteSource[]>();
    if (noteIds.length === 0) return grouped;

    const rows = this.prepare(
      `SELECT note_id, kind, source_id, excerpt, created_at FROM note_sources
        WHERE note_id IN (${placeholders(noteIds.length)})
        ORDER BY note_id, rowid`,
    ).all(...noteIds) as Array<{
      note_id: string;
      kind: string;
      source_id: string;
      excerpt: string | null;
      created_at: number;
    }>;
    const citations = rows.filter((row) => isNoteSourceKind(row.kind));
    if (citations.length === 0) return grouped;

    // The message probe reads the session too: one query answers both "does this
    // citation still resolve" and "which conversation should show it in place".
    const messageIds = citedIds(citations, 'message');
    const messageSessions = new Map<string, string>();
    if (messageIds.length > 0) {
      const live = this.prepare(
        `SELECT id, session_id FROM messages WHERE id IN (${placeholders(messageIds.length)})`,
      ).all(...messageIds) as Array<{ id: string; session_id: string }>;
      for (const row of live) messageSessions.set(row.id, row.session_id);
    }

    const liveSessions = this.liveIds('sessions', citedIds(citations, 'session'));
    const liveMemories = this.liveIds('memories', citedIds(citations, 'memory'));

    for (const row of citations) {
      const available =
        row.kind === 'message'
          ? messageSessions.has(row.source_id)
          : row.kind === 'session'
            ? liveSessions.has(row.source_id)
            : liveMemories.has(row.source_id);
      const source: NoteSource = {
        kind: row.kind as NoteSource['kind'],
        id: row.source_id,
        excerpt: row.excerpt ?? '',
        at: row.created_at,
        available,
        // Only a message has a conversation to show it in place.
        sessionId: row.kind === 'message' ? (messageSessions.get(row.source_id) ?? null) : null,
      };
      const list = grouped.get(row.note_id) ?? [];
      list.push(source);
      grouped.set(row.note_id, list);
    }
    return grouped;
  }

  /** Which of these soft-citation targets still exist. `table` is a literal, never input. */
  private liveIds(table: 'sessions' | 'memories', ids: string[]): Set<string> {
    if (ids.length === 0) return new Set();
    const rows = this.prepare(
      `SELECT id FROM ${table} WHERE id IN (${placeholders(ids.length)})`,
    ).all(...ids) as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  }

  /**
   * Related notes, written by `NoteRelations` (see `relations.ts` for the rules).
   *
   * Two filters here and nowhere else: the target must be `active` (a discarded or
   * unreviewed note must not be advertised from a published one) and its *own* scope
   * is not re-checked — the writer only links within one `(scope, scope_key)`, and
   * duplicating that predicate in SQL would be a second implementation of a rule that
   * has to agree with the first.
   *
   * Rows for a note that has since been archived simply stop appearing here rather
   * than being deleted, which is what lets un-archiving restore the list for free.
   */
  private relatedFor(noteIds: string[]): Map<string, Note['related']> {
    const grouped = new Map<string, Note['related']>();
    if (noteIds.length === 0) return grouped;
    const rows = this.prepare(
      `SELECT r.note_id AS note_id, r.related_id AS id, n.title AS title, r.basis AS basis
         FROM note_relations r JOIN notes n ON n.id = r.related_id
        WHERE r.note_id IN (${placeholders(noteIds.length)}) AND n.status = 'active'
        ORDER BY r.note_id, r.score DESC, r.related_id ASC`,
    ).all(...noteIds) as Array<{ note_id: string; id: string; title: string; basis: string }>;
    for (const row of rows) {
      const list = grouped.get(row.note_id) ?? [];
      // The per-note cap, applied while grouping: the query has no `LIMIT` because
      // it now answers for a page, not for one note.
      if (list.length >= MAX_RELATIONS) continue;
      list.push({
        id: row.id,
        title: row.title,
        basis: isRelationBasis(row.basis) ? row.basis : 'tags',
      });
      grouped.set(row.note_id, list);
    }
    return grouped;
  }

  private hydrate(row: NoteRow): Note {
    return this.hydratePage([row])[0]!;
  }

  /**
   * Map, decorate and attach companions for a whole page in one pass.
   *
   * Every companion (`sources`, `related`, project names, session titles) is one
   * `IN (...)` query for the page instead of one per row. The cost of opening the
   * note list used to grow with the number of rows shown; it now grows with the
   * number of *kinds* of companion there are — four, regardless of page size.
   */
  private hydratePage(rows: NoteRow[]): Note[] {
    if (rows.length === 0) return [];
    const notes = rows.map((row) => this.mapRow(row));
    const ids = notes.map((note) => note.id);
    const sources = this.sourcesFor(ids);
    const related = this.relatedFor(ids);
    const projectNames = this.projectNames(notes);
    const sessionTitles = this.sessionTitles(notes);

    return notes.map((note) => {
      const projectName = note.scope === 'project' ? projectNames.get(note.scopeKey) : undefined;
      const sessionTitle = note.sessionId ? (sessionTitles.get(note.sessionId) ?? null) : null;
      return {
        ...note,
        projectName,
        sessionTitle,
        sources: sources.get(note.id) ?? [],
        related: related.get(note.id) ?? [],
      };
    });
  }

  // ── reads ─────────────────────────────────────────────────────────

  get(id: string): Note | undefined {
    const row = this.rawRow(id);
    return row ? this.hydrate(row) : undefined;
  }

  /**
   * The note that already owns a title in a scope, whatever its status.
   *
   * `create()` only guards `active` (the unique partial index is `WHERE
   * status='active'`), which left the capture pipeline free to build several drafts
   * with one title — and the *approval* of the second one then hit the index and
   * threw. Duplicate detection therefore has to see drafts too, so this returns
   * whichever row holds the title first, active before draft.
   */
  findByTitle(
    title: string,
    scope: Note['scope'],
    scopeKey: string,
  ): { id: string; status: NoteStatus } | undefined {
    return this.prepare(
      `SELECT id, status FROM notes
          WHERE normalized_title = ? AND scope = ? AND scope_key = ?
            AND status IN ('active', 'draft')
          ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC
          LIMIT 1`,
    ).get(normalizeTitle(title), scope, scopeKey) as { id: string; status: NoteStatus } | undefined;
  }

  /**
   * Browse or search.
   *
   * `q` goes through FTS and everything else through columns: a JSON scan over
   * `tags` would make the tag filter disagree with the tag row it renders.
   *
   * A search is ordered by relevance, not by recency (see the ranking note below);
   * a browse is ordered by pin then `updated_at`.
   */
  list(query: NoteListQuery): NoteListResult {
    const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
    const offset = Math.max(0, query.offset ?? 0);
    const scope = readableScopeSql(query.context ?? null, 'n');

    const where: string[] = ['n.status = ?'];
    const params: unknown[] = [query.status];
    if (query.origins?.length) {
      where.push(`n.origin IN (${placeholders(query.origins.length)})`);
      params.push(...query.origins);
    }
    if (query.channels?.length) {
      where.push(`n.channel IN (${placeholders(query.channels.length)})`);
      params.push(...query.channels);
    }
    if (query.projectIds?.length) {
      where.push(
        `(n.scope = 'project' AND n.scope_key IN (${placeholders(query.projectIds.length)}))`,
      );
      params.push(...query.projectIds);
    }
    if (query.tags?.length) {
      // Tags are a JSON array; `json_each` is the exact-match join that keeps the
      // filter honest without splitting a string in SQL. `IN` rather than one
      // `EXISTS` per tag: selecting two tags asks for either, not for both — a
      // note carries at most six tags, so "both" would answer empty almost always.
      where.push(
        `EXISTS (SELECT 1 FROM json_each(COALESCE(n.tags, '[]'))
            WHERE json_each.value IN (${placeholders(query.tags.length)}))`,
      );
      params.push(...query.tags);
    }
    if (scope) {
      where.push(scope.sql);
      params.push(...scope.params);
    }

    const searchText = query.q?.trim();
    const search = searchText ? noteSearchClause(searchText) : null;
    if (searchText && !search) {
      // The words held no indexable term (`!!!`). That is a search that matches
      // nothing, not a browse — returning the whole library here would look like
      // the filter was ignored.
      return {
        notes: [],
        total: 0,
        counts: this.counts(query.context ?? null),
        ...this.facets(query.status, scope),
      };
    }
    if (search) {
      where.push('notes_fts_jieba MATCH ?');
      params.push(search.match);
    }

    // Search and browse share one statement, and the difference is exactly where
    // the ranking lives: relevance first (`bm25()`, ascending) with `pinned` as the
    // tie-break, versus the browse order of pin then recency. `LIMIT`, `OFFSET` and
    // the `COUNT` below therefore apply to the *ranked* set — the shape this
    // replaced fetched at most 200 ids, re-sorted them by `updated_at` (throwing the
    // ranking away) and counted the same capped list, so `total` stopped at 200 and
    // rows past it were unreachable.
    const join = search ? 'JOIN notes_fts_jieba ON notes_fts_jieba.note_id = n.id' : '';
    const order = search
      ? `${search.rank} ASC, n.pinned DESC, n.updated_at DESC, n.id ASC`
      : 'n.pinned DESC, n.updated_at DESC, n.id ASC';

    const rows = this.prepare(
      `SELECT n.* FROM notes n ${join} WHERE ${where.join(' AND ')}
        ORDER BY ${order}
        LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as NoteRow[];

    const total = (
      this.prepare(`SELECT COUNT(*) AS cnt FROM notes n ${join} WHERE ${where.join(' AND ')}`).get(
        ...params,
      ) as { cnt: number }
    ).cnt;

    return {
      notes: this.hydratePage(rows),
      total,
      counts: this.counts(query.context ?? null),
      ...this.facets(query.status, scope),
    };
  }

  /**
   * Status tallies for everything the caller can read.
   *
   * Public because `stats()` needs only the numbers: it used to call
   * `list({ limit: 1 })` and throw the note away, which meant opening the note list
   * (facets, sources, relations, probes) to answer "how many drafts are there".
   */
  counts(context: NoteScopeContext | null = null): Record<NoteStatus, number> {
    const scope = readableScopeSql(context, 'n');
    const rows = this.prepare(
      `SELECT n.status AS status, COUNT(*) AS cnt FROM notes n
          ${scope ? `WHERE ${scope.sql}` : ''}
          GROUP BY n.status`,
    ).all(...(scope?.params ?? [])) as Array<{ status: string; cnt: number }>;
    const counts: Record<NoteStatus, number> = { active: 0, draft: 0, archived: 0 };
    for (const row of rows) {
      if (isNoteStatus(row.status)) counts[row.status] = row.cnt;
    }
    return counts;
  }

  /**
   * The filter row's options: the library under `status`, **not** the filtered page.
   *
   * Facets are computed from status and scope alone so that narrowing one facet does
   * not empty the others. Deriving them from the loaded rows (the first version did)
   * meant that filtering to 飞书 left 来源 = [飞书]: the control that was supposed to
   * widen the view had nothing left to widen it with.
   */
  private facets(
    status: NoteStatus,
    scope: ReturnType<typeof readableScopeSql>,
  ): Pick<NoteListResult, 'tags' | 'channels' | 'projects'> {
    return {
      tags: this.tagFacets(status, scope),
      channels: this.channelFacets(status, scope),
      projects: this.projectFacets(status, scope),
    };
  }

  private channelFacets(
    status: NoteStatus,
    scope: ReturnType<typeof readableScopeSql>,
  ): Array<{ channel: NoteChannel; count: number }> {
    const where = ['n.status = ?', 'n.channel IS NOT NULL'];
    const params: unknown[] = [status];
    if (scope) {
      where.push(scope.sql);
      params.push(...scope.params);
    }
    return this.prepare(
      `SELECT n.channel AS channel, COUNT(*) AS count FROM notes n
          WHERE ${where.join(' AND ')}
          GROUP BY n.channel
          ORDER BY count DESC, channel ASC`,
    ).all(...params) as Array<{ channel: NoteChannel; count: number }>;
  }

  /** Projects that actually hold notes, so the filter cannot offer an empty shelf. */
  private projectFacets(
    status: NoteStatus,
    scope: ReturnType<typeof readableScopeSql>,
  ): Array<{ id: string; name: string; count: number }> {
    const where = ['n.status = ?', "n.scope = 'project'", 'n.scope_key IS NOT NULL'];
    const params: unknown[] = [status];
    if (scope) {
      where.push(scope.sql);
      params.push(...scope.params);
    }
    return this.prepare(
      `SELECT n.scope_key AS id, p.name AS name, COUNT(*) AS count
           FROM notes n JOIN projects p ON p.id = n.scope_key
          WHERE ${where.join(' AND ')}
          GROUP BY n.scope_key, p.name
          ORDER BY count DESC, name ASC`,
    ).all(...params) as Array<{ id: string; name: string; count: number }>;
  }

  /** Tag counts for the filter row, from the rows the caller can actually see. */
  private tagFacets(
    status: NoteStatus,
    scope: ReturnType<typeof readableScopeSql>,
  ): Array<{ tag: string; count: number }> {
    const where = ['n.status = ?', 'n.tags IS NOT NULL'];
    const params: unknown[] = [status];
    if (scope) {
      where.push(scope.sql);
      params.push(...scope.params);
    }
    return this.prepare(
      `SELECT json_each.value AS tag, COUNT(*) AS count
           FROM notes n, json_each(n.tags)
          WHERE ${where.join(' AND ')}
          GROUP BY json_each.value
          ORDER BY count DESC, tag ASC
          LIMIT ${MAX_TAG_FACETS}`,
    ).all(...params) as Array<{ tag: string; count: number }>;
  }

  // ── writes ────────────────────────────────────────────────────────

  /**
   * Insert a note with its evidence, index row and log row.
   *
   * The unique partial index on `(normalized_title, scope, scope_key)` for
   * `status='active'` is what makes a duplicate subject impossible; catching it
   * here turns a constraint error into an actionable answer ("that subject
   * exists, id …").
   */
  create(input: CreateNoteInput): CreateNoteResult {
    const now = input.now ?? Date.now();
    const id = `nt_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const normalizedTitle = normalizeTitle(input.title);
    const tags = normalizeTags(input.tags);
    const fields = (input.fields ?? []).filter(
      (field) => typeof field.key === 'string' && typeof field.value === 'string',
    );
    const sources = (input.sources ?? []).filter((source) => isNoteSourceKind(source.kind));

    const existing = this.prepare(
      `SELECT id FROM notes
          WHERE normalized_title = ? AND scope = ? AND scope_key = ? AND status = 'active'`,
    ).get(normalizedTitle, input.scope, input.scopeKey) as { id: string } | undefined;
    if (existing && input.status === 'active') {
      return { ok: false, code: 'title_conflict', existingId: existing.id };
    }

    this.db.transaction(() => {
      this.prepare(
        `INSERT INTO notes (
             id, title, normalized_title, summary, body, fields, tags, status,
             status_reason, origin, scope, scope_key, session_id, channel, pinned,
             confidence, version, capture_id, created_at, updated_at, reviewed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?, ?)`,
      ).run(
        id,
        input.title,
        normalizedTitle,
        input.summary,
        input.body,
        fields.length > 0 ? JSON.stringify(fields) : null,
        serializeArray(tags),
        input.status,
        input.statusReason ?? null,
        input.origin,
        input.scope,
        input.scopeKey,
        input.sessionId ?? null,
        input.channel ?? null,
        input.confidence ?? null,
        input.captureId ?? null,
        now,
        now,
        // An active note created by a human is reviewed by definition (§4.2-2).
        input.status === 'active' ? now : null,
      );

      this.writeSources(id, sources, now);
      indexNote(this.db, {
        id,
        status: input.status,
        scope: input.scope,
        scopeKey: input.scopeKey,
        title: input.title,
        summary: input.summary,
        body: input.body,
        indexTags: [
          ...tags,
          ...ftsFacetTokens({
            origin: input.origin,
            channel: input.channel ?? null,
            projectName: this.projectNameFor(input.scope, input.scopeKey),
          }),
        ],
      });
      this.appendEvent(
        id,
        input.status === 'active' ? 'create' : 'draft',
        input.actor ?? 'agent',
        null,
        now,
      );
      // Inside the transaction: a note whose relations were half-written would render
      // a one-sided pair, and this is a row of pure derivation — rolling it back with
      // the insert costs nothing.
      this.relations.rebuild(id, now);
    })();

    const created = this.rawRow(id);
    if (!created) throw new Error(`note ${id} vanished after insert`);
    return { ok: true, note: this.hydrate(created) };
  }

  private writeSources(noteId: string, sources: CreateNoteInput['sources'], now: number): void {
    if (!sources || sources.length === 0) return;
    const statement = this.prepare(
      `INSERT OR REPLACE INTO note_sources (note_id, kind, source_id, excerpt, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const source of sources.slice(0, 8)) {
      statement.run(noteId, source.kind, source.id, clampExcerpt(source.excerpt), now);
    }
  }

  /**
   * Apply a patch.
   *
   * `expectedVersion` is the optimistic-concurrency token. A patch that changes
   * the body (or title, summary, fields, tags, scope — anything the editor shows)
   * without it is refused; only pin/status go through {@link setPinned} /
   * {@link setStatus}, which do not take this path.
   */
  update(id: string, input: UpdateNoteInput): UpdateNoteResult {
    const row = this.rawRow(id);
    if (!row) return { ok: false, code: 'not_found' };

    const touchesContent =
      input.title !== undefined ||
      input.summary !== undefined ||
      input.body !== undefined ||
      input.fields !== undefined ||
      input.tags !== undefined ||
      input.scope !== undefined ||
      // A key-only move is still an unmergeable write: it changes which library the
      // note belongs to, so it needs the version of the text the editor was looking
      // at, exactly like a scope move does.
      input.scopeKey !== undefined;

    if (touchesContent && input.expectedVersion === undefined) {
      return {
        ok: false,
        code: 'version_required',
        currentVersion: row.version,
        currentBody: row.body,
      };
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
      return {
        ok: false,
        code: 'version_mismatch',
        currentVersion: row.version,
        currentBody: row.body,
      };
    }

    const now = input.now ?? Date.now();
    const nextTitle = input.title ?? row.title;
    const nextSummary = input.summary ?? row.summary;
    const nextBody = input.body ?? row.body;
    const nextTags = input.tags ? normalizeTags(input.tags) : parseJsonArray<string>(row.tags);
    const nextFields =
      input.fields !== undefined
        ? input.fields.filter(
            (field) => typeof field.key === 'string' && typeof field.value === 'string',
          )
        : parseJsonArray<NoteField>(row.fields);
    const nextScope = isNoteScope(input.scope)
      ? input.scope
      : (row.scope as CreateNoteInput['scope']);
    /**
     * Where the note lands, and the key it lands under.
     *
     * `input.scope` on its own used to mean `scope_key = ''`: the editor's scope
     * Select sends no key, so every "move to project" wrote a note that no project
     * facet and no scope read rule could see — saved, reported as saved, invisible.
     * A *move* into a scope that needs a key therefore requires the key, while an
     * unchanged scope keeps the key it already has (re-sending the same scope is a
     * no-op, not a reset). Only a move is refused: a row already keyless from the old
     * path still has to be editable, or the bug would freeze the note as well as hide
     * it. `user` is the one scope with no key at all.
     */
    const scopeMoved = input.scope !== undefined && input.scope !== row.scope;
    const nextScopeKey =
      nextScope === 'user' ? '' : (input.scopeKey ?? (scopeMoved ? '' : row.scope_key));
    if (scopeMoved && nextScope !== 'user' && !nextScopeKey) {
      return { ok: false, code: 'invalid_scope' };
    }
    const nextNormalized = normalizeTitle(nextTitle);
    const nextTagsSerialized = serializeArray(nextTags);
    const nextScopeChanged = nextScope !== row.scope || nextScopeKey !== row.scope_key;

    const conflict = this.prepare(
      `SELECT id FROM notes
          WHERE normalized_title = ? AND scope = ? AND scope_key = ? AND status = 'active' AND id <> ?`,
    ).get(nextNormalized, nextScope, nextScopeKey, id) as { id: string } | undefined;
    if (conflict && row.status === 'active') {
      return { ok: false, code: 'title_conflict', existingId: conflict.id };
    }

    this.db.transaction(() => {
      this.prepare(
        `UPDATE notes SET
             title = ?, normalized_title = ?, summary = ?, body = ?, fields = ?,
             tags = ?, scope = ?, scope_key = ?, version = version + 1, updated_at = ?
           WHERE id = ?`,
      ).run(
        nextTitle,
        nextNormalized,
        nextSummary,
        nextBody,
        nextFields.length > 0 ? JSON.stringify(nextFields) : null,
        nextTagsSerialized,
        nextScope,
        nextScopeKey,
        now,
        id,
      );
      indexNote(this.db, {
        id,
        status: row.status as NoteStatus,
        scope: nextScope,
        scopeKey: nextScopeKey,
        title: nextTitle,
        summary: nextSummary,
        body: nextBody,
        indexTags: [
          ...nextTags,
          ...ftsFacetTokens({
            origin: isNoteOrigin(row.origin) ? row.origin : 'user',
            channel: isNoteChannel(row.channel) ? row.channel : null,
            projectName: this.projectNameFor(nextScope, nextScopeKey),
          }),
        ],
      });
      this.appendEvent(id, 'edit', input.actor ?? 'user', null, now);
      // Rebuild only when a relation *input* changed value — not when its key merely
      // appeared in the patch. The WebUI editor sends title, tags and scope on every
      // save, so "key present" made this gate permanently true and rewrote the whole
      // scope's relations (and their tag-frequency exclusion set) for a typo fix,
      // which is exactly the neighbour flicker the gate was meant to prevent.
      // Tags are compared through the serialiser the write uses: `[]` and `null` say
      // the same thing, and `JSON.stringify` on the parsed value would call them
      // different, rebuilding on every save that clears a field.
      const titleChanged = input.title !== undefined && nextNormalized !== row.normalized_title;
      const tagsChanged = input.tags !== undefined && nextTagsSerialized !== row.tags;
      if (titleChanged || tagsChanged || nextScopeChanged) {
        // A scope move clears the note's own rows first (neither scope's rebuild
        // lists cross-scope rows) and recomputes the scope it *left* as well —
        // its tag ratios shifted too, and `rebuild(id)` only sees the new one.
        if (nextScopeChanged) this.relations.dropFor(id);
        this.relations.rebuild(id, now);
        if (nextScopeChanged) this.relations.rebuildScope(row.scope, row.scope_key, now);
      }
    })();

    const updated = this.rawRow(id);
    if (!updated) throw new Error(`note ${id} vanished after update`);
    return { ok: true, note: this.hydrate(updated) };
  }

  private projectNameFor(scope: string, scopeKey: string): string | null {
    if (scope !== 'project' || !scopeKey) return null;
    const project = this.prepare('SELECT name FROM projects WHERE id = ?').get(scopeKey) as
      { name: string } | undefined;
    return project?.name ?? null;
  }

  /** Draft → active, draft → archived(rejected), active → archived(restored). */
  setStatus(
    id: string,
    status: NoteStatus,
    options: {
      reason?: NoteStatusReason | null;
      /** Extra context for the log row (e.g. a rejection code); never rendered. */
      detail?: string | null;
      actor?: NoteEventActor;
      reviewedBy?: string | null;
      now?: number;
    } = {},
  ): SetStatusResult | undefined {
    const row = this.rawRow(id);
    if (!row) return undefined;
    const now = options.now ?? Date.now();

    // Promotion is where titles actually collide: the unique partial index only
    // covers `active` rows, so two drafts may share a title until one of them is
    // approved. Letting the index throw would surface as a 500 and leave the second
    // draft unapprovable forever; the caller gets the owner instead.
    if (status === 'active' && row.status !== 'active') {
      const owner = this.prepare(
        `SELECT id FROM notes
            WHERE normalized_title = ? AND scope = ? AND scope_key = ?
              AND status = 'active' AND id <> ?`,
      ).get(row.normalized_title, row.scope, row.scope_key, id) as { id: string } | undefined;
      if (owner) return { ok: false, code: 'title_conflict', existingId: owner.id };
    }
    const action: NoteEventAction =
      status === 'active' ? 'approve' : options.reason === 'rejected' ? 'reject' : 'archive';

    this.db.transaction(() => {
      this.prepare(
        `UPDATE notes SET status = ?, status_reason = ?, updated_at = ?,
             reviewed_at = CASE WHEN ? = 'active' THEN ? ELSE reviewed_at END,
             reviewed_by = CASE WHEN ? = 'active' THEN ? ELSE reviewed_by END,
             version = version + 1
           WHERE id = ?`,
      ).run(
        status,
        options.reason ?? null,
        now,
        status,
        now,
        status,
        options.reviewedBy ?? 'user',
        id,
      );
      // The FTS row carries `status`, so a promoted note must be re-indexed or it
      // stays invisible to every `status='active'` search.
      const updated = this.rawRow(id);
      if (updated) {
        const tags = parseJsonArray<string>(updated.tags);
        indexNote(this.db, {
          id,
          status,
          scope: updated.scope,
          scopeKey: updated.scope_key,
          title: updated.title,
          summary: updated.summary,
          body: updated.body,
          indexTags: [
            ...tags,
            ...ftsFacetTokens({
              origin: isNoteOrigin(updated.origin) ? updated.origin : 'user',
              channel: isNoteChannel(updated.channel) ? updated.channel : null,
              projectName: this.projectNameFor(updated.scope, updated.scope_key),
            }),
          ],
        });
      }
      this.appendEvent(
        id,
        action,
        options.actor ?? 'user',
        options.detail ?? options.reason ?? null,
        now,
      );
    })();

    const updated = this.rawRow(id);
    return updated ? { ok: true, note: this.hydrate(updated) } : undefined;
  }

  setPinned(id: string, pinned: boolean, actor: NoteEventActor = 'user'): Note | undefined {
    const row = this.rawRow(id);
    if (!row) return undefined;
    const now = Date.now();
    this.db.transaction(() => {
      this.prepare('UPDATE notes SET pinned = ?, updated_at = ? WHERE id = ?').run(
        pinned ? 1 : 0,
        now,
        id,
      );
      this.appendEvent(id, pinned ? 'pin' : 'unpin', actor, null, now);
    })();
    const updated = this.rawRow(id);
    return updated ? this.hydrate(updated) : undefined;
  }

  /**
   * Detail-page visit.
   *
   * Counted for notes that are notes: a draft has never been *read*, it is being
   * reviewed, and counting review glances made "viewed N times" mean two different
   * things on the same page. The log row follows the counter, so the audit trail
   * never claims a view the counter refused.
   */
  recordView(id: string): void {
    const now = Date.now();
    const changed = this.prepare(
      `UPDATE notes SET view_count = view_count + 1, last_viewed_at = ?
        WHERE id = ? AND status <> 'draft'`,
    ).run(now, id).changes;
    if (changed > 0) this.appendEvent(id, 'view', 'user', null, now);
  }

  appendEvent(
    noteId: string,
    action: NoteEventAction,
    actor: NoteEventActor,
    detail: string | null,
    now = Date.now(),
  ): void {
    this.prepare(
      `INSERT INTO note_events (id, note_id, action, actor, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(`nev_${randomUUID().replace(/-/g, '').slice(0, 16)}`, noteId, action, actor, detail, now);
  }

  /** Capture bookkeeping. `noteCount` and the final status are written once. */
  createCaptureRun(input: CaptureRunInput, now = Date.now()): string {
    const id = `cap_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.prepare(
      `INSERT INTO capture_runs (
           id, session_id, scope, mode, message_ids, token_est, model_ref, status, error,
           note_count, created_at, dropped_messages
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.sessionId,
      input.scope,
      input.mode,
      JSON.stringify(input.messageIds),
      input.tokenEst,
      input.modelRef ?? null,
      input.status,
      input.error ?? null,
      input.noteCount ?? 0,
      now,
      input.droppedMessages ?? 0,
    );
    return id;
  }

  updateCaptureRun(
    id: string,
    patch: Partial<
      Pick<CaptureRunInput, 'status' | 'error' | 'noteCount' | 'modelRef' | 'droppedMessages'>
    >,
  ): void {
    const fields: string[] = [];
    const params: unknown[] = [];
    if (patch.status !== undefined) {
      fields.push('status = ?');
      params.push(patch.status);
    }
    if (patch.error !== undefined) {
      fields.push('error = ?');
      params.push(patch.error);
    }
    if (patch.noteCount !== undefined) {
      fields.push('note_count = ?');
      params.push(patch.noteCount);
    }
    if (patch.modelRef !== undefined) {
      fields.push('model_ref = ?');
      params.push(patch.modelRef);
    }
    if (patch.droppedMessages !== undefined) {
      fields.push('dropped_messages = ?');
      params.push(patch.droppedMessages);
    }
    if (fields.length === 0) return;
    this.prepare(`UPDATE capture_runs SET ${fields.join(', ')} WHERE id = ?`).run(...params, id);
  }

  countDraftsOlderThan(cutoff: number): number {
    return (
      this.prepare(
        `SELECT COUNT(*) AS cnt FROM notes WHERE status = 'draft' AND created_at < ?`,
      ).get(cutoff) as { cnt: number }
    ).cnt;
  }

  /** Retention: drafts older than `ttlDays` are archived, never deleted. */
  expireDrafts(ttlDays: number, now = Date.now()): string[] {
    if (ttlDays <= 0) return [];
    const cutoff = now - ttlDays * 24 * 3600_000;
    const rows = this.prepare(`SELECT id FROM notes WHERE status = 'draft' AND created_at < ?`).all(
      cutoff,
    ) as Array<{ id: string }>;
    for (const row of rows)
      this.setStatus(row.id, 'archived', { reason: 'expired', actor: 'system' });
    return rows.map((row) => row.id);
  }
}
