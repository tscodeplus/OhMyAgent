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
import { NoteRelations } from './relations.js';
import { indexNote, searchNoteIds } from './indexer.js';
import { readableScopeSql } from './scope.js';
import {
  isNoteChannel,
  isNoteKind,
  isNoteOrigin,
  isNoteScope,
  isNoteStatus,
  isNoteStatusReason,
  isNoteSourceKind,
  isRelationBasis,
  type CaptureRunInput,
  type CreateNoteInput,
  type Note,
  type NoteEventAction,
  type NoteEventActor,
  type NoteListQuery,
  type NoteListResult,
  type NoteRow,
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
  | { ok: false; code: 'title_conflict'; existingId: string };

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

  constructor(db: Database.Database) {
    this.db = db;
    this.relations = new NoteRelations(db);
  }

  // ── row mapping ────────────────────────────────────────────────────

  private mapRow(row: NoteRow): Note {
    const channel = isNoteChannel(row.channel) ? row.channel : null;
    const fields = parseJsonArray<NoteField>(row.fields).filter(
      (field) => typeof field?.key === 'string' && typeof field?.value === 'string',
    );
    return {
      id: row.id,
      kind: isNoteKind(row.kind) ? row.kind : 'other',
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
    return this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
  }

  /**
   * Facets that are resolved rather than stored: the project's current name and
   * the origin conversation's title (plan §4.6 — a rename must show everywhere).
   */
  private decorate(note: Note): Note {
    let projectName: string | undefined;
    if (note.scope === 'project' && note.scopeKey) {
      const project = this.db
        .prepare('SELECT name FROM projects WHERE id = ?')
        .get(note.scopeKey) as { name: string } | undefined;
      projectName = project?.name;
    }

    let sessionTitle: string | null = null;
    if (note.sessionId) {
      const session = this.db
        .prepare('SELECT title, external_chat_id FROM sessions WHERE id = ?')
        .get(note.sessionId) as
        { title: string | null; external_chat_id: string | null } | undefined;
      sessionTitle = session?.title ?? session?.external_chat_id ?? null;
    }
    return { ...note, projectName, sessionTitle };
  }

  /** Sources with their availability resolved against `messages`/`sessions`. */
  private sourcesFor(noteId: string): NoteSource[] {
    const rows = this.db
      .prepare(
        `SELECT kind, source_id, excerpt, created_at FROM note_sources WHERE note_id = ?
          ORDER BY rowid`,
      )
      .all(noteId) as Array<{
      kind: string;
      source_id: string;
      excerpt: string | null;
      created_at: number;
    }>;

    // The message probe reads the session too: one query answers both "does this
    // citation still resolve" and "which conversation should show it in place".
    const messageProbe = this.db.prepare('SELECT session_id FROM messages WHERE id = ?');
    const sessionExists = this.db.prepare('SELECT 1 AS ok FROM sessions WHERE id = ?');
    const memoryExists = this.db.prepare('SELECT 1 AS ok FROM memories WHERE id = ?');

    return rows
      .filter((row): row is typeof row & { kind: string } => isNoteSourceKind(row.kind))
      .map((row) => {
        if (row.kind === 'message') {
          const hit = messageProbe.get(row.source_id) as { session_id: string } | undefined;
          return {
            kind: 'message' as const,
            id: row.source_id,
            excerpt: row.excerpt ?? '',
            at: row.created_at,
            available: !!hit,
            sessionId: hit?.session_id ?? null,
          };
        }
        const probe = row.kind === 'session' ? sessionExists : memoryExists;
        return {
          kind: row.kind as NoteSource['kind'],
          id: row.source_id,
          excerpt: row.excerpt ?? '',
          at: row.created_at,
          available: !!probe.get(row.source_id),
          sessionId: null,
        };
      });
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
  private relatedFor(noteId: string): Note['related'] {
    const rows = this.db
      .prepare(
        `SELECT r.related_id AS id, n.title AS title, n.kind AS kind, r.basis AS basis
           FROM note_relations r JOIN notes n ON n.id = r.related_id
          WHERE r.note_id = ? AND n.status = 'active'
          ORDER BY r.score DESC, r.related_id ASC LIMIT 5`,
      )
      .all(noteId) as Array<{ id: string; title: string; kind: string; basis: string }>;
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      kind: isNoteKind(row.kind) ? row.kind : 'other',
      basis: isRelationBasis(row.basis) ? row.basis : 'tags',
    }));
  }

  private hydrate(row: NoteRow): Note {
    return this.decorate({
      ...this.mapRow(row),
      sources: this.sourcesFor(row.id),
      related: this.relatedFor(row.id),
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
    return this.db
      .prepare(
        `SELECT id, status FROM notes
          WHERE normalized_title = ? AND scope = ? AND scope_key = ?
            AND status IN ('active', 'draft')
          ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC
          LIMIT 1`,
      )
      .get(normalizeTitle(title), scope, scopeKey) as
      { id: string; status: NoteStatus } | undefined;
  }

  /**
   * Browse or search.
   *
   * `q` goes through FTS and everything else through columns: a JSON scan over
   * `tags` would make the tag filter disagree with the tag row it renders.
   */
  list(query: NoteListQuery): NoteListResult {
    const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
    const offset = Math.max(0, query.offset ?? 0);
    const scope = readableScopeSql(query.context ?? null, 'n');

    const where: string[] = ['n.status = ?'];
    const params: unknown[] = [query.status];
    if (query.kind) {
      where.push('n.kind = ?');
      params.push(query.kind);
    }
    if (query.origin) {
      where.push('n.origin = ?');
      params.push(query.origin);
    }
    if (query.channel) {
      where.push('n.channel = ?');
      params.push(query.channel);
    }
    if (query.projectId) {
      where.push(`(n.scope = 'project' AND n.scope_key = ?)`);
      params.push(query.projectId);
    }
    if (query.tag) {
      // Tags are a JSON array; `json_each` is the exact-match join that keeps the
      // filter honest without splitting a string in SQL.
      where.push(
        `EXISTS (SELECT 1 FROM json_each(COALESCE(n.tags, '[]')) WHERE json_each.value = ?)`,
      );
      params.push(query.tag);
    }
    if (scope) {
      where.push(scope.sql);
      params.push(...scope.params);
    }

    let ids: string[] | null = null;
    if (query.q && query.q.trim()) {
      ids = searchNoteIds(this.db, {
        query: query.q,
        status: query.status,
        scopeSql: scope
          ? {
              // The FTS table has no `n` alias — strip the qualifier for it.
              sql: scope.sql.replace(/\bn\./g, ''),
              params: scope.params,
            }
          : null,
        limit: MAX_LIST_LIMIT,
      });
      if (ids.length === 0) {
        return {
          notes: [],
          total: 0,
          counts: this.counts(scope),
          tags: this.tagFacets(query.status, scope),
        };
      }
      where.push(`n.id IN (${ids.map(() => '?').join(', ')})`);
      params.push(...ids);
    }

    const rows = this.db
      .prepare(
        `SELECT n.* FROM notes n WHERE ${where.join(' AND ')}
          ORDER BY n.pinned DESC, n.updated_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as NoteRow[];

    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS cnt FROM notes n WHERE ${where.join(' AND ')}`)
        .get(...params) as { cnt: number }
    ).cnt;

    return {
      notes: rows.map((row) => this.hydrate(row)),
      total,
      counts: this.counts(scope),
      tags: this.tagFacets(query.status, scope),
    };
  }

  private counts(scope: ReturnType<typeof readableScopeSql>): Record<NoteStatus, number> {
    const rows = this.db
      .prepare(
        `SELECT n.status AS status, COUNT(*) AS cnt FROM notes n
          ${scope ? `WHERE ${scope.sql}` : ''}
          GROUP BY n.status`,
      )
      .all(...(scope?.params ?? [])) as Array<{ status: string; cnt: number }>;
    const counts: Record<NoteStatus, number> = { active: 0, draft: 0, archived: 0 };
    for (const row of rows) {
      if (isNoteStatus(row.status)) counts[row.status] = row.cnt;
    }
    return counts;
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
    return this.db
      .prepare(
        `SELECT json_each.value AS tag, COUNT(*) AS count
           FROM notes n, json_each(n.tags)
          WHERE ${where.join(' AND ')}
          GROUP BY json_each.value
          ORDER BY count DESC, tag ASC
          LIMIT ${MAX_TAG_FACETS}`,
      )
      .all(...params) as Array<{ tag: string; count: number }>;
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

    const existing = this.db
      .prepare(
        `SELECT id FROM notes
          WHERE normalized_title = ? AND scope = ? AND scope_key = ? AND status = 'active'`,
      )
      .get(normalizedTitle, input.scope, input.scopeKey) as { id: string } | undefined;
    if (existing && input.status === 'active') {
      return { ok: false, code: 'title_conflict', existingId: existing.id };
    }

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO notes (
             id, kind, title, normalized_title, summary, body, fields, tags, status,
             status_reason, origin, scope, scope_key, session_id, channel, pinned,
             confidence, version, capture_id, created_at, updated_at, reviewed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.kind,
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
    const statement = this.db.prepare(
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
      input.kind !== undefined ||
      input.scope !== undefined;

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
    const nextKind = isNoteKind(input.kind) ? input.kind : (row.kind as CreateNoteInput['kind']);
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
    const nextScopeKey = input.scopeKey ?? (input.scope ? '' : row.scope_key);
    const nextNormalized = normalizeTitle(nextTitle);

    const conflict = this.db
      .prepare(
        `SELECT id FROM notes
          WHERE normalized_title = ? AND scope = ? AND scope_key = ? AND status = 'active' AND id <> ?`,
      )
      .get(nextNormalized, nextScope, nextScopeKey, id) as { id: string } | undefined;
    if (conflict && row.status === 'active') {
      return { ok: false, code: 'title_conflict', existingId: conflict.id };
    }

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE notes SET
             kind = ?, title = ?, normalized_title = ?, summary = ?, body = ?, fields = ?,
             tags = ?, scope = ?, scope_key = ?, version = version + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          nextKind,
          nextTitle,
          nextNormalized,
          nextSummary,
          nextBody,
          nextFields.length > 0 ? JSON.stringify(nextFields) : null,
          serializeArray(nextTags),
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
      // Only the two signals that feed a relation: retitling or retagging can create
      // and destroy edges, while editing the body cannot. Recomputing on every save
      // would make the neighbours flicker for no change.
      if (input.title !== undefined || input.tags !== undefined || input.scope !== undefined) {
        this.relations.rebuild(id, now);
      }
    })();

    const updated = this.rawRow(id);
    if (!updated) throw new Error(`note ${id} vanished after update`);
    return { ok: true, note: this.hydrate(updated) };
  }

  private projectNameFor(scope: string, scopeKey: string): string | null {
    if (scope !== 'project' || !scopeKey) return null;
    const project = this.db.prepare('SELECT name FROM projects WHERE id = ?').get(scopeKey) as
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
      const owner = this.db
        .prepare(
          `SELECT id FROM notes
            WHERE normalized_title = ? AND scope = ? AND scope_key = ?
              AND status = 'active' AND id <> ?`,
        )
        .get(row.normalized_title, row.scope, row.scope_key, id) as { id: string } | undefined;
      if (owner) return { ok: false, code: 'title_conflict', existingId: owner.id };
    }
    const action: NoteEventAction =
      status === 'active' ? 'approve' : options.reason === 'rejected' ? 'reject' : 'archive';

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE notes SET status = ?, status_reason = ?, updated_at = ?,
             reviewed_at = CASE WHEN ? = 'active' THEN ? ELSE reviewed_at END,
             reviewed_by = CASE WHEN ? = 'active' THEN ? ELSE reviewed_by END,
             version = version + 1
           WHERE id = ?`,
        )
        .run(
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
      this.db
        .prepare('UPDATE notes SET pinned = ?, updated_at = ? WHERE id = ?')
        .run(pinned ? 1 : 0, now, id);
      this.appendEvent(id, pinned ? 'pin' : 'unpin', actor, null, now);
    })();
    const updated = this.rawRow(id);
    return updated ? this.hydrate(updated) : undefined;
  }

  /**
   * Detail-page visit.
   *
   * The one reader of `view_count` today is the WebUI's detail view (§8.3); the
   * column is not a "was it useful" signal and nothing filters on it.
   */
  recordView(id: string): void {
    const now = Date.now();
    this.db
      .prepare('UPDATE notes SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?')
      .run(now, id);
    this.appendEvent(id, 'view', 'user', null, now);
  }

  appendEvent(
    noteId: string,
    action: NoteEventAction,
    actor: NoteEventActor,
    detail: string | null,
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO note_events (id, note_id, action, actor, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `nev_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        noteId,
        action,
        actor,
        detail,
        now,
      );
  }

  /** Capture bookkeeping. `noteCount` and the final status are written once. */
  createCaptureRun(input: CaptureRunInput, now = Date.now()): string {
    const id = `cap_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.db
      .prepare(
        `INSERT INTO capture_runs (
           id, session_id, scope, mode, message_ids, token_est, model_ref, status, error,
           note_count, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );
    return id;
  }

  updateCaptureRun(
    id: string,
    patch: Partial<Pick<CaptureRunInput, 'status' | 'error' | 'noteCount' | 'modelRef'>>,
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
    if (fields.length === 0) return;
    this.db.prepare(`UPDATE capture_runs SET ${fields.join(', ')} WHERE id = ?`).run(...params, id);
  }

  countDraftsOlderThan(cutoff: number): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS cnt FROM notes WHERE status = 'draft' AND created_at < ?`)
        .get(cutoff) as { cnt: number }
    ).cnt;
  }

  /** Retention: drafts older than `ttlDays` are archived, never deleted. */
  expireDrafts(ttlDays: number, now = Date.now()): string[] {
    if (ttlDays <= 0) return [];
    const cutoff = now - ttlDays * 24 * 3600_000;
    const rows = this.db
      .prepare(`SELECT id FROM notes WHERE status = 'draft' AND created_at < ?`)
      .all(cutoff) as Array<{ id: string }>;
    for (const row of rows)
      this.setStatus(row.id, 'archived', { reason: 'expired', actor: 'system' });
    return rows.map((row) => row.id);
  }
}
