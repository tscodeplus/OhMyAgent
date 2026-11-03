/**
 * Notes API — the WebUI's backend for the notes layer
 * (MyDocs/NOTES_LAYER_PLAN.md §10.2).
 *
 * Everything delegates to `NotesService`; this module is the HTTP boundary and
 * nothing else. It validates untrusted input, translates the service's rejection
 * codes into distinguishable status codes, and renders the service's notes as
 * camelCase JSON (they already are — the service speaks the same shape the WebUI
 * renders, which is what keeps "REST contract" and "UI contract" one thing).
 *
 * Status codes, chosen so the editor can react without string matching:
 *
 *   400 — caller error: unknown status/scope, un-parsable body, an empty
 *         title on a manual note, a `capture` without a session or with a mode
 *         that cannot produce a window.
 *   404 — the note does not exist. `GET /api/notes/:id` is the only read that
 *         can answer it: `list` returns an empty array.
 *   409 — optimistic-concurrency conflict: `expectedVersion` was missing or
 *         stale. The body carries `currentVersion` and `currentBody` so the
 *         editor can show a diff instead of throwing the user's text away. On
 *         `/purge` it means `not_archived`: a physical erase is only reachable
 *         from `archived`, so the caller archives first.
 *   422 — the layer decided not to write: capture produced nothing usable
 *         (`no_notes`, `invalid`, `empty_window`), the title already exists, or a
 *         purge's retyped title does not match the note's comparison key.
 *   503 — the model chain failed (`model_failed`); a retry may work.
 *
 * `scope` is a filter here, never a permission:
 * reads without a scope context show the whole library, because a human at the
 * console is looking at their own notes.
 */

import type { FastifyInstance } from 'fastify';
import {
  NOTE_CHANNELS,
  NOTE_SCOPES,
  NOTE_REJECTION_CODES,
  NOTE_STATUSES,
  isCaptureMode,
  isNoteChannel,
  isNoteOrigin,
  isNoteScope,
  isNoteRejectionCode,
  isNoteStatus,
  type NoteChannel,
  type NoteOrigin,
  type NoteRejectionCode,
  type NoteField,
  type NoteListQuery,
  type NoteScopeContext,
} from '../../notes/types.js';
import type { CaptureRequest, NotesService } from '../../notes/service-contract.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const MAX_TITLE_CHARS = 60;
const MAX_SUMMARY_CHARS = 120;
const MAX_TAGS = 6;
/** Dropped text is a selection, not an essay; a longer paste is cut, not refused. */
const MAX_TEXT_CHARS = 4000;
/** An instruction is a sentence about what to keep; anything longer is a note. */
const MAX_INSTRUCTION_CHARS = 500;

/** A field value longer than this is a body, pasted into the wrong input. */
const MAX_FIELD_VALUE_CHARS = 400;

export interface NotesRouteOptions {
  service: NotesService;
}

function parseLimit(raw: unknown): number {
  const parsed = typeof raw === 'string' ? parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(1, parsed), MAX_LIST_LIMIT);
}

function parseOffset(raw: unknown): number {
  const parsed = typeof raw === 'string' ? parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * A facet filter as a list.
 *
 * Accepts both `?tag=a&tag=b` (repeated) and `?tag=a,b` (comma), because a URL a
 * human types and a URL `URLSearchParams` builds should not need to agree. Values
 * are de-duplicated and capped: the filter row offers a handful of choices, so a
 * thousand is not a filter, it is an attack on the SQL planner.
 */
function parseCsv(raw: unknown, max = 20): string[] {
  const parts = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    for (const item of part.split(',')) {
      const value = item.trim();
      if (value && !out.includes(value)) out.push(value);
    }
  }
  return out.slice(0, max);
}

/** Fields arrive as `[{ key, value, mono? }]`; anything else is dropped, not coerced. */
function parseFields(raw: unknown): NoteField[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is { key: string; value: string; mono?: boolean } =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as { key?: unknown }).key === 'string' &&
        typeof (item as { value?: unknown }).value === 'string',
    )
    .slice(0, 6)
    .map((item) => ({
      key: item.key.slice(0, 32),
      value: item.value.slice(0, MAX_FIELD_VALUE_CHARS),
      mono: item.mono === true,
    }));
}

function parseTags(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string').slice(0, MAX_TAGS);
}

/**
 * The scope context the read rule needs (plan §4.2-5).
 *
 * Built from what the WebUI already knows: `projectId` from the sidebar,
 * `sessionId` for an open conversation, `channelKey` for an IM transcript. Absent
 * all three, the caller sees everything.
 */
function parseScopeContext(query: Record<string, unknown>): NoteScopeContext | null {
  const projectId = asString(query.projectId) ?? null;
  const channelKey = asString(query.channelKey) ?? null;
  const sessionId = asString(query.sessionId) ?? null;
  if (!projectId && !channelKey && !sessionId) return null;
  return { projectId, channelKey, sessionId };
}

export function registerNotesRoutes(app: FastifyInstance, options: NotesRouteOptions): void {
  const { service } = options;

  // ── list ──────────────────────────────────────────────────────────

  app.get('/api/notes', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const statusRaw = asString(query.status) ?? 'active';
    if (!isNoteStatus(statusRaw)) {
      return reply.status(400).send({ error: 'invalid status', allowed: NOTE_STATUSES });
    }
    const originRaw = parseCsv(query.origin);
    const badOrigin = originRaw.find((value) => !isNoteOrigin(value));
    if (badOrigin !== undefined) {
      return reply
        .status(400)
        .send({ error: 'invalid origin', value: badOrigin, allowed: ['user', 'agent'] });
    }
    const channelRaw = parseCsv(query.channel);
    const badChannel = channelRaw.find((value) => !isNoteChannel(value));
    if (badChannel !== undefined) {
      return reply
        .status(400)
        .send({ error: 'invalid channel', value: badChannel, allowed: NOTE_CHANNELS });
    }

    const listQuery: NoteListQuery = {
      status: statusRaw,
      origins: originRaw.length ? (originRaw as NoteOrigin[]) : undefined,
      channels: channelRaw.length ? (channelRaw as NoteChannel[]) : undefined,
      projectIds: parseCsv(query.projectId),
      tags: parseCsv(query.tag),
      q: asString(query.q),
      context: parseScopeContext(query),
      limit: parseLimit(query.limit),
      offset: parseOffset(query.offset),
    };

    return reply.send(service.list(listQuery));
  });

  app.get('/api/notes/stats', async (_request, reply) => reply.send(service.stats()));

  // ── single note ───────────────────────────────────────────────────

  app.get('/api/notes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const note = service.get(id);
    if (!note) return reply.status(404).send({ error: 'not found' });
    return reply.send({ note });
  });

  /**
   * Detail-page visit, kept separate from `GET` so that reads stay side-effect
   * free: a WebUI prefetch, a link check or a test must not inflate `view_count`.
   */
  app.post('/api/notes/:id/view', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!service.get(id)) return reply.status(404).send({ error: 'not found' });
    service.recordView(id);
    return reply.send({ ok: true });
  });

  // ── capture ───────────────────────────────────────────────────────

  app.post('/api/notes/capture', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const sessionId = asString(body.sessionId);
    if (!sessionId) return reply.status(400).send({ error: 'sessionId is required' });

    const modeRaw = asString(body.mode) ?? 'turn';
    if (!isCaptureMode(modeRaw)) {
      return reply
        .status(400)
        .send({ error: 'invalid mode', allowed: ['turn', 'recent', 'selection', 'text'] });
    }
    const scopeRaw = asString(body.scope);
    if (scopeRaw && !isNoteScope(scopeRaw)) {
      return reply.status(400).send({ error: 'invalid scope', allowed: NOTE_SCOPES });
    }
    const text = asString(body.text);
    if (modeRaw === 'text' && (!text || !text.trim())) {
      return reply.status(400).send({ error: 'text is required for mode=text' });
    }
    if (text && text.length > MAX_TEXT_CHARS) {
      return reply.status(400).send({ error: `text exceeds ${MAX_TEXT_CHARS} characters` });
    }
    const messageIds = Array.isArray(body.messageIds)
      ? body.messageIds.filter((item): item is string => typeof item === 'string').slice(0, 50)
      : undefined;
    if (modeRaw === 'selection' && (!messageIds || messageIds.length === 0)) {
      return reply.status(400).send({ error: 'messageIds is required for mode=selection' });
    }
    const treatmentRaw = asString(body.treatment);
    if (treatmentRaw && treatmentRaw !== 'distill' && treatmentRaw !== 'verbatim') {
      return reply
        .status(400)
        .send({ error: 'invalid treatment', allowed: ['distill', 'verbatim'] });
    }
    if (treatmentRaw === 'verbatim' && modeRaw !== 'text') {
      // Verbatim is only meaningful for content the caller handed over: over a
      // stored window it would copy the transcript, which is what `capture` exists
      // not to do.
      return reply.status(400).send({ error: 'treatment=verbatim requires mode=text' });
    }
    const instructionRaw = asString(body.instruction)?.trim();
    if (instructionRaw && instructionRaw.length > MAX_INSTRUCTION_CHARS) {
      return reply
        .status(400)
        .send({ error: `instruction exceeds ${MAX_INSTRUCTION_CHARS} characters` });
    }

    const captureRequest: CaptureRequest = {
      sessionId,
      mode: modeRaw,
      treatment: treatmentRaw === 'verbatim' ? 'verbatim' : treatmentRaw ? 'distill' : undefined,
      instruction: instructionRaw || undefined,
      messageIds,
      text: text?.slice(0, MAX_TEXT_CHARS),
      scope: scopeRaw ? (scopeRaw as CaptureRequest['scope']) : undefined,
      scopeKey: asString(body.scopeKey),
      turns: typeof body.turns === 'number' ? body.turns : undefined,
      chatType: asString(body.chatType),
      actor: body.actor === 'user' ? 'user' : 'agent',
    };

    const result = await service.capture(captureRequest);
    if (result.ok) return reply.send(result);

    // Failure codes map to "the client should fix it" vs "it will not work now".
    switch (result.code) {
      case 'no_session':
        return reply.status(404).send(result);
      case 'empty_window':
        return reply.status(400).send(result);
      case 'no_notes':
      case 'invalid':
      // A duplicate is "this already exists", which the card turns into a link to
      // the row that owns the title rather than into an error.
      case 'duplicate':
        return reply.status(422).send(result);
      case 'model_failed':
        return reply.status(503).send(result);
      default:
        return reply.status(400).send(result);
    }
  });

  // ── manual create ─────────────────────────────────────────────────

  app.post('/api/notes', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const title = asString(body.title)?.trim() ?? '';
    if (!title) return reply.status(400).send({ error: 'title is required' });
    if (title.length > MAX_TITLE_CHARS) {
      return reply.status(400).send({ error: `title exceeds ${MAX_TITLE_CHARS} characters` });
    }
    const scopeRaw = asString(body.scope);
    if (scopeRaw && !isNoteScope(scopeRaw)) {
      return reply.status(400).send({ error: 'invalid scope', allowed: NOTE_SCOPES });
    }
    const channelRaw = asString(body.channel);
    if (channelRaw && !isNoteChannel(channelRaw)) {
      return reply.status(400).send({ error: 'invalid channel', allowed: NOTE_CHANNELS });
    }

    const result = service.createManual({
      title,
      summary: (asString(body.summary) ?? '').slice(0, MAX_SUMMARY_CHARS),
      body: asString(body.body) ?? '',
      fields: parseFields(body.fields),
      tags: parseTags(body.tags),
      scope: scopeRaw ? (scopeRaw as CaptureRequest['scope']) : undefined,
      scopeKey: asString(body.scopeKey),
      sessionId: asString(body.sessionId) ?? null,
      channel: channelRaw ? (channelRaw as NoteChannel) : undefined,
    });
    if (result.ok) return reply.status(201).send({ note: result.note });
    return reply.status(422).send({ error: 'title_conflict', existingId: result.existingId });
  });

  // ── edit ──────────────────────────────────────────────────────────

  app.put('/api/notes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const expectedVersion =
      typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined;

    const scopeRaw = asString(body.scope);
    if (scopeRaw && !isNoteScope(scopeRaw)) {
      return reply.status(400).send({ error: 'invalid scope', allowed: NOTE_SCOPES });
    }
    const title = asString(body.title);
    if (title !== undefined && title.trim().length === 0) {
      return reply.status(400).send({ error: 'title cannot be empty' });
    }
    if (title !== undefined && title.trim().length > MAX_TITLE_CHARS) {
      return reply.status(400).send({ error: `title exceeds ${MAX_TITLE_CHARS} characters` });
    }

    const result = service.update(id, {
      title: title?.trim(),
      summary: asString(body.summary)?.slice(0, MAX_SUMMARY_CHARS),
      body: asString(body.body),
      fields: parseFields(body.fields),
      tags: parseTags(body.tags),
      scope: scopeRaw ? (scopeRaw as CaptureRequest['scope']) : undefined,
      scopeKey: asString(body.scopeKey),
      expectedVersion,
    });

    if (result.ok) return reply.send({ note: result.note });
    switch (result.code) {
      case 'not_found':
        return reply.status(404).send({ error: 'not found' });
      case 'title_conflict':
        return reply.status(422).send({ error: 'title_conflict', existingId: result.existingId });
      case 'invalid_scope':
        // `project` / `channel` / `session` need to say *which* one. A body that sends
        // only the scope asked for a note nothing can read back, so it is a caller
        // error, not a conflict.
        return reply.status(400).send({
          error: 'invalid_scope',
          detail: 'scope requires a scopeKey (or the note keeps the key it has)',
        });
      default:
        // Both version codes are a 409 with the same remedy: re-read, re-merge.
        return reply.status(409).send({
          error: result.code,
          currentVersion: result.currentVersion,
          currentBody: result.currentBody,
        });
    }
  });

  // ── review ────────────────────────────────────────────────────────

  app.post('/api/notes/:id/review', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const decision = asString(body.decision);
    if (decision !== 'approve' && decision !== 'reject') {
      return reply.status(400).send({ error: 'decision must be approve or reject' });
    }
    const reasonRaw = asString(body.reason);
    if (reasonRaw && !isNoteRejectionCode(reasonRaw)) {
      return reply.status(400).send({ error: 'invalid reason', allowed: NOTE_REJECTION_CODES });
    }
    const result = service.review(id, {
      decision,
      reason: reasonRaw ? (reasonRaw as NoteRejectionCode) : undefined,
      actor: 'user',
    });
    /*
     * Two shapes of success, because the two verdicts leave different states behind.
     * `approve` answers with the promoted note; `reject` answers with the id it
     * erased, and the caller drops that row instead of rewriting it — a rejected
     * draft's body, evidence and index row are gone, and only its `reject` event
     * survives so the approval tally still knows a verdict was given.
     */
    if (result.ok) {
      return reply.send(result.deleted ? { deleted: true, id: result.id } : { note: result.note });
    }
    // Approving a draft whose title an active note already owns is 422 with the
    // owner's id: the reviewer can open it, retitle, or discard. 409 would say the
    // request was fine but the state was not, and the state is exactly the point.
    if (result.code === 'title_conflict') {
      return reply.status(422).send({ error: 'title_conflict', existingId: result.existingId });
    }
    return reply.status(404).send({ error: 'not found' });
  });

  // ── pin / archive / restore ───────────────────────────────────────

  app.post('/api/notes/:id/pin', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const result = service.pin(id, body.pinned !== false);
    if (result.ok) return reply.send({ note: result.note });
    return reply.status(404).send({ error: 'not found' });
  });

  /**
   * `DELETE /api/notes/:id` is two sentences under one verb, decided by the row.
   *
   * For a note it archives: the body stays, `status_reason` records why, and `restore`
   * brings it back. For a *draft* it erases — there is no archive a refused draft could
   * wait in without becoming a row that `restore` publishes unreviewed, so the delete
   * is the discard (`reject` with `other`). Both answer 200; the response says which
   * happened by carrying either `note` or `deleted`.
   */
  app.delete('/api/notes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = service.archive(id, 'user');
    if (result.ok) {
      return reply.send(result.note ? { note: result.note } : { deleted: true, id });
    }
    return reply.status(404).send({ error: 'not found' });
  });

  app.post('/api/notes/:id/restore', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = service.restore(id);
    if (result.ok) return reply.send({ note: result.note });
    // Restoring into a title that was reused while it was archived hits the same
    // unique index as approval, so it answers the same way.
    if (result.code === 'title_conflict') {
      return reply.status(422).send({ error: 'title_conflict', existingId: result.existingId });
    }
    return reply.status(404).send({ error: 'not found' });
  });

  /**
   * Physical erase — the one `DELETE` here that really deletes.
   *
   * Separate from `DELETE /api/notes/:id` because the two are different promises:
   * that one archives (reversible, keeps the body), this one removes the row, its
   * citations, its relations, its journal and its index entry, and cannot be undone.
   * Hence the body: the caller repeats the title, and `service.purge` compares it
   * through the library's own normalisation key. A missing title is a mismatch, not a
   * 400 — the guard is "did you retype it", and an absent value answers that already.
   */
  app.delete('/api/notes/:id/purge', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const title = asString(body.title);
    if (!title) return reply.status(422).send({ error: 'title_mismatch' });

    const result = service.purge(id, { title, actor: 'user' });
    if (result.ok) return reply.send({ purged: true });
    switch (result.code) {
      case 'not_found':
        return reply.status(404).send({ error: 'not_found' });
      case 'not_archived':
        return reply.status(409).send({ error: 'not_archived' });
      default:
        return reply.status(422).send({ error: 'title_mismatch' });
    }
  });
}
