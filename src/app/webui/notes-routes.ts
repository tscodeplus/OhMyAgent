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
 *   400 — caller error: unknown status/kind/scope, un-parsable body, an empty
 *         title on a manual note, a `capture` without a session or with a mode
 *         that cannot produce a window.
 *   404 — the note does not exist. `GET /api/notes/:id` is the only read that
 *         can answer it: `list` returns an empty array.
 *   409 — optimistic-concurrency conflict: `expectedVersion` was missing or
 *         stale. The body carries `currentVersion` and `currentBody` so the
 *         editor can show a diff instead of throwing the user's text away.
 *   422 — the layer decided not to write: capture produced nothing usable
 *         (`no_notes`, `invalid`, `empty_window`), or the title already exists.
 *   503 — the model chain failed (`model_failed`); a retry may work.
 *
 * `scope` is a filter here, never a permission:
 * reads without a scope context show the whole library, because a human at the
 * console is looking at their own notes.
 */

import type { FastifyInstance } from 'fastify';
import {
  NOTE_CHANNELS,
  NOTE_KINDS,
  NOTE_SCOPES,
  NOTE_REJECTION_CODES,
  NOTE_STATUSES,
  isCaptureMode,
  isNoteChannel,
  isNoteKind,
  isNoteOrigin,
  isNoteScope,
  isNoteRejectionCode,
  isNoteStatus,
  type NoteChannel,
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
const MAX_TEXT_CHARS = 4000;

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
    const kindRaw = asString(query.kind);
    if (kindRaw && !isNoteKind(kindRaw)) {
      return reply.status(400).send({ error: 'invalid kind', allowed: NOTE_KINDS });
    }
    const originRaw = asString(query.origin);
    if (originRaw && originRaw !== 'user' && originRaw !== 'agent') {
      return reply.status(400).send({ error: 'invalid origin', allowed: ['user', 'agent'] });
    }
    const channelRaw = asString(query.channel);
    if (channelRaw && !isNoteChannel(channelRaw)) {
      return reply.status(400).send({ error: 'invalid channel', allowed: NOTE_CHANNELS });
    }

    const listQuery: NoteListQuery = {
      status: statusRaw,
      kind: kindRaw ? (kindRaw as NoteListQuery['kind']) : undefined,
      origin: isNoteOrigin(originRaw) ? originRaw : undefined,
      channel: channelRaw ? (channelRaw as NoteListQuery['channel']) : undefined,
      projectId: asString(query.projectId),
      tag: asString(query.tag),
      q: asString(query.q),
      context: parseScopeContext(query),
      limit: parseLimit(query.limit),
      offset: parseOffset(query.offset),
    };

    return reply.send(service.list(listQuery));
  });

  app.get('/api/notes/stats', async (_request, reply) => reply.send(service.stats()));

  /**
   * Starts the "keep just this sentence" dialog with the last thing the user said
   * (§7.1). A `GET` because it reads: no capture run, no model call, no row.
   *
   * An unknown session and a session with no user message answer identically —
   * empty text — because the dialog treats both the same way: an empty box the
   * user can type into.
   */
  app.get('/api/notes/prefill', async (request, reply) => {
    const sessionId = asString((request.query as Record<string, unknown>).sessionId);
    if (!sessionId) return reply.status(400).send({ error: 'sessionId is required' });
    return reply.send({ text: service.prefill(sessionId) ?? '' });
  });

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
    const kindRaw = asString(body.kind);
    if (kindRaw && !isNoteKind(kindRaw)) {
      return reply.status(400).send({ error: 'invalid kind', allowed: NOTE_KINDS });
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

    const captureRequest: CaptureRequest = {
      sessionId,
      mode: modeRaw,
      messageIds,
      text: text?.slice(0, MAX_TEXT_CHARS),
      kind: kindRaw ? (kindRaw as CaptureRequest['kind']) : undefined,
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
    const kindRaw = asString(body.kind);
    if (kindRaw && !isNoteKind(kindRaw)) {
      return reply.status(400).send({ error: 'invalid kind', allowed: NOTE_KINDS });
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
      kind: kindRaw ? (kindRaw as CaptureRequest['kind']) : undefined,
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

    const kindRaw = asString(body.kind);
    if (kindRaw && !isNoteKind(kindRaw)) {
      return reply.status(400).send({ error: 'invalid kind', allowed: NOTE_KINDS });
    }
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
      kind: kindRaw ? (kindRaw as NoteListQuery['kind']) : undefined,
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
    if (result.ok) return reply.send({ note: result.note });
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
   * Archive, not delete: the row keeps its body and gains a reason (plan §6).
   * A `DELETE` that removed the row would also remove the history of the review.
   */
  app.delete('/api/notes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = service.archive(id, 'user');
    if (result.ok) return reply.send({ note: result.note });
    return reply.status(404).send({ error: 'not found' });
  });

  app.post('/api/notes/:id/restore', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = service.restore(id);
    if (result.ok) return reply.send({ note: result.note });
    return reply.status(404).send({ error: 'not found' });
  });
}
